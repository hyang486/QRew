// Run: npm test. Qrew unit 3: chat Ends line day, status picker icons, Emergency card location line.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emergencyLocation, endsDay, statusSymbol } from '../src/lib/chat-plan.ts';

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('endsDay: same local day is today', () => {
  assert.equal(endsDay(at(2026, 11, 9, 22), at(2026, 11, 9, 8)), 'today');
});

test('endsDay: next local day is tomorrow, even across midnight within hours', () => {
  assert.equal(endsDay(at(2026, 11, 10, 1), at(2026, 11, 9, 23)), 'tomorrow');
});

test('endsDay: later days and month change', () => {
  assert.equal(endsDay(at(2026, 11, 12, 9), at(2026, 11, 9, 9)), 'later');
  assert.equal(endsDay(at(2026, 12, 1, 9), at(2026, 11, 30, 9)), 'tomorrow');
});

test('statusSymbol: Emergency always gets the warning triangle', () => {
  assert.equal(statusSymbol('Help me', true), 'exclamationmark.triangle');
  assert.equal(statusSymbol('Anything', true), 'exclamationmark.triangle');
});

test('statusSymbol: Q 03.02 default statuses', () => {
  assert.equal(statusSymbol('Resting', false), 'bed.double');
  assert.equal(statusSymbol('Giving up', false), 'flag.slash');
  assert.equal(statusSymbol('Need water', false), 'drop');
  assert.equal(statusSymbol('Need help', false), 'ellipsis.bubble');
});

test('statusSymbol: case and spacing do not matter, whole words only', () => {
  assert.equal(statusSymbol('  NEED   WATER ', false), 'drop');
  assert.equal(statusSymbol('Waterfall photo stop', false), 'tag');
  assert.equal(statusSymbol('Rest', false), 'bed.double');
  assert.equal(statusSymbol('Interesting', false), 'tag');
});

test('statusSymbol: Korean keywords', () => {
  assert.equal(statusSymbol('휴식 중', false), 'bed.double');
  assert.equal(statusSymbol('물 필요', false), 'drop');
  assert.equal(statusSymbol('도움 필요', false), 'ellipsis.bubble');
  assert.equal(statusSymbol('포기', false), 'flag.slash');
});

test('statusSymbol: other keywords and the generic icon for custom statuses', () => {
  assert.equal(statusSymbol('On my way', false), 'figure.walk');
  assert.equal(statusSymbol('Running late', false), 'clock');
  assert.equal(statusSymbol('Lost', false), 'questionmark.circle');
  assert.equal(statusSymbol('Injured', false), 'bandage');
  assert.equal(statusSymbol('Snack break', false), 'tag');
  assert.equal(statusSymbol('', false), 'tag');
});

test('emergencyLocation: no row means no location shared', () => {
  assert.deepEqual(emergencyLocation(undefined), { kind: 'none' });
});

test('emergencyLocation: a row gives its time and coordinates', () => {
  const row = { lat: 34.05, lng: -118.25, updated_at: '2026-11-09T09:56:00Z' };
  assert.deepEqual(emergencyLocation(row), {
    kind: 'shared',
    updatedAt: '2026-11-09T09:56:00Z',
    coordinates: { latitude: 34.05, longitude: -118.25 },
  });
});

test('emergencyLocation: invalid coordinates read as no location', () => {
  assert.deepEqual(emergencyLocation({ lat: 999, lng: 1, updated_at: '2026-11-09T09:00:00Z' }), { kind: 'none' });
  assert.deepEqual(emergencyLocation({ lat: Number.NaN, lng: 1, updated_at: '2026-11-09T09:00:00Z' }), { kind: 'none' });
});
