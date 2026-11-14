// Run: npm test. Qrewing Calendar phone storage: parse, room snapshots, recap diary, events, sign-out clear.
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const d = await import('../src/features/calendar/calendar-data.ts');
const tz = 'America/Los_Angeles';
const room = (id, over = {}) => ({
  id, name: `Room ${id}`, type: 'sports', starts_at: null, created_at: '2026-11-15T16:00:00Z', expires_at: '2026-11-17T16:00:00Z', deleted_at: null, ...over,
});

test('keys are versioned and per user', () => {
  assert.equal(d.calendarKey('u1'), 'qrew.calendar.v1.u1');
  assert.equal(d.plusPreviewKey('u1'), 'qrew.plusPreview.v1.u1');
});

test('parseDoc: empty, garbage, other version and bad rows fall back safely', () => {
  assert.deepEqual(d.parseDoc(null), d.emptyDoc());
  assert.deepEqual(d.parseDoc('{oops'), d.emptyDoc());
  assert.deepEqual(d.parseDoc(JSON.stringify({ version: 2, rooms: {}, events: [] })), d.emptyDoc());
  const doc = d.parseDoc(JSON.stringify({
    version: 1,
    rooms: { r: { roomId: 'r', name: 'Run', type: 'sports', start: '2026-11-15', end: '2026-11-17', endAt: 'x', emoji: '🏃' }, bad: { roomId: 'bad' } },
    events: [{ id: 'e', title: 'Dentist', start: '2026-11-20', end: '2026-11-20', emoji: '🦷' }, { id: 'x', title: 'Backwards', start: '2026-11-21', end: '2026-11-20', emoji: '⚠️' }],
  }));
  assert.deepEqual(Object.keys(doc.rooms), ['r']);
  assert.deepEqual(doc.events.map((e) => e.id), ['e']);
});

test('mergeRooms snapshots rooms with a type emoji and keeps a saved emoji and diary', () => {
  let doc = d.mergeRooms(d.emptyDoc(), [room('a')], tz);
  assert.equal(doc.rooms.a.emoji, '🏃');
  assert.equal(doc.rooms.a.start, '2026-11-15');
  assert.equal(doc.rooms.a.end, '2026-11-17');
  doc = d.applyRecap(doc, 'a', { emoji: '🌅', diary: ['We ran by the sea.', 'Leo had water.', 'Great pace.', 'extra'] });
  assert.equal(doc.rooms.a.emoji, '🌅');
  assert.equal(doc.rooms.a.diary.length, 3);
  doc = d.mergeRooms(doc, [room('a', { name: 'Renamed' })], tz);
  assert.equal(doc.rooms.a.name, 'Renamed');
  assert.equal(doc.rooms.a.emoji, '🌅');
  assert.equal(doc.rooms.a.diary[0], 'We ran by the sea.');
});

test('mergeRooms: an early end becomes the end', () => {
  const doc = d.mergeRooms(d.emptyDoc(), [room('a', { deleted_at: '2026-11-16T03:00:00Z' })], tz);
  assert.equal(doc.rooms.a.end, '2026-11-15');
  assert.equal(doc.rooms.a.endAt, '2026-11-16T03:00:00Z');
});

test('applyRecap: unknown room without data is a no-op; with the room it snapshots; null diary is kept as failed', () => {
  const empty = d.emptyDoc();
  assert.equal(d.applyRecap(empty, 'z', { emoji: '🎉', diary: ['x'] }), empty);
  const doc = d.applyRecap(empty, 'z', { emoji: '🎉', diary: null }, room('z', { type: 'event' }), tz);
  assert.equal(doc.rooms.z.emoji, '🎉');
  assert.equal(doc.rooms.z.diary, null);
});

test('events: check, add, edit, delete', () => {
  assert.equal(d.checkEvent({ title: ' ', start: '2026-11-20', end: '2026-11-20', emoji: '🦷' }), 'title');
  assert.equal(d.checkEvent({ title: 'A', start: '2026-11-21', end: '2026-11-20', emoji: '🦷' }), 'order');
  assert.equal(d.checkEvent({ title: 'A', start: '2026-11-20', end: '2027-11-22', emoji: '🦷' }), 'span');
  assert.equal(d.checkEvent({ title: 'A', start: '2026-11-20', end: '2026-11-20', emoji: '' }), 'emoji');
  let doc = d.upsertEvent(d.emptyDoc(), 'e1', { title: '  Dentist ', start: '2026-11-20', end: '2026-11-20', emoji: '🦷' });
  assert.equal(doc.events[0].title, 'Dentist');
  doc = d.upsertEvent(doc, 'e1', { title: 'Dentist 2', start: '2026-11-20', end: '2026-11-21', emoji: '🦷' });
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].end, '2026-11-21');
  assert.equal(d.deleteEvent(doc, 'e1').events.length, 0);
});

test('calendarItems keeps room and event ids apart', () => {
  let doc = d.mergeRooms(d.emptyDoc(), [room('x')], tz);
  doc = d.upsertEvent(doc, 'x', { title: 'Same id', start: '2026-11-20', end: '2026-11-20', emoji: '📌' });
  assert.deepEqual(d.calendarItems(doc).map((i) => i.id).sort(), ['event:x', 'room:x']);
});

test('clearUserCalendar removes the calendar and the Plus preview keys of that user only', async () => {
  const store = new Map([
    ['qrew.calendar.v1.u1', '{}'], ['qrew.plusPreview.v1.u1', '1'], ['qrew.calendar.v1.u2', '{}'], ['qrew.plusPreview.v1.u2', '1'],
  ]);
  await d.clearUserCalendar({ multiRemove: async (keys) => keys.forEach((k) => store.delete(k)) }, 'u1');
  assert.deepEqual([...store.keys()], ['qrew.calendar.v1.u2', 'qrew.plusPreview.v1.u2']);
});

test('parseCalendarAdd accepts the 200 shape and rejects a bad one', () => {
  assert.deepEqual(d.parseCalendarAdd({ event: { title: 'Dinner with Jun', start: '2026-11-20', end: '2026-11-20', emoji: '🍜' } }), {
    title: 'Dinner with Jun', start: '2026-11-20', end: '2026-11-20', emoji: '🍜',
  });
  assert.equal(d.parseCalendarAdd({ event: { title: 'x', start: '2026-11-21', end: '2026-11-20', emoji: '🍜' } }), null);
  assert.equal(d.parseCalendarAdd(null), null);
});

test('applyRecap: a capped diary (null + fallback emoji) never replaces a saved good diary', () => {
  let doc = d.mergeRooms(d.emptyDoc(), [room('a')], tz);
  doc = d.applyRecap(doc, 'a', { emoji: '🌅', diary: ['We ran by the sea.'] });
  const after = d.applyRecap(doc, 'a', { emoji: '🏃', diary: null });
  assert.equal(after.rooms.a.emoji, '🌅');
  assert.deepEqual(after.rooms.a.diary, ['We ran by the sea.']);
});

test('calendarGate: Free and Plus both get the calendar once signed in (tiers FINAL 2026-11-13 PM)', () => {
  assert.equal(d.calendarGate(true), 'calendar');
  assert.equal(d.calendarGate(false), 'signedOut');
});

test('mayWrite: after sign-out a late write for the old user is skipped; before any auth event it passes', () => {
  assert.equal(d.mayWrite('u1', 'u1', true), true);
  assert.equal(d.mayWrite('u1', null, true), false); // signed out, keys cleared
  assert.equal(d.mayWrite('u1', 'u2', true), false); // another user signed in since
  assert.equal(d.mayWrite('u1', null, false), true); // listener not told yet (cold start)
});
