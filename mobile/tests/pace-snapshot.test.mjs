// Run: npm test. Qrewing bot `me` snapshot (spec 10.4): null without a running activity, moving time per the
// 2026-11-12 decision, the asker's own moving/stopped state, and never a coordinate.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addFix, currentPaceSnapshot, newTracker, SNAPSHOT_MOVING_FRESH_MS } from '../src/features/pace/pace-core.ts';

const M_PER_DEG = 111_195;
const fix = (s, northM) => ({ latitude: 37.5 + northM / M_PER_DEG, longitude: 127.0, atMs: s * 1000, accuracyM: 5 });

/** Fixes every 10 s at `mps` from second `fromS` to `toS` (inclusive), starting at `startM` metres north. */
function walk(t, fromS, toS, mps, startM = 0) {
  for (let s = fromS; s <= toS; s += 10) t = addFix(t, fix(s, startM + (s - fromS) * mps));
  return t;
}

const snap = (tracker, nowS, activityRunning = true) => currentPaceSnapshot({ activityRunning, tracker, nowMs: nowS * 1000 });

test('null without a running activity, without a tracker, or before the first fix', () => {
  const t = walk(newTracker('r', 0), 0, 300, 4);
  assert.equal(snap(t, 300, false), null);
  assert.equal(snap(null, 300), null);
  assert.equal(snap(undefined, 300), null);
  assert.equal(snap(newTracker('r', 0), 300), null);
});

test('moving: whole metres, moving seconds, average moving pace', () => {
  const t = walk(newTracker('r', 0), 0, 300, 4); // 1200 m in 300 s = 250 s/km
  assert.deepEqual(snap(t, 305), { elapsedSec: 300, distanceM: 1200, paceSecPerKm: 250, activity: 'moving' });
});

test('exactly the four fields, and no coordinate anywhere', () => {
  const s = snap(walk(newTracker('r', 0), 0, 300, 4), 300);
  assert.deepEqual(Object.keys(s).sort(), ['activity', 'distanceM', 'elapsedSec', 'paceSecPerKm']);
  assert.doesNotMatch(JSON.stringify(s), /lat|lon|37\.5|127/i);
});

test('a stop adds no time: stopped while standing, moving time unchanged', () => {
  let t = walk(newTracker('r', 0), 0, 300, 4);
  for (let s = 310; s <= 600; s += 10) t = addFix(t, fix(s, 1200 + (s % 20 ? 3 : -3))); // GPS noise in place
  const s = snap(t, 600);
  assert.equal(s.activity, 'stopped');
  assert.equal(s.elapsedSec, 300);
  assert.equal(s.distanceM, 1200);
  assert.equal(s.paceSecPerKm, 250);
  // Moving again after the stop.
  t = walk(t, 610, 700, 4, 1240);
  assert.equal(snap(t, 700).activity, 'moving');
});

test('E2E (b): moving at every second of a steady run with 1 Hz fixes (most land in the noise circle)', () => {
  let t = newTracker('r', 0);
  const wrong = [];
  for (let s = 0; s <= 600; s++) {
    t = addFix(t, fix(s, s * 3));
    if (s >= 60 && snap(t, s).activity !== 'moving') wrong.push(s);
  }
  assert.deepEqual(wrong, []);
});

test('stopped once the last move is stale (no new fix)', () => {
  const t = walk(newTracker('r', 0), 0, 300, 4);
  assert.equal(snap(t, 300 + SNAPSHOT_MOVING_FRESH_MS / 1000).activity, 'moving');
  assert.equal(snap(t, 301 + SNAPSHOT_MOVING_FRESH_MS / 1000).activity, 'stopped');
});

test('one fix: running but unmeasured, stopped with zeros and no pace', () => {
  const t = addFix(newTracker('r', 0), fix(0, 0));
  assert.deepEqual(snap(t, 5), { elapsedSec: 0, distanceM: 0, paceSecPerKm: null, activity: 'stopped' });
});

test('no pace under 100 m, and none slower than the server range (3600 s/km)', () => {
  assert.equal(snap(walk(newTracker('r', 0), 0, 20, 4), 20).paceSecPerKm, null); // 80 m
  let t = addFix(newTracker('r', 0), fix(0, 0));
  // 0.6 m/s steps of 60 s (36 m each, outside GPS noise): 1667 s/km, within range.
  for (let s = 60; s <= 600; s += 60) t = addFix(t, fix(s, (s / 60) * 36));
  assert.equal(snap(t, 600).paceSecPerKm, 1667);
  // Out of range only from a hand-built tracker (steps under 0.5 m/s are pauses): sent as null, not rejected.
  const slow = { ...t, distanceM: 100, movingMs: 400_000 };
  assert.equal(snap(slow, 600).paceSecPerKm, null);
});
