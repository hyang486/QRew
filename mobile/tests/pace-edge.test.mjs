// Run: npm test. Pace maker edge cases (spec 3.4, queue item 3): GPS jumps and outliers, pauses, the screen or
// app in the background and back, and a target with no history.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  newPaceCueState,
  newStationaryState,
  newTracker,
  paceCue,
  recentPace,
  stationaryDue,
  stepFix,
  summarize,
  targetSecPerKm,
  usualPace,
} from '../src/features/pace/pace-core.ts';
import { en } from '../src/i18n/en.ts';
const paceStrings = en.pace;

const DEG_M = (6_371_000 * Math.PI) / 180;
/** A point `m` meters north of (0, 0) at `s` seconds. */
const at = (m, s) => ({ latitude: m / DEG_M, longitude: 0, atMs: s * 1000 });
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

/** Feeds fixes; returns the tracker and the fixes that were kept (what the engine passes on). */
function feed(fixes, tracker = newTracker('room', 0)) {
  const kept = [];
  for (const f of fixes) {
    const r = stepFix(tracker, f);
    tracker = r.tracker;
    if (r.kept) kept.push(f);
  }
  return { tracker, kept };
}

/** 3.333 m/s (5:00 per km), a fix every 10 s, from second `from` to `to`, starting at `fromM`. */
function run(from, to, fromM = 0) {
  const out = [];
  for (let s = from; s <= to; s += 10) out.push(at(fromM + ((s - from) * 1000) / 300, s));
  return out;
}

// --- GPS jumps and outliers -------------------------------------------------------------------------------------

test('a single GPS jump is not kept, so it reaches neither recent pace nor the stationary check', () => {
  const fixes = [...run(0, 50), at(5000, 55), ...run(60, 120, 200)];
  const { tracker, kept } = feed(fixes);
  assert.equal(kept.some((f) => f.atMs === 55_000), false);
  assert.ok(near(summarize(tracker).distanceM, 400, 2));
  // Recent pace from the kept fixes stays 5:00, not a 2-minute "ease off" from the jump.
  assert.ok(near(recentPace(tracker, 120_000), 300, 2));
});

test('a wrong first fix does not freeze the session: 3 agreeing fixes re-anchor without adding distance', () => {
  const fixes = [at(3000, 0), ...run(5, 125)];
  const { tracker, kept } = feed(fixes);
  // The first three real fixes are dropped, then the session restarts from the third with no 3 km jump.
  assert.equal(kept.length, fixes.length - 2);
  const sum = summarize(tracker);
  assert.ok(sum.distanceM < 400, `distance ${sum.distanceM}`);
  assert.ok(near(sum.avgSecPerKm, 300, 2));
});

test('scattered jumps that disagree with each other never re-anchor', () => {
  const fixes = [...run(0, 30), at(4000, 35), at(-4000, 40), at(9000, 45), ...run(50, 100, 167)];
  const { tracker } = feed(fixes);
  assert.ok(near(summarize(tracker).distanceM, 333, 3));
});

test('repeated and out-of-order fixes are not kept', () => {
  const { kept } = feed([at(0, 0), at(30, 10), at(30, 10), at(20, 5), at(60, 20)]);
  assert.deepEqual(
    kept.map((f) => f.atMs / 1000),
    [0, 10, 20],
  );
});

// --- pauses -----------------------------------------------------------------------------------------------------

test('standing still (30 s heartbeats with GPS drift) adds no distance and no moving time', () => {
  const still = [];
  for (let s = 330; s <= 630; s += 30) still.push(at(1000 + (s % 60 === 0 ? 0 : 9), s));
  const fixes = [...run(0, 300), ...still, ...run(640, 940, 1000)];
  const { tracker, kept } = feed(fixes);
  const sum = summarize(tracker);
  assert.ok(near(sum.distanceM, 2000, 15), `distance ${sum.distanceM}`);
  // 10 minutes of running; the 5-minute stop is left out of the time and the pace.
  assert.ok(near(sum.durationS, 600, 40), `moving ${sum.durationS}`);
  // The total from the first to the last fix keeps the stop: 940 s.
  assert.equal(sum.elapsedS, 940);
  assert.ok(near(sum.avgSecPerKm, 300, 20), `pace ${sum.avgSecPerKm}`);
  // The pause fixes are still kept: the stationary check needs them.
  assert.ok(still.every((f) => kept.includes(f)));
});

test('a pause inside a km does not slow its split', () => {
  const still = [];
  for (let s = 180; s <= 360; s += 30) still.push(at(500, s));
  const fixes = [...run(0, 150), ...still, ...run(370, 550, 500)];
  const { tracker } = feed(fixes);
  assert.equal(tracker.splits.length, 1);
  assert.ok(tracker.splits[0] < 340, `split ${tracker.splits[0]}`);
});

test('slow creep under 0.5 m/s is all pauses: no distance and no time (distance and time from the same fix)', () => {
  // 0.4 m/s for 300 s with a fix every 30 s: every step is 12 m in 30 s.
  const fixes = [];
  for (let s = 0; s <= 300; s += 30) fixes.push(at(s * 0.4, s));
  const sum = summarize(feed(fixes).tracker);
  assert.equal(sum.distanceM, 0);
  assert.equal(sum.durationS, 0);
});

test('a 5-minute stop after the first km, then running: the second split is still 5:00 of moving time', () => {
  const still = [];
  for (let s = 330; s <= 630; s += 30) still.push(at(1000 + (s % 60 === 0 ? 0 : 6), s));
  // Resume from where the last heartbeat put me, 5:00 per km.
  const fixes = [...run(0, 300), ...still, ...run(640, 960, 1000)];
  const { tracker } = feed(fixes);
  assert.equal(tracker.splits.length, 2);
  assert.ok(near(tracker.splits[0], 300, 1), `split 1 ${tracker.splits[0]}`);
  assert.ok(near(tracker.splits[1], 300, 12), `split 2 ${tracker.splits[1]}`);
});

test('a 3-minute stop during the activity still opens the stationary prompt from kept fixes', () => {
  const still = [];
  for (let s = 330; s <= 510; s += 30) still.push(at(1000 + (s % 60 === 0 ? 0 : 8), s));
  const { kept } = feed([...run(0, 300), ...still]);
  assert.equal(stationaryDue(kept, 510_000, 0, newStationaryState()), true);
});

// --- background and foreground ----------------------------------------------------------------------------------

test('back from the background after running: the gap counts as a straight line at the real time', () => {
  // Ran 5:00 per km, closed the screen for 10 minutes while running on, then came back.
  const fixes = [...run(0, 300), ...run(900, 1200, 3000)];
  const sum = summarize(feed(fixes).tracker);
  assert.ok(near(sum.distanceM, 4000, 2));
  assert.ok(near(sum.durationS, 1200, 1));
  assert.ok(near(sum.avgSecPerKm, 300, 1));
});

test('back from the background after standing still: no distance, no moving time, no 12 m/s rejection', () => {
  const fixes = [...run(0, 300), at(1010, 900), ...run(910, 1210, 1010)];
  const { tracker, kept } = feed(fixes);
  assert.ok(kept.some((f) => f.atMs === 900_000));
  const sum = summarize(tracker);
  // 300 s before and 300 s after; the 600 s gap is left out. The 10 m drift is within the noise floor, so it is
  // counted with the first step out (a few metres and seconds); the last fixes may still be within noise.
  assert.ok(near(sum.durationS, 600, 5), `moving ${sum.durationS} s`);
  assert.ok(near(sum.distanceM, 2000, 15), `${sum.distanceM} m`);
});

test('back from the background: the gap is not read as 3 minutes standing still', () => {
  const kept = feed([...run(0, 120), at(400, 400), at(405, 410)]).kept;
  assert.equal(stationaryDue(kept, 410_000, 0, newStationaryState()), false);
});

test('back from the background: recent pace ignores fixes from before the gap', () => {
  const { tracker } = feed([...run(0, 300), ...run(900, 920, 3000)]);
  assert.ok(near(recentPace(tracker, 920_000), 300, 2));
  // One fresh fix only: no recent pace yet, so no off-target cue on return.
  assert.equal(recentPace(feed([...run(0, 300), at(3000, 900)]).tracker, 900_000), null);
});

test('back from the background past several km: one km cue for the latest km, not one per km', () => {
  const t = feed([...run(0, 300), ...run(900, 1200, 3000)]).tracker;
  let state = newPaceCueState();
  const r = paceCue(state, {
    nowMs: 1_200_000,
    km: Math.floor(t.distanceM / 1000),
    lastSplitS: t.splits[t.splits.length - 1],
    recentSecPerKm: 300,
    targetSecPerKm: 300,
  });
  assert.equal(r.cue.kind, 'km');
  assert.equal(r.cue.km, 4);
  state = r.state;
  assert.equal(paceCue(state, { nowMs: 1_210_000, km: 4, lastSplitS: 300, recentSecPerKm: 300, targetSecPerKm: 300 }).cue, null);
});

// --- a target with no history -----------------------------------------------------------------------------------

test('no history: the usual-pace target is empty, km cues say no target, and there is no off-target cue', () => {
  assert.equal(usualPace([]), null);
  const noPace = { roomId: 'r', startedAt: 1, durationS: 30, distanceM: 50, avgSecPerKm: null, splits: [] };
  assert.equal(usualPace([noPace]), null);
  const goal = targetSecPerKm({ kind: 'usual' }, usualPace([]));
  assert.equal(goal, null);

  const km = paceCue(newPaceCueState(), { nowMs: 300_000, km: 1, lastSplitS: 300, recentSecPerKm: 300, targetSecPerKm: goal });
  assert.deepEqual(km.cue, { kind: 'km', km: 1, pace: '5:00', target: null });
  assert.equal(paceStrings.cueKm(1, '5:00', null), 'Kilometer 1: 5:00 per km.');

  const off = paceCue(km.state, { nowMs: 900_000, km: 1, lastSplitS: 300, recentSecPerKm: 200, targetSecPerKm: goal });
  assert.equal(off.cue, null);
  assert.equal(paceStrings.targetUsual(null), 'My usual pace (no runs yet)');
});

test('the first session saved becomes the usual pace for the next run', () => {
  const sum = summarize(feed(run(0, 600)).tracker);
  assert.ok(near(targetSecPerKm({ kind: 'usual' }, usualPace([sum])), 300, 1));
});

test('a typed target works with no history', () => {
  assert.equal(targetSecPerKm({ kind: 'pace', secPerKm: 330 }, null), 330);
  assert.equal(targetSecPerKm({ kind: 'time', distanceM: 10_000, timeS: 3000 }, null), 300);
  assert.equal(targetSecPerKm({ kind: 'time', distanceM: 0, timeS: 3000 }, null), null);
});
