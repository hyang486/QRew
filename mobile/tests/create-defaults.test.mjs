// Run: npm test. Running-crew #11: Create room defaults.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRoomHours, formatDeletedAt } from '../src/lib/create-defaults.ts';

test('Sports rooms default to 3 hours, other types to 4 days', () => {
  assert.equal(defaultRoomHours('sports'), 3);
  for (const t of ['event', 'waiting', 'general']) assert.equal(defaultRoomHours(t), 96);
});

test('the deleted-at preview has no seconds', () => {
  const s = formatDeletedAt(Date.parse('2026-11-07T23:54:52'));
  assert.doesNotMatch(s, /:52/);
  assert.match(s, /54/);
});
