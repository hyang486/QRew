// Run: npm test. Gap cues while stopped and the catch-up pace cap (qa stop-leg bug on main eeeafd9).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chooseCue,
  gapCue,
  newCueSchedule,
  newTracker,
  recentPace,
  spokenCue,
  standingStill,
  stepFixes,
} from '../src/features/pace/pace-core.ts';

const at = (m, atMs, accuracyM = 5) => ({ latitude: 37 + m / 111_195, longitude: -122, atMs, accuracyM });
const runners = (myM, leadM, speedMps = 10 / 3) => [
  { userId: 'me', progressM: myM, speedMps: 0 },
  { userId: 'lead', progressM: leadM, speedMps },
];

test('a fix jumping 34 m back and forth while standing gives a recent pace, but counts as standing still', () => {
  const run = Array.from({ length: 37 }, (_, i) => at((600 * i) / 36, i * 5_000));
  const wobble = Array.from({ length: 8 }, (_, i) => at(600 + (i % 2 ? 0 : 34), 180_000 + (i + 1) * 30_000));
  const t = stepFixes(newTracker('r', 0), [...run, ...wobble]).tracker;
  assert.notEqual(recentPace(t, t.seenAtMs), null, 'the wobble reads as movement (why 227e748 was not enough)');
  assert.equal(standingStill(wobble, t.seenAtMs), true);
  assert.equal(standingStill(run, 180_000), false, 'running is not standing');
  assert.equal(standingStill(wobble.slice(-1), t.seenAtMs), false, 'one fix is not enough to tell');
});

test('stopped keeps gap and off-target cues quiet, km cues still come', () => {
  const input = { nowMs: 600_000, km: 0, lastSplitS: null, recentSecPerKm: 600, targetSecPerKm: 300 };
  const gap = gapCue('me', runners(600, 1000), 300);
  assert.equal(chooseCue(newCueSchedule(), { ...input, gap, stopped: true }).cue, null);
  assert.equal(chooseCue(newCueSchedule(), { ...input, gap: null, stopped: true }).cue, null, 'no "Pick it up" while stopped');
  assert.equal(chooseCue(newCueSchedule(), { ...input, gap, stopped: false }).cue?.kind, 'gap');
  assert.equal(chooseCue(newCueSchedule(), { ...input, km: 1, lastSplitS: 300, gap, stopped: true }).cue?.kind, 'km');
});

test('catch-up pace faster than 70% of target (or 3:00 per km with no target) says keep your pace', () => {
  // 200 m behind at 3.33 m/s: 3:45 per km, slower than 0.7 x 5:00 = 3:30.
  assert.equal(gapCue('me', runners(0, 200), 300)?.pace, '3:45');
  // 774 m behind (qa's case): 2:11 per km becomes keep your pace.
  const far = gapCue('me', runners(0, 774), 300);
  assert.equal(far?.pace, null);
  assert.equal(far?.gapM, 774);
  assert.equal(spokenCue({ kind: 'gap', ...far }), 'Lead group 774 meters ahead. Too far to catch in 3 minutes: keep your pace.');
  // A slow target (8:00): 3:45 is faster than 0.7 x 8:00 = 5:36.
  assert.equal(gapCue('me', runners(0, 200), 480)?.pace, null);
  // No target: the 3:00 per km floor.
  assert.equal(gapCue('me', runners(0, 200), null)?.pace, '3:45');
  assert.equal(gapCue('me', runners(0, 774), null)?.pace, null);
});
