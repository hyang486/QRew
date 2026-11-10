// Run: npm test. Qrew unit 5 (Q 05.03, 05.04): media title and the one-time "Original saved" card.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mediaTitle, noteSaved, takeSaved } from '../src/lib/media-plan.ts';

const labels = { video: 'Video', photo: 'Photo' };

test('mediaTitle: no invented titles; video and photo by kind, a file by its name', () => {
  assert.equal(mediaTitle({ kind: 'video', file_name: 'IMG_0001.MOV' }, labels), 'Video');
  assert.equal(mediaTitle({ kind: 'photo', file_name: 'IMG_0002.HEIC' }, labels), 'Photo');
  assert.equal(mediaTitle({ kind: 'file', file_name: 'route.gpx' }, labels), 'route.gpx');
});

test('takeSaved: true once per save, per room', () => {
  assert.equal(takeSaved('a'), false);
  noteSaved('a');
  assert.equal(takeSaved('b'), false);
  assert.equal(takeSaved('a'), true);
  assert.equal(takeSaved('a'), false);
  noteSaved('a');
  noteSaved('a');
  assert.equal(takeSaved('a'), true);
  assert.equal(takeSaved('a'), false);
});

test('sharedAge: largest whole unit, at least 1 sec, null for a bad date', async () => {
  const { sharedAge } = await import('../src/lib/media-plan.ts');
  const now = Date.UTC(2026, 10, 9, 21);
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.deepEqual(sharedAge(ago(18_000), now), { n: 18, unit: 'sec' });
  assert.deepEqual(sharedAge(ago(0), now), { n: 1, unit: 'sec' });
  assert.deepEqual(sharedAge(ago(-5_000), now), { n: 1, unit: 'sec' });
  assert.deepEqual(sharedAge(ago(59_999), now), { n: 59, unit: 'sec' });
  assert.deepEqual(sharedAge(ago(60_000), now), { n: 1, unit: 'min' });
  assert.deepEqual(sharedAge(ago(59 * 60_000 + 59_000), now), { n: 59, unit: 'min' });
  assert.deepEqual(sharedAge(ago(3_600_000), now), { n: 1, unit: 'hr' });
  assert.deepEqual(sharedAge(ago(25 * 3_600_000), now), { n: 1, unit: 'day' });
  assert.deepEqual(sharedAge(ago(72 * 3_600_000), now), { n: 3, unit: 'day' });
  assert.equal(sharedAge('nope', now), null);
});
