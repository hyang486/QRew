// Run: npm test. Arrivals are per meetup, not per activity (E2E finding c).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const plan = await import('../src/lib/info-plan.ts');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a member with rows in activity 1 and activity 2 counts once', () => {
  // listArrivedIds returns one user_id per arrivals row; mark_arrived writes a row per activity_seq.
  assert.equal(plan.arrivedMemberCount(['a', 'b', 'c'], ['a', 'b', 'a']), 2);
});

test('a restarted activity keeps earlier arrivals in the count', () => {
  const before = plan.arrivedMemberCount(['a', 'b'], ['a', 'b']); // both arrived in activity 1
  const afterRestart = plan.arrivedMemberCount(['a', 'b'], ['a', 'b']); // room-wide read, activity 2 has no rows yet
  assert.equal(before, 2);
  assert.equal(afterRestart, before);
});

test('Info and the Arrived chip read arrivals room-wide, not per activity_seq', () => {
  const rooms = read('../src/lib/rooms.ts');
  const fn = rooms.slice(rooms.indexOf('export async function listArrivedIds'), rooms.indexOf('export async function listMembers'));
  assert.match(fn, /listArrivedIds\(roomId: string\)/);
  assert.doesNotMatch(fn, /activity_seq/);
  const activity = read('../src/lib/activity.ts');
  const q = activity.slice(activity.indexOf(".from('arrivals')"), activity.indexOf(".from('emergency_events')"));
  assert.doesNotMatch(q, /activity_seq/);
  assert.match(q, /order\('arrived_at', \{ ascending: true \}\)/);
  assert.match(read('../src/app/room/[id]/info.tsx'), /listArrivedIds\(id\)/);
});
