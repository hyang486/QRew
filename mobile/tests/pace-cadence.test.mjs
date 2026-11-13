// Run: npm test. Voice-cue cadence (queue item 3): at most one pace cue per km or per 2 minutes, gap cues on their
// own 2-minute clock, never two cues within 20 s (km cues wait instead of overlapping), one utterance at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseCue, MIN_CUE_GAP_MS, newCueSchedule, OFF_TARGET_EVERY_MS } from '../src/features/pace/pace-core.ts';
import { enqueue, finish, newSpeechQueue, speechBudgetMs } from '../src/features/pace/speech-queue.ts';

const GAP = { gapM: 300, secPerKm: 240, pace: '4:00' };
const input = (s, over = {}) => ({
  nowMs: s * 1000,
  km: 0,
  lastSplitS: null,
  recentSecPerKm: 300,
  targetSecPerKm: 300,
  gap: null,
  ...over,
});

/** Runs fixes every `stepS` seconds from `fromS` to `toS`; `at(s)` gives each fix's input overrides. */
function drive(schedule, fromS, toS, stepS, at) {
  const cues = [];
  for (let s = fromS; s <= toS; s += stepS) {
    const r = chooseCue(schedule, input(s, at(s)));
    schedule = r.schedule;
    if (r.cue) cues.push({ s, ...r.cue });
  }
  return { schedule, cues };
}

test('a km cue in the quiet window waits and comes on the first fix after it, with the latest split', () => {
  // A gap cue at 290 s; km 1 is reached at 300 s.
  let r = chooseCue(newCueSchedule(), input(290, { gap: GAP }));
  assert.equal(r.cue.kind, 'gap');
  const held = chooseCue(r.schedule, input(300, { km: 1, lastSplitS: 300 }));
  assert.equal(held.cue, null);
  assert.equal(held.schedule.pace.lastKm, 0, 'km 1 is still due');
  r = chooseCue(held.schedule, input(305, { km: 1, lastSplitS: 300 }));
  assert.equal(r.cue, null, 'still inside 20 s');
  r = chooseCue(r.schedule, input(310, { km: 1, lastSplitS: 302 }));
  assert.deepEqual(r.cue, { kind: 'km', km: 1, pace: '5:02', target: '5:00' });
  assert.equal(r.schedule.pace.lastKm, 1);
  assert.equal(chooseCue(r.schedule, input(340, { km: 1, lastSplitS: 302 })).cue, null, 'said once');
});

test('no two cues within 20 s, whatever is due', () => {
  // Behind the lead group and slow for 15 minutes, crossing km marks: every cue kind is due somewhere.
  const { cues } = drive(newCueSchedule(), 0, 900, 2, (s) => ({
    km: Math.floor(s / 330),
    lastSplitS: 330,
    recentSecPerKm: 330,
    gap: s < 400 ? GAP : null,
  }));
  assert.ok(cues.length >= 4);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].s - cues[i - 1].s >= MIN_CUE_GAP_MS / 1000, JSON.stringify(cues));
});

test('off-target cues: at most one per 2 minutes, and a km cue restarts that clock', () => {
  const { cues } = drive(newCueSchedule(), 0, 600, 2, (s) => ({
    km: s >= 330 ? 1 : 0,
    lastSplitS: 330,
    recentSecPerKm: 360,
  }));
  const kinds = cues.map((c) => `${c.kind}@${c.s}`);
  assert.deepEqual(kinds, ['slow@0', 'slow@120', 'slow@240', 'km@330', 'slow@450', 'slow@570'], kinds.join(' '));
});

test('gap cues keep their own 2-minute clock and hold off-target cues while behind', () => {
  const { cues } = drive(newCueSchedule(), 0, 400, 2, (s) => ({ recentSecPerKm: 400, gap: s <= 250 ? GAP : null }));
  const kinds = cues.map((c) => `${c.kind}@${c.s}`);
  // While behind: gap at 0, 120, 240; no "pick it up". Back within the group at 252: the off-target clock was never
  // used, so "pick it up" comes at once (20 s after the last gap cue), then every 2 minutes.
  assert.deepEqual(kinds, ['gap@0', 'gap@120', 'gap@240', 'slow@260', 'slow@380'], kinds.join(' '));
  assert.ok(OFF_TARGET_EVERY_MS === 120_000);
});

test('a stationary prompt (lastCueAtMs set outside) also holds the next cue for 20 s', () => {
  const s = { ...newCueSchedule(), lastCueAtMs: 100_000 };
  assert.equal(chooseCue(s, input(110, { km: 1, lastSplitS: 300 })).cue, null);
  assert.equal(chooseCue(s, input(120, { km: 1, lastSplitS: 300 })).cue.kind, 'km');
});

// --- speech queue -----------------------------------------------------------------------------------------------

test('one utterance at a time: a cue during speech waits for the end, then is said', () => {
  let r = enqueue(newSpeechQueue(), { id: '1', text: 'Kilometer 1: 5:00 per km.' }, 0);
  assert.equal(r.say.id, '1');
  r = enqueue(r.queue, { id: '2', text: 'Pick it up: 5:30 per km, target 5:00.' }, 1000);
  assert.equal(r.say, null);
  assert.equal(r.queue.pending.id, '2');
  r = finish(r.queue, '1', 2500);
  assert.equal(r.say.id, '2');
  assert.equal(r.queue.speaking.id, '2');
  r = finish(r.queue, '2', 5000);
  assert.equal(r.say, null);
  assert.deepEqual(r.queue, newSpeechQueue());
});

test('only the newest waiting cue is kept; an end event for another id changes nothing', () => {
  let r = enqueue(newSpeechQueue(), { id: '1', text: 'a' }, 0);
  r = enqueue(r.queue, { id: '2', text: 'b' }, 100);
  r = enqueue(r.queue, { id: '3', text: 'c' }, 200);
  assert.equal(r.queue.pending.id, '3');
  const stale = finish(r.queue, '2', 300);
  assert.equal(stale.say, null);
  assert.equal(stale.queue, r.queue);
  assert.equal(finish(r.queue, '1', 400).say.id, '3');
});

test('no end event: once the time budget is over, the next cue is said at once', () => {
  const text = 'Lead group 300 meters ahead. Run 4:00 per km to catch them in 3 minutes.';
  const budget = speechBudgetMs(text);
  assert.ok(budget > 5000 && budget <= 20_000);
  let r = enqueue(newSpeechQueue(), { id: '1', text }, 0);
  assert.equal(enqueue(r.queue, { id: '2', text: 'x' }, budget - 1).say, null);
  r = enqueue(r.queue, { id: '2', text: 'x' }, budget);
  assert.equal(r.say.id, '2');
  assert.equal(speechBudgetMs('x'.repeat(1000)), 20_000);
});
