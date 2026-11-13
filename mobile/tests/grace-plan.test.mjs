// Run: npm test. Qrewing grace period (spec 7): room phase, timer, allowed actions, room list entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  graceAllows,
  graceTimerDelay,
  graceUntilMs,
  isGrace,
  roomListEntry,
  roomPhase,
  screenActions,
} from '../src/features/recap/grace-plan.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const iso = (t) => new Date(t).toISOString();

const open = { deleted_at: null, expires_at: iso(NOW + 60 * MIN), grace_until: null };
const graceRoom = { deleted_at: iso(NOW - 5 * MIN), expires_at: iso(NOW + 60 * MIN), grace_until: iso(NOW + 25 * MIN) };

test('roomPhase: open, grace, ended', () => {
  assert.equal(roomPhase(open, NOW), 'open');
  assert.equal(roomPhase(graceRoom, NOW), 'grace');
  // grace_until reached or passed
  assert.equal(roomPhase(graceRoom, NOW + 25 * MIN), 'ended');
  // host end with no grace (account deletion) and an old row without the column
  assert.equal(roomPhase({ ...graceRoom, grace_until: null }, NOW), 'ended');
  assert.equal(roomPhase({ deleted_at: graceRoom.deleted_at, expires_at: graceRoom.expires_at }, NOW), 'ended');
  // scheduled expiry: no grace even if a stray grace_until is present
  assert.equal(roomPhase({ ...open, expires_at: iso(NOW - MIN), grace_until: iso(NOW + MIN) }, NOW), 'ended');
  assert.equal(roomPhase({ ...open, expires_at: iso(NOW) }, NOW), 'ended');
  // unreadable values never read as grace or open
  assert.equal(roomPhase({ ...graceRoom, grace_until: 'nope' }, NOW), 'ended');
  assert.equal(roomPhase({ ...open, expires_at: 'nope' }, NOW), 'ended');
  assert.equal(roomPhase(null, NOW), 'ended');
});

test('graceUntilMs and graceTimerDelay only while in grace', () => {
  assert.equal(graceUntilMs(graceRoom, NOW), NOW + 25 * MIN);
  assert.equal(graceUntilMs(open, NOW), null);
  assert.equal(graceTimerDelay(graceRoom, NOW), 25 * MIN);
  assert.equal(graceTimerDelay(graceRoom, NOW + 25 * MIN), null);
  assert.equal(graceTimerDelay(open, NOW), null);
});

test('graceAllows: grace is read-only', () => {
  assert.deepEqual(graceAllows('open'), { read: true, write: true });
  assert.deepEqual(graceAllows('grace'), { read: true, write: false });
  assert.deepEqual(graceAllows('ended'), { read: false, write: false });
});

test('roomListEntry: grace rows carry their end time, ended rows hide', () => {
  assert.deepEqual(roomListEntry(open, NOW), { kind: 'open' });
  assert.deepEqual(roomListEntry(graceRoom, NOW), { kind: 'grace', untilMs: NOW + 25 * MIN });
  assert.deepEqual(roomListEntry(graceRoom, NOW + 30 * MIN), { kind: 'hidden' });
});

test('isGrace boundaries: grace_until null, past, now, future', () => {
  const ended = graceRoom.deleted_at;
  assert.equal(isGrace({ ...graceRoom, grace_until: null }, NOW), false);
  assert.equal(isGrace({ ...graceRoom, grace_until: iso(NOW - 1) }, NOW), false);
  assert.equal(isGrace({ ...graceRoom, grace_until: iso(NOW) }, NOW), false);
  assert.equal(isGrace({ ...graceRoom, grace_until: iso(NOW + 1) }, NOW), true);
  // grace needs deleted_at: an open room with a grace_until is not in grace
  assert.equal(isGrace({ ...open, grace_until: iso(NOW + MIN) }, NOW), false);
  assert.equal(isGrace({ deleted_at: ended, expires_at: graceRoom.expires_at, grace_until: undefined }, NOW), false);
});

test('screenActions: open shows everything; grace keeps view and download only; ended shows Room ended', () => {
  const all = { view: true, download: true, endedScreen: false };
  assert.deepEqual(screenActions('gallery', 'open'), { ...all, upload: true, notMe: false, matchRun: false, setup: false });
  assert.deepEqual(screenActions('media', 'open'), { ...all, upload: false, notMe: true, matchRun: false, setup: false });
  assert.deepEqual(screenActions('photos-of-me', 'open'), { ...all, upload: false, notMe: false, matchRun: true, setup: true });
  assert.deepEqual(screenActions('face', 'open'), { ...all, upload: false, notMe: false, matchRun: false, setup: true });

  const ro = { view: true, download: true, upload: false, notMe: false, matchRun: false, setup: false, endedScreen: false };
  assert.deepEqual(screenActions('gallery', 'grace'), ro);
  assert.deepEqual(screenActions('media', 'grace'), ro);
  assert.deepEqual(screenActions('photos-of-me', 'grace'), ro);
  const ended = { view: false, download: false, upload: false, notMe: false, matchRun: false, setup: false, endedScreen: true };
  assert.deepEqual(screenActions('face', 'grace'), ended);
  for (const s of ['gallery', 'media', 'photos-of-me', 'face']) assert.deepEqual(screenActions(s, 'ended'), ended);
});

test('grace clock walk: open, mid grace, exact end, after (QA edge)', () => {
  const endedAt = NOW + 10 * MIN;
  const until = endedAt + 30 * MIN;
  const before = { deleted_at: null, expires_at: iso(NOW + 120 * MIN), grace_until: null };
  const after = { ...before, deleted_at: iso(endedAt), grace_until: iso(until) };
  assert.equal(roomPhase(before, NOW), 'open');
  // Mid grace: read-only, timer counts down to grace_until.
  const mid = endedAt + 15 * MIN;
  assert.equal(roomPhase(after, mid), 'grace');
  assert.deepEqual(graceAllows(roomPhase(after, mid)), { read: true, write: false });
  assert.equal(graceTimerDelay(after, mid), 15 * MIN);
  assert.equal(graceUntilMs(after, mid), until);
  // Exactly at grace_until and after: ended, no timer, nothing allowed.
  for (const t of [until, until + 1, until + 60 * MIN]) {
    assert.equal(roomPhase(after, t), 'ended');
    assert.equal(graceTimerDelay(after, t), null);
    assert.deepEqual(graceAllows(roomPhase(after, t)), { read: false, write: false });
  }
});

test('grace edge rows: past expires_at still in grace, bad or missing grace_until, huge delay clamps (QA edge)', () => {
  const pastExpiry = { deleted_at: iso(NOW - MIN), expires_at: iso(NOW - 2 * MIN), grace_until: iso(NOW + 29 * MIN) };
  assert.equal(roomPhase(pastExpiry, NOW), 'grace');
  assert.equal(roomPhase({ ...graceRoom, grace_until: 'not a date' }, NOW), 'ended');
  assert.equal(roomPhase({ ...graceRoom, grace_until: undefined }, NOW), 'ended');
  assert.equal(roomPhase(null, NOW), 'ended');
  assert.equal(roomPhase({ ...open, expires_at: 'bad' }, NOW), 'ended');
  const far = { ...graceRoom, grace_until: iso(NOW + 40 * 24 * 60 * MIN) };
  assert.equal(graceTimerDelay(far, NOW), 2_147_483_647);
});
