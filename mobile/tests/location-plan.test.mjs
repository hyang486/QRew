// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  distanceMeters,
  formatAge,
  formatSpeedKmh,
  FRESH_FIX_MAX_AGE_MS,
  FRESH_FIX_TIMEOUT_MS,
  freshFixAttemptDue,
  HEARTBEAT_MS,
  memberStatusLabels,
  heartbeatDue,
  isFreshReading,
  initials,
  isStale,
  MAX_ROUTE_POINTS,
  parseRoute,
  planHeartbeat,
  planPins,
  reconcileShare,
  REPORT_MIN_INTERVAL_MS,
  reportedSpeed,
  shouldReport,
  STALE_AFTER_MS,
  toRoutePayload,
  wantedIconPaths,
  withTimeout,
} from '../src/lib/location-plan.ts';

const A = { latitude: 37.5665, longitude: 126.978 };
// About 111 m north of A.
const B = { latitude: 37.5675, longitude: 126.978 };
// About 1 m north of A.
const NEAR = { latitude: 37.56651, longitude: 126.978 };

test('distance is about 111 m per 0.001 degree of latitude', () => {
  const d = distanceMeters(A, B);
  assert.ok(d > 105 && d < 117, String(d));
  assert.equal(distanceMeters(A, A), 0);
});

test('first valid fix is always sent', () => {
  assert.equal(shouldReport(null, A, 0), true);
});

test('never more than one report per 5 s, even for a big move', () => {
  const last = { ...A, atMs: 1_000 };
  assert.equal(shouldReport(last, B, 1_000 + REPORT_MIN_INTERVAL_MS - 1), false);
  assert.equal(shouldReport(last, B, 1_000 + REPORT_MIN_INTERVAL_MS), true);
});

test('a small move waits for the heartbeat', () => {
  const last = { ...A, atMs: 0 };
  assert.equal(shouldReport(last, NEAR, REPORT_MIN_INTERVAL_MS + 1), false);
  assert.equal(shouldReport(last, NEAR, HEARTBEAT_MS), true);
});

test('heartbeat is shorter than the stale threshold', () => {
  assert.ok(HEARTBEAT_MS < STALE_AFTER_MS);
});

test('invalid coordinates are never sent', () => {
  assert.equal(shouldReport(null, { latitude: NaN, longitude: 0 }, 0), false);
  assert.equal(shouldReport(null, { latitude: 91, longitude: 0 }, 0), false);
  assert.equal(shouldReport(null, { latitude: 0, longitude: -181 }, 0), false);
});

test('stale after 60 s and for unparseable times', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(isStale('2026-11-05T11:59:30Z', now), false);
  assert.equal(isStale('2026-11-05T11:58:59Z', now), true);
  assert.equal(isStale('not a date', now), true);
});

test('age labels', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(formatAge('2026-11-05T11:59:40Z', now), 'just now');
  assert.equal(formatAge('2026-11-05T11:57:00Z', now), '3 min ago');
  assert.equal(formatAge('2026-11-05T09:30:00Z', now), '2 h ago');
});

test('speed in km/h; unknown stays unknown', () => {
  assert.equal(formatSpeedKmh(2.5), '9.0 km/h');
  assert.equal(formatSpeedKmh(null), null);
  assert.equal(formatSpeedKmh(-1), null);
  assert.equal(formatSpeedKmh(Infinity), null);
});

test('route parsing skips malformed points', () => {
  const route = [{ lat: 1, lng: 2 }, { lat: '3', lng: 4 }, null, { lat: 95, lng: 0 }, { lat: -1, lng: -2, x: 9 }];
  assert.deepEqual(parseRoute(route), [
    { latitude: 1, longitude: 2 },
    { latitude: -1, longitude: -2 },
  ]);
  assert.deepEqual(parseRoute({}), []);
  assert.deepEqual(parseRoute(null), []);
});

test('route payload is {lat, lng}, capped at the server limit', () => {
  assert.deepEqual(toRoutePayload([A]), [{ lat: A.latitude, lng: A.longitude }]);
  const many = Array.from({ length: MAX_ROUTE_POINTS + 5 }, () => A);
  assert.equal(toRoutePayload(many).length, MAX_ROUTE_POINTS);
});

// M7: the opt-in race between the share read and the set_share_location RPC.
test('reconcileShare ignores a read while an opt-in RPC is pending', () => {
  for (const server of [true, false]) {
    assert.equal(reconcileShare({ server, consented: true, pending: true, genAtStart: 1, genNow: 1 }), 'ignore');
  }
});

test('reconcileShare ignores a read that began before consent last changed', () => {
  assert.equal(reconcileShare({ server: false, consented: true, pending: false, genAtStart: 1, genNow: 2 }), 'ignore');
  assert.equal(reconcileShare({ server: true, consented: false, pending: false, genAtStart: 3, genNow: 4 }), 'ignore');
});

test('reconcileShare on a current read', () => {
  const read = (server, consented) => reconcileShare({ server, consented, pending: false, genAtStart: 5, genNow: 5 });
  assert.equal(read(true, true), 'on');
  // Left on by an earlier run or another device: switched off, never resumed silently.
  assert.equal(read(true, false), 'turn-off-server');
  // The server stopped it (activity ended, location disallowed, left the room).
  assert.equal(read(false, true), 'drop-consent');
  assert.equal(read(false, false), 'off');
});

// M1: map pins.
const NOW = Date.parse('2026-11-05T12:00:00Z');
const FRESH = new Date(NOW - 10_000).toISOString();
const OLD = new Date(NOW - STALE_AFTER_MS - 1_000).toISOString();
const pin = (over) => ({
  userId: 'u1',
  coordinates: A,
  updatedAt: FRESH,
  speedMps: 2,
  label: 'Test joiner',
  initialsOf: 'Test joiner',
  avatarPath: 'u1/a.jpg',
  ...over,
});

test('planPins: fresh member with a loaded photo is a photo pin with name and speed', () => {
  const [p] = planPins([pin()], NOW, new Map([['u1/a.jpg', 'ICON']]));
  assert.deepEqual(p, { kind: 'photo', id: 'u1', coordinates: A, title: 'Test joiner · 7.2 km/h', icon: 'ICON' });
});

test('planPins: no photo, not loaded yet, or failed falls back to initials', () => {
  assert.equal(planPins([pin({ avatarPath: null })], NOW, new Map())[0].monogram, 'TJ');
  const [p] = planPins([pin()], NOW, new Map());
  assert.equal(p.kind, 'monogram');
  assert.equal(p.title, 'Test joiner · 7.2 km/h');
});

test('planPins: a stale member is a clock pin without speed, even with a loaded photo (C4)', () => {
  const [p] = planPins([pin({ updatedAt: OLD })], NOW, new Map([['u1/a.jpg', 'ICON']]));
  assert.deepEqual(p, { kind: 'stale', id: 'u1:stale', coordinates: A, title: 'Test joiner · stale' });
});

test('planPins: a pin going stale changes marker identity and says so (F6-1)', () => {
  const fresh = planPins([pin({ avatarPath: null })], NOW, new Map())[0];
  const stale = planPins([pin({ avatarPath: null, updatedAt: OLD })], NOW, new Map(), 'stale')[0];
  assert.equal(fresh.kind, 'monogram');
  assert.equal(stale.kind, 'stale');
  assert.notEqual(stale.id, fresh.id);
  assert.match(stale.title, /stale/);
  assert.doesNotMatch(stale.title, /km\/h/);
});

test('planPins: a member status comes last, fresh or stale, and keeps the pin id (#2)', () => {
  const fresh = planPins([pin({ status: 'Need water' })], NOW, new Map())[0];
  assert.equal(fresh.title, 'Test joiner · 7.2 km/h · Need water');
  assert.equal(fresh.id, 'u1');
  const stale = planPins([pin({ status: 'Need water', updatedAt: OLD })], NOW, new Map(), 'stale')[0];
  assert.equal(stale.title, 'Test joiner · stale · Need water');
  assert.equal(stale.id, 'u1:stale');
  assert.equal(planPins([pin({ status: null })], NOW, new Map())[0].title, 'Test joiner · 7.2 km/h');
});

test('memberStatusLabels maps members to their status label and skips unknown statuses (#2)', () => {
  const labels = memberStatusLabels(
    new Map([['u1', 's1'], ['u2', 'gone'], ['u3', 's2']]),
    [{ id: 's1', label: 'Need water' }, { id: 's2', label: 'Emergency' }],
  );
  assert.deepEqual([...labels], [['u1', 'Need water'], ['u3', 'Emergency']]);
});

test('wantedIconPaths holds only fresh pins with a photo', () => {
  const wanted = wantedIconPaths(
    [pin(), pin({ userId: 'u2', avatarPath: 'u2/b.jpg', updatedAt: OLD }), pin({ userId: 'u3', avatarPath: null })],
    NOW,
  );
  assert.deepEqual([...wanted], ['u1/a.jpg']);
});

test('initials takes up to two letters', () => {
  assert.equal(initials('Test joiner'), 'TJ');
  assert.equal(initials('  '), '?');
  assert.equal(initials('a b c'), 'AB');
});

// MS1/MS2: fresh fixes only, speed only from the reported fix ---------------------------------------

const T = 1_000_000;
const reading = (over = {}) => ({
  latitude: 37.7694,
  longitude: -122.4862,
  speed: 5,
  accuracy: 5,
  heading: 90,
  timestampMs: T - 500,
  ...over,
});

test('reportedSpeed keeps a measured speed and 0, drops iOS -1 and non-finite values', () => {
  assert.equal(reportedSpeed(5), 5);
  assert.equal(reportedSpeed(0), 0);
  assert.equal(reportedSpeed(-1), null);
  assert.equal(reportedSpeed(null), null);
  assert.equal(reportedSpeed(NaN), null);
  assert.equal(reportedSpeed(Infinity), null);
});

test('isFreshReading accepts a new, recent, valid reading', () => {
  assert.equal(isFreshReading(reading(), null, T), true);
  assert.equal(isFreshReading(reading(), T - 31_000, T), true);
});

test('isFreshReading rejects a cached or same-timestamp reading', () => {
  const r = reading({ timestampMs: T - 31_000 });
  assert.equal(isFreshReading(r, T - 31_000, T), false, 'same timestamp as the last report');
  assert.equal(isFreshReading(r, T - 30_000, T), false, 'older than the last report');
});

test('isFreshReading rejects an old reading even when nothing was sent yet (no frozen fixes, C5)', () => {
  assert.equal(isFreshReading(reading({ timestampMs: T - FRESH_FIX_MAX_AGE_MS }), null, T), true);
  assert.equal(isFreshReading(reading({ timestampMs: T - FRESH_FIX_MAX_AGE_MS - 1 }), null, T), false);
  assert.equal(isFreshReading(reading({ timestampMs: NaN }), null, T), false);
});

test('isFreshReading rejects invalid coordinates', () => {
  assert.equal(isFreshReading(reading({ latitude: 91 }), null, T), false);
  assert.equal(isFreshReading(reading({ longitude: NaN }), null, T), false);
});

test('heartbeatDue: before any report, and once HEARTBEAT_MS has passed since the last report', () => {
  assert.equal(heartbeatDue(null, T), true);
  assert.equal(heartbeatDue(T - HEARTBEAT_MS + 1, T), false);
  assert.equal(heartbeatDue(T - HEARTBEAT_MS, T), true);
});

test('planHeartbeat: moving fresh fix is reported with its own speed', () => {
  const r = reading();
  assert.deepEqual(planHeartbeat({ ok: true, reading: r }, T - 31_000, T), r);
});

test('planHeartbeat: stationary fresh fix is reported without the old moving speed', () => {
  const stillIos = planHeartbeat({ ok: true, reading: reading({ speed: -1 }) }, T - 31_000, T);
  assert.equal(stillIos?.speed, null);
  const measuredZero = planHeartbeat({ ok: true, reading: reading({ speed: 0 }) }, T - 31_000, T);
  assert.equal(measuredZero?.speed, 0);
  const noSpeed = planHeartbeat({ ok: true, reading: reading({ speed: null }) }, T - 31_000, T);
  assert.equal(noSpeed?.speed, null);
});

test('planHeartbeat: a cached (not newer) reading sends nothing', () => {
  const r = reading({ timestampMs: T - 31_000 });
  assert.equal(planHeartbeat({ ok: true, reading: r }, T - 31_000, T), null);
});

test('planHeartbeat: a failed or timed-out read sends nothing', () => {
  assert.equal(planHeartbeat({ ok: false }, T - 31_000, T), null);
  assert.equal(planHeartbeat({ ok: false }, null, T), null);
});

test('fresh-fix timing keeps a stationary sharer fresh: heartbeat + timeout + max age stay under the stale cutoff', () => {
  assert.ok(HEARTBEAT_MS + FRESH_FIX_TIMEOUT_MS < STALE_AFTER_MS);
  assert.ok(FRESH_FIX_MAX_AGE_MS < STALE_AFTER_MS);
});

test('withTimeout resolves with the value, or rejects after the timeout', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), /timed out/);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50), /boom/);
});

test('freshFixAttemptDue (MS-R1): after a failed attempt, the next waits HEARTBEAT_MS, not one tick', () => {
  // Nothing sent yet, no attempt yet: start one.
  assert.equal(freshFixAttemptDue(null, null, T), true);
  // A failed attempt at T: every following 5 s tick stays blocked until HEARTBEAT_MS has passed.
  for (let dt = 5_000; dt < HEARTBEAT_MS; dt += 5_000) {
    assert.equal(freshFixAttemptDue(null, T, T + dt), false);
  }
  assert.ok(HEARTBEAT_MS > FRESH_FIX_TIMEOUT_MS);
  assert.equal(freshFixAttemptDue(null, T, T + HEARTBEAT_MS), true);
  // After a report, the heartbeat rule still applies first.
  assert.equal(freshFixAttemptDue(T, T - HEARTBEAT_MS, T + HEARTBEAT_MS - 1), false);
  // Successful heartbeat at T (attempt and report both at T): next attempt at T + HEARTBEAT_MS, unchanged.
  assert.equal(freshFixAttemptDue(T, T, T + HEARTBEAT_MS), true);
});

test('planLocate: granted locates, undecided asks, denied for good goes to Settings', async () => {
  const { planLocate } = await import('../src/lib/location-plan.ts');
  assert.equal(planLocate({ granted: true, canAskAgain: true }), 'locate');
  assert.equal(planLocate({ granted: true, canAskAgain: false }), 'locate');
  assert.equal(planLocate({ granted: false, canAskAgain: true }), 'ask');
  assert.equal(planLocate({ granted: false, canAskAgain: false }), 'settings');
});
