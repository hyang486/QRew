// Run: npm test. Local 24-hour expiry reminder planning.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planReminders, reminderId, REMINDER_WINDOW_MS } from '../src/lib/expiry-plan.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const room = (id, expiresInMs, version = 1) => ({
  id,
  name: `Room ${id}`,
  expires_at: new Date(NOW + expiresInMs).toISOString(),
  expiry_version: version,
});
const scheduledFor = (r) => ({
  identifier: reminderId(r.id),
  data: { kind: 'expiry', roomId: r.id, expiryVersion: r.expiry_version, expiresAt: r.expires_at },
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
