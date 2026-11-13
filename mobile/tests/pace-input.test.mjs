// Run: npm test. Pace maker target input (spec 3.4: a target pace or a target time for a distance).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDuration, parseDuration, parseKm, parsePace } from '../src/features/pace/pace-core.ts';

test('pace input m:ss', () => {
  assert.equal(parsePace('5:30'), 330);
  assert.equal(parsePace(' 12:05 '), 725);
  assert.equal(parsePace('5:60'), null);
  assert.equal(parsePace('0:45'), null);
  assert.equal(parsePace('530'), null);
  assert.equal(parsePace(''), null);
});

test('duration input mm:ss or h:mm:ss', () => {
  assert.equal(parseDuration('50:00'), 3000);
  assert.equal(parseDuration('1:45:00'), 6300);
  assert.equal(parseDuration('1:75:00'), null);
  assert.equal(parseDuration('0:00'), null);
  assert.equal(parseDuration('abc'), null);
});

test('distance input in km', () => {
  assert.equal(parseKm('10'), 10_000);
  assert.equal(parseKm('21.1'), 21_100);
  assert.equal(parseKm('21,1'), 21_100);
  assert.equal(parseKm('0'), null);
  assert.equal(parseKm('x'), null);
});

test('duration display', () => {
  assert.equal(formatDuration(725), '12:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(0), '0:00');
});
