// Run: npm test. Replays scripts/pace-gps-demo.mjs legs (dry run, no simulator) through the pace core the way
// engine.feedFixes does, and checks the cue table in docs/evidence/qrewing-pace-qa-demo.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plans, ROUTE, slice } from '../../scripts/pace-gps-demo.mjs';
import {
  chooseCue,
  gapCue,
  newCueSchedule,
  newTracker,
  progressAlongRoute,
  recentPace,
  stationaryDue,
  newStationaryState,
  stepFixes,
} from '../src/features/pace/pace-core.ts';

const REPORT_S = 5; // the reporter's REPORT_MIN_INTERVAL_MS while moving
const HEARTBEAT_S = 30; // and its heartbeat while standing still
const TARGET = 300; // 5:00 per km
const route = ROUTE.map(([latitude, longitude]) => ({ latitude, longitude }));
const pointAt = (m) => {
  const [latitude, longitude] = slice(m, m + 0.01)[0];
  return { latitude, longitude };
};

/** Position, speed and whether a fix is reported at second `t` of a device's plan. */
function stateAt(legs, t) {
  let start = 0;
  for (const leg of legs) {
    const end = start + leg.seconds;
    if (t <= end) {
      const into = t - start;
      if (leg.kind === 'hold') return { m: leg.atM, mps: 0, report: Math.round(into) % HEARTBEAT_S === 0 };
      return { m: leg.fromM + leg.mps * into, mps: leg.mps, report: Math.round(t) % REPORT_S === 0 };
    }
    start = end;
  }
  return null;
}

/** The cues and the stationary prompt one device (`me`) gets, as [second, kind, detail]. */
function replay(scenario, me) {
  const plan = plans(scenario);
  let tracker = newTracker('demo', 0);
  let cues = newCueSchedule();
  let fixes = [];
  let stationary = newStationaryState();
  const out = [];
  for (let t = 0; ; t += 1) {
    const mine = stateAt(plan[me], t);
    if (!mine) break;
    const nowMs = t * 1000;
    if (mine.report) {
      const fix = { ...pointAt(mine.m), atMs: nowMs, accuracyM: 5 };
      const stepped = stepFixes(tracker, [fix]);
      tracker = stepped.tracker;
      if (stepped.kept.length) {
        fixes = [...fixes, ...stepped.kept].filter((f) => f.atMs >= nowMs - 6 * 60_000);
        const runners = Object.keys(plan).flatMap((who) => {
          const s = who === me ? mine : stateAt(plan[who], t);
          return s ? [{ userId: who, progressM: progressAlongRoute(pointAt(s.m), route), speedMps: s.mps }] : [];
        });
        const chosen = chooseCue(cues, {
          nowMs,
          km: Math.floor(tracker.distanceM / 1000),
          lastSplitS: tracker.splits.length ? tracker.splits[tracker.splits.length - 1] : null,
          recentSecPerKm: recentPace(tracker, tracker.seenAtMs),
          targetSecPerKm: TARGET,
          gap: gapCue(me, runners),
        });
        cues = chosen.schedule;
        if (chosen.cue) out.push([t, chosen.cue.kind, chosen.cue.kind === 'gap' ? chosen.cue.gapM : chosen.cue.pace]);
      }
    }
    if (t % 5 === 0 && stationaryDue(fixes, nowMs, 0, stationary)) {
      stationary = { ...stationary, openSinceMs: nowMs };
      cues = { ...cues, lastCueAtMs: nowMs };
      out.push([t, 'stationary', null]);
    }
  }
  return out;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('demo steady: km 1, 2, 3 at about 5:00, 10:00, 15:00 with a 5:00 split; nothing else', () => {
  const cues = replay('steady', 'host');
  assert.deepEqual(cues.map((c) => c[1]), ['km', 'km', 'km']);
  cues.forEach(([t, , pace], i) => {
    assert.ok(near(t, 300 * (i + 1), 15), `km ${i + 1} at ${t}s`);
    assert.equal(pace, '5:00');
  });
});

test('demo gap (guest): slow first, gap cues from about 3:00 every 2 min while >150 m behind, none after ~8:10', () => {
  const cues = replay('gap', 'guest');
  assert.equal(cues[0][1], 'slow');
  const gaps = cues.filter((c) => c[1] === 'gap');
  assert.ok(gaps.length >= 2, JSON.stringify(cues));
  assert.ok(near(gaps[0][0], 180, 20), `first gap cue at ${gaps[0][0]}s`);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i][0] - gaps[i - 1][0] >= 120);
  assert.ok(gaps.every(([t, , m]) => t <= 495 && m > 150 && m <= 310), JSON.stringify(gaps));
  // Never a slow/fast cue while behind the lead group.
  for (const [t, kind] of cues) if (kind === 'slow' || kind === 'fast') assert.ok(t < gaps[0][0] || t > 490, `${kind} at ${t}s`);
  const kms = cues.filter((c) => c[1] === 'km').map((c) => c[2]);
  assert.equal(kms.length, 3);
});

test('demo stop: the "Everything okay?" sheet at about 6:00 (3 min into the stop), km 1 at about 9:00', () => {
  const cues = replay('stop', 'host');
  const prompt = cues.filter((c) => c[1] === 'stationary');
  assert.equal(prompt.length, 1);
  assert.ok(near(prompt[0][0], 360, 15), `prompt at ${prompt[0][0]}s`);
  const kms = cues.filter((c) => c[1] === 'km');
  assert.equal(kms.length, 1);
  assert.ok(near(kms[0][0], 540, 20), `km 1 at ${kms[0][0]}s`);
  assert.equal(kms[0][2], '5:00');
});
