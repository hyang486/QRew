// Run: node --test supabase/functions/room-janitor/janitor.test.ts   (offline)
import assert from 'node:assert/strict';
import test from 'node:test';

import { runJanitor, type CleanupJob, type JanitorStore, type StoredObject } from './core.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

function makeStore(init: { objects: Record<string, StoredObject[]>; jobs: CleanupJob[]; active?: string[]; failRemove?: boolean }) {
  const objs: Record<string, StoredObject[]> = structuredClone(init.objects);
  const finished: Record<string, { verifiedEmpty: boolean; error: string | null }> = {};
  const under = (b: string, p: string) => (objs[b] ?? []).filter((o) => (p.endsWith('/') ? o.name.startsWith(p) : o.name === p));
  const store: JanitorStore & { objs: typeof objs; finished: typeof finished } = {
    objs, finished,
    deleteExpiredRooms: async () => ['room1'],
    claimCleanupJobs: async () => init.jobs,
    listObjects: async (b, p) => under(b, p),
    removeObjects: async (b, names) => {
      if (init.failRemove) throw new Error('boom secret/path');
      objs[b] = (objs[b] ?? []).filter((o) => !names.includes(o.name));
    },
    finishCleanup: async (id, r) => { finished[id] = r; },
    activeFaceRefPaths: async () => new Set(init.active ?? []),
    listAllObjects: async (b) => objs[b] ?? [],
  };
  return store;
}
const o = (name: string, minAgo: number): StoredObject => ({ name, createdAt: iso(minAgo) });
const job = (id: string, bucket: string, prefix: string, minAgo: number): CleanupJob => ({ id, bucket, prefix, created_at: iso(minAgo), attempts: 0 });

test('room_deleted prefix removes everything in room-media and verifies empty', async () => {
  const store = makeStore({ objects: { 'room-media': [o('r1/a.jpg', 100), o('r1/b.mp4', 90), o('r2/keep.jpg', 90)] }, jobs: [job('j', 'room-media', 'r1/', 5)] });
  const s = await runJanitor(store, { now: NOW, roomLimit: 10, jobLimit: 10 });
  assert.deepEqual(store.objs['room-media'].map((x) => x.name), ['r2/keep.jpg']);
  assert.equal(s.jobsVerified, 1);
  assert.deepEqual(s.jobs[0], { prefix: 'r1/', bucket: 'room-media', before: 2, removed: 2, after: 0, verified: true });
  assert.equal(store.finished.j.verifiedEmpty, true);
  assert.equal(s.roomsDeleted, 1);
});

test('re-enroll: exact old ref is removed, the new ref survives', async () => {
  const store = makeStore({
    objects: { 'face-refs': [o('r/u/ref-old.jpg', 30), o('r/u/ref-new.jpg', 10)] },
    jobs: [job('j', 'face-refs', 'r/u/ref-old.jpg', 5)],
    active: ['r/u/ref-new.jpg'],
  });
  await runJanitor(store, { now: NOW, roomLimit: 1, jobLimit: 10 });
  assert.deepEqual(store.objs['face-refs'].map((x) => x.name), ['r/u/ref-new.jpg']);
  assert.equal(store.finished.j.verifiedEmpty, true);
});

test('leave: prefix job removes refs older than the job but spares a ref uploaded after it (rejoin + re-enroll)', async () => {
  const store = makeStore({
    objects: { 'face-refs': [o('r/u/ref-a.jpg', 120), o('r/u/ref-b.jpg', 1)] },
    jobs: [job('j', 'face-refs', 'r/u/', 30)],
    active: ['r/u/ref-b.jpg'],
  });
  const s = await runJanitor(store, { now: NOW, roomLimit: 1, jobLimit: 10 });
  assert.deepEqual(store.objs['face-refs'].map((x) => x.name), ['r/u/ref-b.jpg']);
  assert.equal(s.jobsVerified, 1);
});

test('storage failure keeps the job unverified and logs no error text', async () => {
  const lines: string[] = [];
  const store = makeStore({ objects: { 'room-media': [o('r1/a.jpg', 50)] }, jobs: [job('j', 'room-media', 'r1/', 5)], failRemove: true });
  const s = await runJanitor(store, { now: NOW, roomLimit: 1, jobLimit: 10, log: (e, f) => lines.push(e + JSON.stringify(f)) });
  assert.deepEqual(store.finished.j, { verifiedEmpty: false, error: 'storage_error' });
  assert.equal(s.jobsRetrying, 1);
  assert.ok(lines.every((l) => !l.includes('secret')));
});

test('orphan sweep: unreferenced face-refs older than 1h are removed, fresh uploads and active refs are kept', async () => {
  const store = makeStore({
    objects: { 'face-refs': [o('r/u/orphan-old.jpg', 90), o('r/u/fresh-upload.jpg', 10), o('r/u/active.jpg', 500)] },
    jobs: [], active: ['r/u/active.jpg'],
  });
  const s = await runJanitor(store, { now: NOW, roomLimit: 1, jobLimit: 1 });
  assert.deepEqual(store.objs['face-refs'].map((x) => x.name).sort(), ['r/u/active.jpg', 'r/u/fresh-upload.jpg']);
  assert.equal(s.orphansRemoved, 1);
});

test('J1: a job failing for the 5th time is counted stuck and logged without paths', async () => {
  const logs: string[] = [];
  const j = { ...job('js', 'room-media', 'r1/', 5), attempts: 4 };
  const store = makeStore({ objects: { 'room-media': [o('r1/a.jpg', 10)] }, jobs: [j, job('jn', 'room-media', 'r9/', 1)], failRemove: true });
  const s = await runJanitor(store, { now: NOW, roomLimit: 10, jobLimit: 10, log: (e, f) => logs.push(e + JSON.stringify(f)) });
  assert.equal(s.jobsStuck, 1);
  assert.equal(s.jobsRetrying, 1);
  assert.equal(s.jobsVerified, 1); // the newer empty job still ran in the same pass
  assert.ok(logs.some((l) => l.startsWith('cleanup_stuck')));
  assert.ok(logs.every((l) => !l.includes('r1/') && !l.includes('secret')));
});
