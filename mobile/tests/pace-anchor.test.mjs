// Run: npm test. Pace maker lead-group anchor without a route or place pin (spec 3.4): progress is measured from
// where my session started, not from where I was a few minutes ago.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { breakTracker, gapCue, newTracker, progressOf, stepFixes } from '../src/features/pace/pace-core.ts';

const at = (m, atMs, accuracyM = 5) => ({ latitude: 37 + m / 111_195, longitude: -122, atMs, accuracyM });
const point = (m) => ({ latitude: 37 + m / 111_195, longitude: -122 });

test('the start point survives a long run and a break', () => {
  // 3 km north at 4 m/s, a fix every 10 s (well past the engine's 6-minute fix window).
  const fixes = Array.from({ length: 76 }, (_, i) => at(i * 40, i * 10_000));
  let t = stepFixes(newTracker('r', 0), fixes).tracker;
  assert.ok(t.distanceM > 2900);
  assert.deepEqual(t.firstPoint, point(0));
  t = breakTracker(t);
  t = stepFixes(t, [at(5000, 2_000_000)]).tracker;
  assert.deepEqual(t.firstPoint, point(0));
});

test('a wrong first fix replaced by re-anchoring moves the start point', () => {
  // First fix 2 km off, then three agreeing fixes back home: re-anchored with no distance.
  const t = stepFixes(newTracker('r', 0), [at(2000, 0), at(0, 1_000), at(5, 2_000), at(10, 3_000)]).tracker;
  assert.equal(t.distanceM, 0);
  assert.deepEqual(t.firstPoint, point(10));
});

test('no false lead group from a member far behind me', () => {
  // I am 3 km from the start; a straggler is 500 m behind the start line (3.5 km behind me).
  const runners = (anchor) =>
    [
      ['me', point(3000)],
      ['s', point(-500)],
    ].map(([userId, p]) => ({ userId, progressM: progressOf(p, [], anchor), speedMps: 3 }));
  assert.equal(gapCue('me', runners(point(0))), null);
  // The old anchor (my position 6 minutes ago, 1.5 km behind me) made the straggler the lead group.
  assert.notEqual(gapCue('me', runners(point(1500))), null);
});
