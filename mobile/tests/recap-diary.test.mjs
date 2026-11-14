// Run: npm test. s24 (2026-11-13): a Plus member's recap arrived through a path that never asked for the diary
// (room_recaps notice, a done shared row read in grace, or the ended-room ask), so the calendar said
// "No recap was saved". Every saved recap now asks for the diary once in the background when the calendar wants one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { askDiaryOnce } from '../src/features/recap/recap-plan.ts';

const deps = (over = {}) => {
  const calls = { request: 0, saved: [] };
  return {
    calls,
    d: {
      wants: async () => true,
      request: async () => {
        calls.request++;
        return { state: 'done', emoji: '☕', diary: ['We met.'] };
      },
      save: async (r) => {
        calls.saved.push(r);
      },
      ...over,
    },
  };
};

test('a wanted diary is asked for once and saved to the calendar', async () => {
  const { calls, d } = deps();
  await askDiaryOnce('r1', d, new Set());
  assert.equal(calls.request, 1);
  assert.deepEqual(calls.saved, [{ emoji: '☕', diary: ['We met.'] }]);
});

test('no Plus or a diary already saved: no call', async () => {
  const { calls, d } = deps({ wants: async () => false });
  await askDiaryOnce('r1', d, new Set());
  assert.equal(calls.request, 0);
});

test('two saves at once make one diary call', async () => {
  const { calls, d } = deps();
  const inFlight = new Set();
  await Promise.all([askDiaryOnce('r1', d, inFlight), askDiaryOnce('r1', d, inFlight)]);
  assert.equal(calls.request, 1);
  assert.equal(inFlight.size, 0);
});

test('errors, pending, no emoji and throws are swallowed and save nothing', async () => {
  for (const request of [
    async () => ({ error: 'not_member' }),
    async () => ({ state: 'pending' }),
    async () => ({ state: 'done', emoji: null, diary: null }),
    async () => {
      throw new Error('offline');
    },
  ]) {
    const { calls, d } = deps({ request });
    await askDiaryOnce('r1', d, new Set());
    assert.deepEqual(calls.saved, []);
  }
  const { d } = deps({ wants: async () => Promise.reject(new Error('x')) });
  await askDiaryOnce('r1', d, new Set());
});

test('every recap save path reaches the diary follow-up (save() calls it unless the call already asked)', () => {
  const src = readFileSync(new URL('../src/features/recap/recap-store.ts', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('async function save('), src.indexOf('export async function fetchAndSaveRecap'));
  assert.match(save, /askDiaryOnce\(/);
  // The three paths that never sent diary:true all save through save().
  for (const fn of ['readAndSaveRecap', 'recapForEndedRoom', 'askRecap']) {
    const start = src.indexOf(`function ${fn}(`);
    assert.ok(start > 0, fn);
    assert.match(src.slice(start, start + 1500), /\bsave\(roomId, userId,/, fn);
  }
  // fetchAndSaveRecap already asked, so it tells save() not to ask again.
  const fetch = src.slice(src.indexOf('export async function fetchAndSaveRecap'), src.indexOf('export async function readAndSaveRecap'));
  assert.match(fetch, /diaryAsked: diary/);
});
