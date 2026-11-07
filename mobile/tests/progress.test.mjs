// Run: npm test (node --test, Node 24 strips the .ts types).
// expo-file-system emits native progress byte counts as Swift Int64, which expo-modules-core
// encodes as a JS BigInt (the TS types say number). Mixing a BigInt with a number throws.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { progressFraction } from '../src/lib/progress.ts';

test('BigInt byte counts give a plain number fraction', () => {
  const f = progressFraction(1n, 4n);
  assert.equal(typeof f, 'number');
  assert.equal(f, 0.25);
  // The original failures: f * 0.97 (upload) and f * 100 (download) threw for a BigInt f.
  assert.equal(0.02 + progressFraction(5927272n, 5927272n) * 0.97, 0.99);
  assert.equal(Math.round(progressFraction(2n, 3n) * 100), 67);
});

test('number byte counts (JS-emitted final event) still work', () => {
  assert.equal(progressFraction(50, 100), 0.5);
  assert.equal(progressFraction(100, 100), 1);
});

test('mixed BigInt and number inputs do not throw', () => {
  assert.equal(progressFraction(3n, 4), 0.75);
  assert.equal(progressFraction(3, 4n), 0.75);
});

test('unknown or invalid totals yield null; result is clamped to [0, 1]', () => {
  assert.equal(progressFraction(10n, 0n), null);
  assert.equal(progressFraction(10, -1), null);
  assert.equal(progressFraction(10, undefined), null);
  assert.equal(progressFraction(10, Number.NaN), null);
  assert.equal(progressFraction(150n, 100n), 1);
  assert.equal(progressFraction(-5, 100), 0);
});
