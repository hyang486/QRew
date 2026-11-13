// Run: npm test. Pace maker scenarios (queue item 2), beyond pace-edge: jitter while stopped, a tunnel, a delayed
// out-of-order batch after the background, and the switch turned off and on mid-activity. `sim` mirrors
// engine.feedFixes (one cue per batch at most) and the 10 s stationary tick; engine.ts itself needs React Native.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  breakTracker,
  runStopped,
  chooseCue,
  closeStationary,
  mergeSession,
  newCueSchedule,
  newStationaryState,
  newTracker,
  openStationary,
  recentPace,
  stationaryDue,
  stepFixes,
  summarize,
} from '../src/features/pace/pace-core.ts';

const DEG_M = (6_371_000 * Math.PI) / 180;
/** A point `north` m north and `east` m east of (0, 0) at `s` seconds. */
const at = (north, s, accuracyM = 5, east = 0) => ({ latitude: north / DEG_M, longitude: east / DEG_M, atMs: s * 1000, accuracyM });
/** 5:00 per km, a fix every 5 s, from second `from` to `to`, starting at `fromM`. */
function run(from, to, fromM = 0) {
  const out = [];
  for (let s = from; s <= to; s += 5) out.push(at(fromM + ((s - from) * 1000) / 300, s));
  return out;
}
/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FIX_KEEP_MS = 6 * 60_000;
const TARGET = 300;

function newSim() {
  return { tracker: newTracker('room', 0), fixes: [], cues: newCueSchedule(), stationary: newStationaryState(), said: [], opened: [] };
}

/** One delivery of fixes at wall time `nowS` (engine.feedFixes). */
function deliver(sim, batch, nowS) {
  const nowMs = nowS * 1000;
  const stepped = stepFixes(sim.tracker, batch);
  if (!stepped.kept.length) {
    sim.tracker = stepped.tracker;
    return;
  }
  sim.tracker = stepped.tracker;
  sim.fixes = [...sim.fixes, ...stepped.kept].filter((f) => f.atMs >= nowMs - FIX_KEEP_MS);
  const t = sim.tracker;
  const r = chooseCue(sim.cues, {
    nowMs,
    km: Math.floor(t.distanceM / 1000),
    lastSplitS: t.splits.length ? t.splits[t.splits.length - 1] : null,
    recentSecPerKm: recentPace(t, t.seenAtMs),
    targetSecPerKm: TARGET,
    gap: null,
  });
  sim.cues = r.schedule;
  if (r.cue) sim.said.push({ s: nowS, ...r.cue });
}

/** The 10 s stationary tick (engine.checkStationary); the user taps Dismiss `dismissAfterS` after it opens. */
function tick(sim, nowS, dismissAfterS = 30) {
  const nowMs = nowS * 1000;
  if (sim.stationary.openSinceMs != null && nowMs - sim.stationary.openSinceMs >= dismissAfterS * 1000) {
    sim.stationary = closeStationary(nowMs);
  }
  if (stationaryDue(sim.fixes, nowMs, 0, sim.stationary)) {
    sim.stationary = openStationary(sim.stationary, nowMs);
    sim.cues = { ...sim.cues, lastCueAtMs: nowMs };
    sim.opened.push(nowS);
  }
}

/** Live delivery: each fix arrives at its own time; the stationary tick runs every 10 s up to `untilS`. */
function live(sim, fixes, untilS) {
  const queue = [...fixes].sort((a, b) => a.atMs - b.atMs);
  let i = 0;
  for (let s = 0; s <= untilS; s++) {
    while (i < queue.length && queue[i].atMs <= s * 1000) deliver(sim, [queue[i++]], s);
    if (s % 10 === 0) tick(sim, s);
  }
  return sim;
}

// --- (a) jitter while stopped -----------------------------------------------------------------------------------

/** 10 minutes standing at one point: fixes 5–15 m off it every 5–30 s, accuracy 10–30 m. */
function jitter(seed, centerM = 0, fromS = 0, toS = 600) {
  const r = rng(seed);
  const out = [];
  for (let s = fromS; s <= toS; s += 5 + Math.round(r() * 25)) {
    const off = 5 + r() * 10;
    const angle = r() * 2 * Math.PI;
    out.push(at(centerM + off * Math.cos(angle), s, 10 + r() * 20, off * Math.sin(angle)));
  }
  return out;
}

test('(a) jitter while stopped for 10 minutes: about 0 m, no moving time, one stopped prompt, no pace or km cue', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const sim = live(newSim(), jitter(seed), 600);
    const sum = summarize(sim.tracker);
    assert.ok(sum.distanceM <= 15, `seed ${seed}: ${sum.distanceM} m`);
    assert.ok(sum.durationS <= 10, `seed ${seed}: moving ${sum.durationS} s`);
    assert.equal(sum.avgSecPerKm, null);
    assert.equal(sim.opened.length, 1, `seed ${seed}: prompt opened at ${sim.opened}`);
    assert.ok(sim.opened[0] >= 180 && sim.opened[0] <= 240, `seed ${seed}: opened at ${sim.opened[0]}`);
    assert.deepEqual(sim.said, [], `seed ${seed}: ${JSON.stringify(sim.said)}`);
  }
});

test('(a) without accuracy the noise floor still holds the same jitter', () => {
  for (const seed of [1, 2, 3]) {
    const noAcc = jitter(seed).map((f) => ({ ...f, accuracyM: null }));
    const sum = summarize(live(newSim(), noAcc, 600).tracker);
    assert.ok(sum.distanceM <= 15, `seed ${seed}: ${sum.distanceM} m`);
  }
});

test('(a) jitter wider than the reported accuracy (5-15 m at 5 m, every 5 s): the 15 m floor holds it', () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const r = rng(seed);
    const fixes = [];
    for (let s = 0; s <= 600; s += 5) {
      const off = 5 + r() * 10;
      const angle = r() * 2 * Math.PI;
      fixes.push(at(off * Math.cos(angle), s, 5, off * Math.sin(angle)));
    }
    const sim = live(newSim(), fixes, 600);
    const sum = summarize(sim.tracker);
    assert.ok(sum.distanceM <= 15, `seed ${seed}: ${sum.distanceM} m`);
    assert.ok(sum.durationS <= 10, `seed ${seed}: moving ${sum.durationS} s`);
    assert.deepEqual(sim.said, [], `seed ${seed}: ${JSON.stringify(sim.said)}`);
  }
});

test('(a) jitter after running: the run keeps its distance and the stop adds none', () => {
  // 1050 m in 315 s, then 10 minutes standing there with a wandering fix. The last run fixes may be within noise
  // of the anchor (up to 30 m behind); they count once running resumes.
  const sim = live(newSim(), [...run(0, 315), ...jitter(9, 1050, 320, 920)], 920);
  const sum = summarize(sim.tracker);
  assert.ok(sum.distanceM >= 1020 && sum.distanceM <= 1065, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 315) <= 10, `moving ${sum.durationS} s`);
  assert.equal(sim.opened.length, 1);
  assert.deepEqual(
    sim.said.map((c) => c.kind),
    ['km'],
  );
});

// --- (b) a tunnel -----------------------------------------------------------------------------------------------

test('(b) tunnel: 4 minutes with no fix, then 800 m on: counted as the straight line, no stop prompt, no burst', () => {
  // 2300 m at 690 s, no fix until 930 s at 3100 m (3.33 m/s, plausible), then on at 5:00 per km to 4200 m.
  const sim = live(newSim(), [...run(0, 690), ...run(930, 1260, 3100)], 1260);
  const sum = summarize(sim.tracker);
  assert.ok(sum.distanceM >= 4185 && sum.distanceM <= 4202, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 1260) <= 10, `moving ${sum.durationS} s`);
  assert.deepEqual(sim.opened, []);
  const after = sim.said.filter((c) => c.s >= 930 && c.s < 1100);
  assert.deepEqual(
    after.map((c) => `${c.kind}${c.km ?? ''}@${c.s}`),
    ['km3@930'],
  );
  assert.deepEqual(
    sim.said.map((c) => c.km),
    [1, 2, 3, 4],
  );
});

test('(b) tunnel exit with an implausible jump: dropped, re-anchored after 3 agreeing fixes, no distance, no burst', () => {
  // 800 m only 30 s after the last fix (27 m/s): a jump, so the first two fixes after it are dropped.
  const sim = live(newSim(), [...run(0, 600), ...run(630, 900, 2800)], 900);
  const sum = summarize(sim.tracker);
  // 2000 m before; the 800 m jump left out; the third agreeing fix (640 s) re-anchors, then 260 s at 5:00 per km.
  assert.ok(Math.abs(sum.distanceM - 2866.67) <= 2, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 860) <= 1, `moving ${sum.durationS} s`);
  assert.deepEqual(sim.opened, []);
  assert.ok(sim.said.filter((c) => c.s >= 630 && c.s < 700).length <= 1, JSON.stringify(sim.said));
});

// --- (c) background and resume ----------------------------------------------------------------------------------

test('(c) a delayed batch, out of order and repeated: taken in order, repeats once, one cue for the batch', () => {
  const r = rng(42);
  const late = run(305, 900, 1016.67);
  const shuffled = [...late, ...late.slice(0, 20), ...late.slice(50, 60)]
    .map((f) => ({ f, k: r() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.f);

  const inOrder = live(newSim(), run(0, 300), 300);
  deliver(inOrder, late, 905);

  const batch = live(newSim(), run(0, 300), 300);
  const before = batch.said.length;
  deliver(batch, shuffled, 905);

  assert.equal(batch.tracker.distanceM, inOrder.tracker.distanceM);
  assert.equal(batch.tracker.movingMs, inOrder.tracker.movingMs);
  assert.deepEqual(batch.tracker.splits, inOrder.tracker.splits);
  assert.equal(batch.fixes.length, inOrder.fixes.length, 'repeats are not kept twice');
  const fresh = batch.said.slice(before);
  assert.equal(fresh.length, 1);
  assert.deepEqual({ kind: fresh[0].kind, km: fresh[0].km }, { kind: 'km', km: 3 });
  // The same batch again: nothing new.
  const again = structuredClone(batch.tracker);
  deliver(batch, shuffled, 930);
  assert.deepEqual(batch.tracker, again);
  assert.equal(batch.said.length, before + 1);
});

test('(c) a batch older than what was already seen is ignored, not inserted into the past', () => {
  const sim = live(newSim(), run(0, 600), 600);
  const snapshot = structuredClone(sim.tracker);
  deliver(sim, run(100, 400, 333.33), 610);
  assert.deepEqual(sim.tracker, snapshot);
});

// --- (d) the switch off and on mid-activity ---------------------------------------------------------------------

test('(d) switch off then on in the same room: one session, the off period adds nothing, splits go on', () => {
  // The run map keeps the session per room and activity (engine runKey); off flushes it and breaks the run
  // (engine.breakRun), on picks it up again from the next fix.
  const sim = live(newSim(), run(0, 400), 400);
  let history = mergeSession([], summarize(sim.tracker));
  assert.deepEqual(
    sim.said.map((c) => c.km),
    [1],
  );
  sim.tracker = breakTracker(sim.tracker);
  sim.fixes = [];

  // Off from 400 s to 520 s (no fixes fed), still running 400 m; on again at 520 s, 1733 m. Up to 930 s (3100 m).
  for (const f of run(520, 930, (520 * 1000) / 300)) deliver(sim, [f], f.atMs / 1000);
  history = mergeSession(history, summarize(sim.tracker));
  history = mergeSession(history, summarize(sim.tracker));

  assert.equal(history.length, 1);
  assert.equal(history[0].startedAt, 0);
  // 1333 m before and 1367 m after (the last fixes may be within noise); the 400 m while off is not counted.
  assert.ok(history[0].distanceM >= 2670 && history[0].distanceM <= 2702, `${history[0].distanceM} m`);
  assert.ok(Math.abs(history[0].durationS - 810) <= 10, `moving ${history[0].durationS} s`);
  // Elapsed (first to last fix) still includes the off period.
  assert.ok(Math.abs(history[0].elapsedS - 930) <= 5, `elapsed ${history[0].elapsedS} s`);
  assert.equal(history[0].splits.length, 2);
  for (const split of history[0].splits) assert.ok(Math.abs(split - 300) <= 1, `split ${split}`);
  assert.deepEqual(
    sim.said.filter((c) => c.kind === 'km').map((c) => c.km),
    [1, 2],
  );
});

test('(d) switch off for a 10 m/s bus ride of 600 s: no 6 km, no moving time, no fake km cues', () => {
  const sim = live(newSim(), run(0, 300), 300);
  sim.tracker = breakTracker(sim.tracker);
  sim.fixes = [];
  // Off at 1000 m; on again at 900 s, 7000 m away, then running on to 8200 m.
  for (const f of run(900, 1260, 7000)) deliver(sim, [f], f.atMs / 1000);
  const sum = summarize(sim.tracker);
  assert.ok(sum.distanceM >= 2170 && sum.distanceM <= 2202, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 660) <= 10, `moving ${sum.durationS} s`);
  assert.equal(sum.splits.length, 2);
  for (const split of sum.splits) assert.ok(Math.abs(split - 300) <= 1, `split ${split}`);
  assert.deepEqual(
    sim.said.filter((c) => c.kind === 'km').map((c) => c.km),
    [1, 2],
  );
});

test('(d) runStopped: only a true -> false change in one mount breaks the run, not re-entering the screen', () => {
  /** pace-layer's effect: the ref starts null on each mount and follows `running`; returns the breaks. */
  const breaks = (seq) => {
    let prev = null;
    let n = 0;
    for (const running of seq) {
      if (runStopped(prev, running)) n++;
      prev = running;
    }
    return n;
  };
  assert.equal(breaks([false, true]), 0, 'mount: share loads false, then true');
  assert.equal(breaks([true]), 0, 'mount already running');
  assert.equal(breaks([false, true, false]), 1, 'mount, then switch or sharing off');
  assert.equal(breaks([false, true, false, true]), 1, 'off and on again');
  assert.equal(breaks([false, false]), 0, 'mount while off');
});

test('(d) known limit: with the switch on and the screen left, the same bus ride is bridged (under 12 m/s)', () => {
  // Leaving the screen does not break the run (agreed for the background), so a gap no faster than
  // MAX_STEP_SPEED_MPS counts as a straight line; only switching off or sharing off re-anchors.
  const sim = live(newSim(), [...run(0, 300), ...run(900, 1260, 7000)], 1260);
  const sum = summarize(sim.tracker);
  assert.ok(sum.distanceM > 8000, `${sum.distanceM} m`);
});

// --- (e) leaving the noise circle after a stop ------------------------------------------------------------------

test('(e) walking 1.2 m/s with a 60 s light every 2 minutes (accuracy 20 m): the steps out of each stop count', () => {
  // 5 x (120 s walking, 144 m; 60 s standing): 720 m in 600 s of walking.
  const fixes = [];
  let m = 0;
  let s = 0;
  for (let leg = 0; leg < 5; leg++) {
    for (let i = 0; i < 24; i++) {
      s += 5;
      m += 6;
      fixes.push(at(m, s, 20));
    }
    for (let i = 0; i < 12; i++) {
      s += 5;
      fixes.push(at(m, s, 20));
    }
  }
  const sum = summarize(live(newSim(), fixes, s).tracker);
  // The final 40 m may still be within noise of the anchor (ends standing).
  assert.ok(sum.distanceM >= 680 && sum.distanceM <= 722, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 600) <= 10, `moving ${sum.durationS} s`);
});

test('(e) a 4-minute stop mid-run loses no distance and adds no moving time', () => {
  const stop = [];
  for (let s = 305; s <= 540; s += 5) stop.push(at(1000, s));
  const sim = live(newSim(), [...run(0, 300), ...stop, ...run(545, 1145, 1000)], 1145);
  const sum = summarize(sim.tracker);
  assert.ok(sum.distanceM >= 2970 && sum.distanceM <= 3002, `${sum.distanceM} m`);
  assert.ok(Math.abs(sum.durationS - 900) <= 10, `moving ${sum.durationS} s`);
});

test('(e) the step out of a stop faster than 12 m/s since the noise fix is a pause, not a burst (km split stays 5:00)', () => {
  // 966 m at 290 s, standing 120 s, a noise fix 14 m east, a fix 40 m ahead 0.5 s later, then running on.
  const stop = [];
  for (let s = 295; s <= 410; s += 5) stop.push(at(966.67, s));
  const fixes = [
    ...run(0, 290),
    ...stop,
    { ...at(966.67, 410.5, 5, 14) },
    at(1006.67, 411),
    ...run(416, 716, 1006.67 + (5 * 1000) / 300),
  ];
  const sim = live(newSim(), fixes, 716);
  const sum = summarize(sim.tracker);
  assert.ok(sum.splits.length >= 1);
  assert.ok(sum.splits[0] >= 295 && sum.splits[0] <= 305, `split ${sum.splits[0]}`);
});

test('(e) known limit: one outlier at the end of a stop adds its offset once (31 m, was 62), not twice', () => {
  // Standing 180 s, a noise fix 14 m west, an outlier 31 m east 1 s later, then back at the point. The outlier is
  // over 12 m/s from the noise fix, so it is a pause (no 45 m credit), but it becomes the anchor and the step back
  // (31 m in 3 s) counts.
  const fixes = [];
  for (let s = 0; s <= 180; s += 5) fixes.push(at(0, s));
  fixes.push(at(0, 181, 5, -14), at(0, 182, 5, 31));
  for (let s = 185; s <= 300; s += 5) fixes.push(at(0, s));
  const sum = summarize(live(newSim(), fixes, 300).tracker);
  assert.ok(sum.distanceM <= 32, `${sum.distanceM} m`);
  assert.ok(sum.durationS <= 5, `moving ${sum.durationS} s`);
});
