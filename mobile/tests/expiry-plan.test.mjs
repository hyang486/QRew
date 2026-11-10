// Run: npm test. Local 24-hour expiry reminder planning.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planReminders, reminderId, REMINDER_WINDOW_MS } from '../src/lib/expiry-plan.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;
// Rooms created 3 days before NOW (24 h-window rooms) unless `createdAgoMs` says otherwise.
const room = (id, expiresInMs, version = 1, createdAgoMs = 3 * 24 * HOUR) => ({
  id,
  name: `Room ${id}`,
  created_at: new Date(NOW - createdAgoMs).toISOString(),
  expires_at: new Date(NOW + expiresInMs).toISOString(),
  expiry_version: version,
});
const scheduledFor = (r, fireAt = Date.parse(r.expires_at) - REMINDER_WINDOW_MS) => ({
  identifier: reminderId(r.id),
  data: { kind: 'expiry', roomId: r.id, expiryVersion: r.expiry_version, expiresAt: r.expires_at, fireAt },
});

test('schedules at expires_at - 24h for a room with more than 24h left', () => {
  const r = room('a', 30 * HOUR);
  const plan = planReminders([r], [], NOW, true);
  assert.deepEqual(plan.cancel, []);
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].identifier, 'expiry-a');
  assert.equal(plan.schedule[0].fireAt, NOW + 30 * HOUR - REMINDER_WINDOW_MS);
});

test('leaves an identical reminder alone (no reschedule on every load)', () => {
  const r = room('a', 30 * HOUR);
  const plan = planReminders([r], [scheduledFor(r)], NOW, true);
  assert.deepEqual(plan, { schedule: [], cancel: [] });
});

test('host changes the expiry: new version replaces the old reminder', () => {
  const old = room('a', 30 * HOUR, 1);
  const moved = room('a', 40 * HOUR, 2);
  const plan = planReminders([moved], [scheduledFor(old)], NOW, false);
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].fireAt, NOW + 40 * HOUR - REMINDER_WINDOW_MS);
});

test('expiry moved inside 24h: the pending reminder is cancelled, nothing scheduled', () => {
  const old = room('a', 30 * HOUR, 1);
  const moved = room('a', 10 * HOUR, 2);
  const plan = planReminders([moved], [scheduledFor(old)], NOW, false);
  assert.deepEqual(plan, { schedule: [], cancel: ['expiry-a'] });
});

test('room with less than 24h left (late joiner): no local schedule', () => {
  assert.deepEqual(planReminders([room('a', 5 * HOUR)], [], NOW, true), { schedule: [], cancel: [] });
});

test('complete list: reminders for rooms no longer listed (left, ended) are cancelled', () => {
  const kept = room('a', 30 * HOUR);
  const left = room('b', 30 * HOUR);
  const plan = planReminders([kept], [scheduledFor(kept), scheduledFor(left), { identifier: 'other', data: null }], NOW, true);
  assert.deepEqual(plan, { schedule: [], cancel: ['expiry-b'] });
});

test('partial list (one room screen) never cancels other rooms', () => {
  const a = room('a', 30 * HOUR);
  const b = room('b', 30 * HOUR);
  assert.deepEqual(planReminders([a], [scheduledFor(a), scheduledFor(b)], NOW, false), { schedule: [], cancel: [] });
});

test('one second before the 24h mark still schedules; at the mark it does not', () => {
  assert.equal(planReminders([room('a', REMINDER_WINDOW_MS + 1000)], [], NOW, true).schedule.length, 1);
  assert.equal(planReminders([room('a', REMINDER_WINDOW_MS)], [], NOW, true).schedule.length, 0);
});

// Running-crew #9: in-room "Room ends soon" banner window.
import { endsSoonWindowMs, showEndsSoon, SHORT_ROOM_BANNER_MS } from '../src/lib/expiry-plan.ts';

const iso = (ms) => new Date(ms).toISOString();

test('a 3 h room shows the banner only in the last hour', () => {
  const created = NOW;
  const expires = NOW + 3 * HOUR;
  assert.equal(endsSoonWindowMs(iso(created), iso(expires)), SHORT_ROOM_BANNER_MS);
  assert.equal(showEndsSoon(iso(created), iso(expires), created + 1000), false);
  assert.equal(showEndsSoon(iso(created), iso(expires), expires - HOUR - 1000), false);
  assert.equal(showEndsSoon(iso(created), iso(expires), expires - HOUR + 1000), true);
  assert.equal(showEndsSoon(iso(created), iso(expires), expires - 1000), true);
});

test('a 1 day room keeps the 24 h window, even when created_at is a little later than the client time', () => {
  const expires = NOW + 24 * HOUR;
  assert.equal(endsSoonWindowMs(iso(NOW), iso(expires)), REMINDER_WINDOW_MS);
  assert.equal(endsSoonWindowMs(iso(NOW + 3000), iso(expires)), REMINDER_WINDOW_MS);
  assert.equal(showEndsSoon(iso(NOW + 3000), iso(expires), NOW + 5000), true);
});

test('longer rooms show the banner in the last 24 h only', () => {
  const expires = NOW + 96 * HOUR;
  assert.equal(showEndsSoon(iso(NOW), iso(expires), expires - 25 * HOUR), false);
  assert.equal(showEndsSoon(iso(NOW), iso(expires), expires - 23 * HOUR), true);
});

test('an ended room or bad dates show no banner', () => {
  const expires = NOW + 3 * HOUR;
  assert.equal(showEndsSoon(iso(NOW), iso(expires), expires), false);
  assert.equal(showEndsSoon(iso(NOW), iso(expires), expires + HOUR), false);
  assert.equal(showEndsSoon('not a date', iso(expires), expires - 1000), true);
  assert.equal(showEndsSoon(iso(NOW), 'not a date', NOW), false);
});

// G6b: the reminder follows the banner window (human decision 2026-11-08).
test('G6b: a 3 h room is reminded 1 h before its end, not 24 h before', () => {
  const r = room('s', 3 * HOUR, 1, 0);
  const plan = planReminders([r], [], NOW, true);
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].fireAt, NOW + 2 * HOUR);
});

test('G6b: a 1-day room created with clock lag (23 h 55 min long) keeps the 24 h reminder', () => {
  // Created 10 min before NOW, 23 h 45 min left: 23 h 55 min long, inside the 10 min margin, so a 24 h room.
  const lag = room('lag', 23 * HOUR + 45 * 60 * 1000, 1, 10 * 60 * 1000);
  // Its 24 h reminder time (NOW - 15 min) has passed: nothing is scheduled. Were it treated as short, the
  // reminder would be scheduled at NOW + 22 h 45 min.
  assert.deepEqual(planReminders([lag], [], NOW, true).schedule, []);
  // Two days long: the reminder is 24 h before the end.
  const long = room('long', 2 * 24 * HOUR, 1, 0);
  assert.equal(planReminders([long], [], NOW, true).schedule[0].fireAt, NOW + 24 * HOUR);
});

test('G6b: a 23 h room is short (last hour); one 1 min over the 10 min margin is short too', () => {
  const r = room('a', 23 * HOUR, 1, 0);
  assert.equal(planReminders([r], [], NOW, true).schedule[0].fireAt, NOW + 22 * HOUR);
  const edge = room('b', 23 * HOUR + 49 * 60 * 1000, 1, 0);
  assert.equal(planReminders([edge], [], NOW, true).schedule[0].fireAt, NOW + 22 * HOUR + 49 * 60 * 1000);
});

test('G6b: a reminder scheduled before G6b (no fireAt) is rescheduled to the new time', () => {
  const r = room('s', 3 * HOUR, 1, 0);
  const old = { identifier: reminderId(r.id), data: { kind: 'expiry', roomId: r.id, expiryVersion: 1, expiresAt: r.expires_at } };
  const plan = planReminders([r], [old], NOW, true);
  assert.equal(plan.schedule.length, 1);
  assert.equal(plan.schedule[0].fireAt, NOW + 2 * HOUR);
  // Once rescheduled (fireAt stored), it is left alone.
  assert.deepEqual(planReminders([r], [scheduledFor(r, NOW + 2 * HOUR)], NOW, true), { schedule: [], cancel: [] });
});

test('G6b: inside its last hour a short room schedules nothing (the banner covers it)', () => {
  assert.deepEqual(planReminders([room('s', 30 * 60 * 1000, 1, 2.5 * HOUR)], [], NOW, true), { schedule: [], cancel: [] });
});

test('closesSoonMinutes: only in the last hour, rounded up, never 0 while open', async () => {
  const { closesSoonMinutes, CLOSES_SOON_MS } = await import('../src/lib/expiry-plan.ts');
  const now = Date.UTC(2026, 10, 9, 21);
  const at = (ms) => new Date(now + ms).toISOString();
  assert.equal(CLOSES_SOON_MS, 60 * 60 * 1000);
  assert.equal(closesSoonMinutes(at(2 * 3_600_000), now), null);
  assert.equal(closesSoonMinutes(at(3_600_000 + 1), now), null);
  assert.equal(closesSoonMinutes(at(3_600_000), now), 60);
  assert.equal(closesSoonMinutes(at(57 * 60_000), now), 57);
  assert.equal(closesSoonMinutes(at(56 * 60_000 + 1), now), 57);
  assert.equal(closesSoonMinutes(at(1_000), now), 1);
  assert.equal(closesSoonMinutes(at(0), now), null);
  assert.equal(closesSoonMinutes(at(-60_000), now), null);
  assert.equal(closesSoonMinutes('not a date', now), null);
});
