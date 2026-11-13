// Run: npm test. Siri Keychain mirror (spec 10.5): which room is active, when it changes, and the stored value.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const plan = await import('../src/features/event/siri-plan.ts');

const NOW = Date.parse('2026-11-12T20:00:00Z');
const room = (id, { created = '2026-11-12T10:00:00Z', expires = '2026-11-13T10:00:00Z', deleted = null } = {}) => ({
  id,
  created_at: created,
  expires_at: expires,
  deleted_at: deleted,
});

test('an open room is not ended and not past its expiry', () => {
  assert.equal(plan.isOpenRoom(room('a'), NOW), true);
  assert.equal(plan.isOpenRoom(room('a', { deleted: '2026-11-12T19:00:00Z' }), NOW), false);
  assert.equal(plan.isOpenRoom(room('a', { expires: '2026-11-12T20:00:00Z' }), NOW), false);
  assert.equal(plan.isOpenRoom(room('a', { expires: 'garbage' }), NOW), false);
});

test('the active room is the last opened open room, else the newest open room, else none', () => {
  const rooms = [
    room('old', { created: '2026-11-12T08:00:00Z' }),
    room('new', { created: '2026-11-12T12:00:00Z' }),
    room('ended', { created: '2026-11-12T15:00:00Z', deleted: '2026-11-12T16:00:00Z' }),
    room('expired', { created: '2026-11-12T14:00:00Z', expires: '2026-11-12T19:59:59Z' }),
  ];
  assert.equal(plan.activeRoomId(rooms, 'old', NOW), 'old');
  assert.equal(plan.activeRoomId(rooms, null, NOW), 'new');
  // A last-opened room that ended, expired or was left falls back to the newest open room.
  assert.equal(plan.activeRoomId(rooms, 'ended', NOW), 'new');
  assert.equal(plan.activeRoomId(rooms, 'expired', NOW), 'new');
  assert.equal(plan.activeRoomId(rooms, 'left', NOW), 'new');
  assert.equal(plan.activeRoomId(rooms.slice(2), 'ended', NOW), null);
  assert.equal(plan.activeRoomId([], null, NOW), null);
});

test('the next change is the earliest open expiry', () => {
  const rooms = [
    room('a', { expires: '2026-11-13T10:00:00Z' }),
    room('b', { expires: '2026-11-12T21:00:00Z' }),
    room('gone', { expires: '2026-11-12T20:30:00Z', deleted: '2026-11-12T19:00:00Z' }),
  ];
  assert.equal(plan.nextRoomChangeMs(rooms, NOW), Date.parse('2026-11-12T21:00:00Z'));
  assert.equal(plan.nextRoomChangeMs([], NOW), null);
});

test('the stored value carries the access token, expiry, room and public config, never the refresh token', () => {
  const session = { access_token: 'jwt', expires_at: 1794500000, refresh_token: 'SECRET', user: { id: 'u' } };
  const value = plan.siriMirrorValue(session, 'r1', 'https://x.supabase.co', 'pk');
  assert.deepEqual(JSON.parse(value), {
    v: 1,
    accessToken: 'jwt',
    expiresAt: 1794500000,
    roomId: 'r1',
    supabaseUrl: 'https://x.supabase.co',
    anonKey: 'pk',
  });
  assert.equal(value.includes('SECRET'), false);
  assert.equal(JSON.parse(plan.siriMirrorValue(session, null, 'u', 'k')).roomId, null);
  assert.equal(plan.siriMirrorValue(null, 'r1', 'u', 'k'), null);
  assert.equal(plan.siriMirrorValue({ access_token: '', expires_at: 1 }, 'r1', 'u', 'k'), null);
  assert.equal(plan.siriMirrorValue({ access_token: 'jwt' }, 'r1', 'u', 'k'), null);
});

test('a stored value gives back its room id, and garbage gives none', () => {
  assert.equal(plan.storedRoomId(plan.siriMirrorValue({ access_token: 't', expires_at: 1 }, 'r9', 'u', 'k')), 'r9');
  assert.equal(plan.storedRoomId(plan.siriMirrorValue({ access_token: 't', expires_at: 1 }, null, 'u', 'k')), null);
  assert.equal(plan.storedRoomId('not json'), null);
  assert.equal(plan.storedRoomId(null), null);
});

test('the key and service match the Swift reader contract', () => {
  assert.equal(plan.SIRI_KEY, 'qrew.siri.v1');
  assert.equal(plan.SIRI_SERVICE, 'com.qrew.siri');
});
