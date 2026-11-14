// Run: npm test (node --test, Node 24 strips the .ts types).
// Qrewing AI pace maker (spec 3.4): on-device stats, target cues, lead group and gap pace, 3-minute stationary check.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addFix,
  formatPace,
  gapCue,
  spokenCue,
  leadGroup,
  median,
  newStationaryState,
  newTracker,
  paceCue,
  progressAlongRoute,
  recentPace,
  stationaryDue,
  STATIONARY_SNOOZE_MS,
  summarize,
  targetSecPerKm,
  usualPace,
  withinStationaryRadius,
} from '../src/features/pace/pace-core.ts';

// One degree of latitude on a 6,371 km sphere.
const DEG_M = (6_371_000 * Math.PI) / 180;
/** A point `m` meters north of (0, 0). */
const north = (m, atMs, speedMps) => ({ latitude: m / DEG_M, longitude: 0, atMs, speedMps });
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// --- formatting and stats -------------------------------------------------------------------------------------

test('formatPace writes m:ss per km and rounds to the second', () => {
  assert.equal(formatPace(330), '5:30');
  assert.equal(formatPace(341.4), '5:41');
  assert.equal(formatPace(359.6), '6:00');
  assert.equal(formatPace(65), '1:05');
  assert.equal(formatPace(null), null);
  assert.equal(formatPace(Infinity), null);
});

test('median of odd and even lists; empty is null', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('usual pace is the median avg pace of the last 5 sessions, skipping ones without a pace', () => {
  const s = (avg, startedAt) => ({ roomId: 'r', startedAt, durationS: 600, distanceM: 2000, avgSecPerKm: avg, splits: [] });
  // Newest first after sorting by startedAt; the 6th-oldest (900) is outside the last 5.
  const history = [s(900, 1), s(300, 2), s(310, 3), s(null, 4), s(320, 5), s(330, 6), s(400, 7)];
  assert.equal(usualPace(history), 320); // last 5 with a pace: 400, 330, 320, 310, 300
  assert.equal(usualPace([]), null);
});

// --- session tracker ------------------------------------------------------------------------------------------

test('a steady 5:00/km run: distance, duration, average and one split per km', () => {
  // 1000 m per 300 s = 3.333 m/s; a fix every 10 s.
  let t = newTracker('room', 0);
  for (let s = 0; s <= 660; s += 10) t = addFix(t, north((s * 1000) / 300, s * 1000));
  const sum = summarize(t);
  assert.ok(near(sum.distanceM, 2200, 1));
  assert.equal(sum.durationS, 660);
  assert.ok(near(sum.avgSecPerKm, 300, 1));
  assert.equal(t.splits.length, 2);
  assert.ok(near(t.splits[0], 300, 1));
  assert.ok(near(t.splits[1], 300, 1));
});

test('a GPS jump faster than 12 m/s is dropped, not counted', () => {
  let t = newTracker('room', 0);
  t = addFix(t, north(0, 0));
  t = addFix(t, north(30, 10_000));
  t = addFix(t, north(5000, 20_000)); // 497 m/s: noise
  t = addFix(t, north(60, 30_000));
  assert.ok(near(summarize(t).distanceM, 60, 1));
});

test('a session under 100 m has no average pace', () => {
  let t = newTracker('room', 0);
  t = addFix(t, north(0, 0));
  t = addFix(t, north(50, 60_000));
  assert.equal(summarize(t).avgSecPerKm, null);
});

test('recent pace uses the distance gained over the last minute', () => {
  const t = [north(0, 0), north(100, 60_000), north(300, 120_000)].reduce(addFix, newTracker('r', 0));
  // Last 60 s: 200 m in 60 s = 300 s/km.
  assert.ok(near(recentPace(t, 120_000), 300, 1));
  // Too little movement: null.
  assert.equal(recentPace([north(0, 0), north(5, 60_000)].reduce(addFix, newTracker('r', 0)), 60_000), null);
});

// --- target and cues ------------------------------------------------------------------------------------------

test('target: usual pace, a typed pace, or a time for a distance', () => {
  assert.equal(targetSecPerKm({ kind: 'usual' }, 320), 320);
  assert.equal(targetSecPerKm({ kind: 'usual' }, null), null);
  assert.equal(targetSecPerKm({ kind: 'pace', secPerKm: 330 }, 320), 330);
  // 10 km in 50 minutes = 300 s/km.
  assert.equal(targetSecPerKm({ kind: 'time', distanceM: 10_000, timeS: 3000 }, 320), 300);
});

test('a km cue fires once at each new km, with the split pace and the target', () => {
  const cue1 = paceCue({ lastKm: 0, lastOffCueAtMs: null }, { nowMs: 300_000, km: 1, lastSplitS: 332, recentSecPerKm: 332, targetSecPerKm: 330 });
  assert.equal(cue1.cue?.kind, 'km');
  assert.equal(cue1.cue?.km, 1);
  assert.equal(cue1.cue?.pace, '5:32');
  assert.equal(cue1.cue?.target, '5:30');
  // Same km again: nothing.
  const again = paceCue(cue1.state, { nowMs: 310_000, km: 1, lastSplitS: 332, recentSecPerKm: 332, targetSecPerKm: 330 });
  assert.equal(again.cue, null);
});

test('off-target cues: more than 5% off, at most every 2 minutes; slower says pick it up, faster says ease off', () => {
  const s0 = { lastKm: 0, lastOffCueAtMs: null };
  // 5:41 vs 5:30 is 3.3% off: no cue.
  assert.equal(paceCue(s0, { nowMs: 60_000, km: 0, lastSplitS: null, recentSecPerKm: 341, targetSecPerKm: 330 }).cue, null);
  // 6:00 vs 5:30 is 9% slower.
  const slow = paceCue(s0, { nowMs: 60_000, km: 0, lastSplitS: null, recentSecPerKm: 360, targetSecPerKm: 330 });
  assert.equal(slow.cue?.kind, 'slow');
  assert.equal(slow.cue?.pace, '6:00');
  // 1 minute later still slow: no repeat.
  assert.equal(paceCue(slow.state, { nowMs: 120_000, km: 0, lastSplitS: null, recentSecPerKm: 360, targetSecPerKm: 330 }).cue, null);
  // 2 minutes later and now too fast (4:50 is 12% faster).
  const fast = paceCue(slow.state, { nowMs: 180_000, km: 0, lastSplitS: null, recentSecPerKm: 290, targetSecPerKm: 330 });
  assert.equal(fast.cue?.kind, 'fast');
  // No target: no off-target cues (km cues still fire, without a target).
  assert.equal(paceCue(s0, { nowMs: 60_000, km: 0, lastSplitS: null, recentSecPerKm: 360, targetSecPerKm: null }).cue, null);
  const kmNoTarget = paceCue(s0, { nowMs: 60_000, km: 1, lastSplitS: 360, recentSecPerKm: 360, targetSecPerKm: null });
  assert.equal(kmNoTarget.cue?.kind, 'km');
  assert.equal(kmNoTarget.cue?.target, null);
});

// --- lead group and gap ---------------------------------------------------------------------------------------

test('progress along a route projects onto the nearest segment', () => {
  // L-shaped route: 0,0 -> 1000 m north -> 1000 m north + 1000 m east.
  const route = [north(0), north(1000), { latitude: 1000 / DEG_M, longitude: 1000 / DEG_M }];
  assert.ok(near(progressAlongRoute(north(400), route), 400, 1));
  // 20 m east of the 600 m mark still projects to 600 m.
  assert.ok(near(progressAlongRoute({ latitude: 600 / DEG_M, longitude: 20 / DEG_M }, route), 600, 1));
  // On the second leg, 300 m east of the corner.
  assert.ok(near(progressAlongRoute({ latitude: 1000 / DEG_M, longitude: 300 / DEG_M }, route), 1300, 2));
});

test('lead group: members within 50 m of the front-most member', () => {
  const runners = [
    { userId: 'a', progressM: 1000, speedMps: 3.5 },
    { userId: 'b', progressM: 960, speedMps: 3.3 },
    { userId: 'c', progressM: 940, speedMps: 3.4 }, // 60 m back: not in it
    { userId: 'me', progressM: 700, speedMps: 3.0 },
  ];
  const g = leadGroup(runners);
  assert.deepEqual(g.members.sort(), ['a', 'b']);
  assert.equal(g.rearM, 960);
  assert.ok(near(g.speedMps, 3.4, 0.001));
  assert.equal(leadGroup([]), null);
});

test('gap cue: over 150 m behind, the pace that closes the gap in 3 minutes at the group speed', () => {
  const runners = [
    { userId: 'a', progressM: 1000, speedMps: 3.0 },
    { userId: 'b', progressM: 990, speedMps: 3.0 },
    { userId: 'me', progressM: 720, speedMps: 2.8 },
  ];
  const cue = gapCue('me', runners);
  // Gap to the group's rear: 270 m. Needed speed: 3.0 + 270 / 180 = 4.5 m/s = 222 s/km.
  assert.equal(cue.gapM, 270);
  assert.ok(near(cue.secPerKm, 1000 / 4.5, 0.5));
  assert.equal(cue.pace, '3:42');
  // 140 m behind: no cue. In the group: no cue. Missing from the list: no cue.
  assert.equal(gapCue('me', [...runners.slice(0, 2), { userId: 'me', progressM: 850, speedMps: 3 }]), null);
  assert.equal(gapCue('a', runners), null);
  assert.equal(gapCue('x', runners), null);
});

test('gap cue with no group speed builds on the target or my recent pace, never on the gap alone', () => {
  // qa: 161 m behind, no group speed gave 1000 / (161 / 180) = 18:38 per km, slower than everyone.
  const runners = [
    { userId: 'a', progressM: 1161, speedMps: null },
    { userId: 'me', progressM: 1000, speedMps: null },
  ];
  // Target 6:00 (2.78 m/s) + 161 / 180 = 3.67 m/s = 4:32 per km.
  const target = gapCue('me', runners, 360);
  assert.equal(target.mode, 'pace');
  assert.equal(target.pace, '4:32');
  // No target, my recent 5:00 (3.33 m/s) + 0.89 = 4.23 m/s = 3:56 per km.
  assert.equal(gapCue('me', runners, null, 300).pace, '3:57');
  // Both: the faster one is the base, so the answer is never slower than my pace.
  assert.equal(gapCue('me', runners, 330, 300).pace, '3:57');
  // Neither: no number.
  const none = gapCue('me', runners);
  assert.deepEqual(none, { gapM: 161, secPerKm: null, pace: null, mode: 'pickUp' });
  assert.equal(spokenCue({ kind: 'gap', ...none }), 'Lead group 161 meters ahead, pick up the pace.');
});

test('gap cue with a known group speed: group speed + gap / 3 minutes, never slower than me', () => {
  const runners = [
    { userId: 'a', progressM: 1161, speedMps: 2.5 },
    { userId: 'me', progressM: 1000, speedMps: null },
  ];
  // 2.5 + 0.894 = 3.39 m/s = 4:55 per km; a target does not change it (only the 70% cap).
  assert.equal(gapCue('me', runners).pace, '4:55');
  assert.equal(gapCue('me', runners, 300).pace, '4:55');
  // Already faster (4:00 = 4.17 m/s): never ask for slower than my pace.
  const fast = gapCue('me', runners, null, 240);
  assert.ok(fast.secPerKm <= 240);
  for (const t of [null, 300, 600]) for (const mine of [null, 240, 400, 900]) {
    const c = gapCue('me', runners, t, mine);
    if (c.secPerKm == null) continue;
    assert.ok(c.secPerKm < 400, 'faster than the group (400 s/km)');
    if (mine != null) assert.ok(c.secPerKm <= mine, 'not slower than me');
  }
});

// --- stationary -----------------------------------------------------------------------------------------------

test('within the stationary radius: every fix within 25 m of the centroid', () => {
  assert.equal(withinStationaryRadius([north(0), north(10), north(24)]), true);
  // 30 m apart, wandering around a point 15 m north: still standing.
  assert.equal(withinStationaryRadius([north(0), north(30), north(15), north(0), north(30)]), true);
  assert.equal(withinStationaryRadius([north(0), north(10), north(60)]), false);
});

test('3 minutes within 25 m opens the prompt once; heartbeats every 30 s are enough', () => {
  const start = 0;
  const fixes = [];
  for (let s = 0; s <= 180; s += 30) fixes.push(north(s % 60 === 0 ? 0 : 8, s * 1000));
  const st = newStationaryState();
  // At 150 s not yet 3 minutes of coverage.
  assert.equal(stationaryDue(fixes.filter((f) => f.atMs <= 150_000), 150_000, start, st), false);
  assert.equal(stationaryDue(fixes, 180_000, start, st), true);
});

test('no prompt while moving, with stale fixes, before the activity started, or while snoozed', () => {
  const moving = [];
  for (let s = 0; s <= 180; s += 30) moving.push(north(s * 3, s * 1000));
  assert.equal(stationaryDue(moving, 180_000, 0, newStationaryState()), false);

  const still = [];
  for (let s = 0; s <= 180; s += 30) still.push(north(0, s * 1000));
  // Newest fix 2 minutes old: not trusted.
  assert.equal(stationaryDue(still, 300_000, 0, newStationaryState()), false);
  // The activity started 1 minute ago: the 3 minutes count from then.
  assert.equal(stationaryDue(still, 180_000, 120_000, newStationaryState()), false);
  // Prompt open: no second prompt.
  assert.equal(stationaryDue(still, 180_000, 0, { openSinceMs: 180_000, snoozeUntilMs: null }), false);
  // Dismissed: snoozed for 10 minutes.
  assert.equal(stationaryDue(still, 180_000, 0, { openSinceMs: null, snoozeUntilMs: 180_000 + STATIONARY_SNOOZE_MS }), false);
  assert.equal(STATIONARY_SNOOZE_MS, 10 * 60_000);
});
