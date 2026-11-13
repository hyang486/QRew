// Run: npm test. Spoken cue wording (pace-core spokenCue): words for speech, no m:ss and no "km".
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPace, spokenCue, spokenDistance, spokenDuration } from '../src/features/pace/pace-core.ts';

test('spokenDuration: 0 s, 59 s, whole minutes, singular and plural, hours', () => {
  const table = [
    [0, '0 seconds'],
    [1, '1 second'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [61, '1 minute 1 second'],
    [300, '5 minutes'],
    [302, '5 minutes 2 seconds'],
    [330, '5 minutes 30 seconds'],
    [599.6, '10 minutes'],
    [3600, '1 hour'],
    [3725, '1 hour 2 minutes 5 seconds'],
    [-3, '0 seconds'],
  ];
  for (const [s, want] of table) assert.equal(spokenDuration(s), want, `${s} s`);
});

test('spokenDistance: meters under 1 km, then kilometers to one decimal, singular and plural, 10+ km', () => {
  const table = [
    [0, '0 meters'],
    [1, '1 meter'],
    [150, '150 meters'],
    [999, '999 meters'],
    [1000, '1 kilometer'],
    [1040, '1 kilometer'],
    [1200, '1.2 kilometers'],
    [2400, '2.4 kilometers'],
    [10_000, '10 kilometers'],
    [12_345, '12.3 kilometers'],
  ];
  for (const [m, want] of table) assert.equal(spokenDistance(m), want, `${m} m`);
});

test('spokenCue: every cue kind in words, no m:ss and no "km"', () => {
  const table = [
    [{ kind: 'km', km: 1, pace: '5:02', target: '5:30' }, '1 kilometer, split 5 minutes 2 seconds, target 5 minutes 30 seconds.'],
    [{ kind: 'km', km: 2, pace: '5:00', target: null }, '2 kilometers, split 5 minutes.'],
    [{ kind: 'km', km: 12, pace: null, target: null }, '12 kilometers.'],
    [{ kind: 'slow', pace: '5:45', target: '5:30' }, 'Pick it up: 5 minutes 45 seconds per kilometer, target 5 minutes 30 seconds.'],
    [{ kind: 'fast', pace: '4:59', target: '5:00' }, 'Ease off: 4 minutes 59 seconds per kilometer, target 5 minutes.'],
    [
      { kind: 'gap', gapM: 150, secPerKm: 290, pace: '4:50' },
      'Lead group 150 meters ahead. Run 4 minutes 50 seconds per kilometer to catch them in 3 minutes.',
    ],
    [
      { kind: 'gap', gapM: 1200, secPerKm: 240, pace: '4:00' },
      'Lead group 1.2 kilometers ahead. Run 4 minutes per kilometer to catch them in 3 minutes.',
    ],
  ];
  for (const [cue, want] of table) {
    const said = spokenCue(cue);
    assert.equal(said, want);
    assert.doesNotMatch(said, /\d:\d\d|\bkm\b/);
  }
});

test('spokenCue reads formatPace output exactly (0:59 and 10+ minute paces)', () => {
  assert.equal(spokenCue({ kind: 'km', km: 1, pace: formatPace(59), target: formatPace(600) }), '1 kilometer, split 59 seconds, target 10 minutes.');
  assert.equal(spokenCue({ kind: 'slow', pace: formatPace(725.4), target: formatPace(360) }), 'Pick it up: 12 minutes 5 seconds per kilometer, target 6 minutes.');
});
