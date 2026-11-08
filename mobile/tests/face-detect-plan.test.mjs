// Run: npm test (node --test, Node 24 strips the .ts types). FM-Q A′-2 client planning.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyDetectUpload,
  DETECT_BATCH_SIZE,
  DETECT_LONG_EDGE,
  detectBatches,
  detectResize,
  faceDetectPath,
  mapLimit,
} from '../src/lib/face-plan.ts';

const R = '11111111-1111-4111-8111-111111111111';
const M = '44444444-4444-4444-8444-444444444444';
const E = '33333333-3333-4333-8333-333333333333';

test('faceDetectPath matches the server format and rejects non-UUID segments', () => {
  assert.equal(faceDetectPath(R, M, E), `${R}/${M}/detect/${E}.jpg`);
  assert.equal(faceDetectPath('../x', M, E), null);
  assert.equal(faceDetectPath(R, M, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), null);
});

test('detectResize scales the long edge to 1920 and keeps smaller images', () => {
  assert.equal(DETECT_LONG_EDGE, 1920);
  assert.deepEqual(detectResize(4032, 3024), { width: 1920 });
  assert.deepEqual(detectResize(3024, 4032), { height: 1920 });
  assert.deepEqual(detectResize(4000, 4000), { width: 1920 });
  assert.equal(detectResize(1920, 1080), null);
  assert.equal(detectResize(800, 600), null);
  assert.equal(detectResize(null, 600), null);
  assert.equal(detectResize(NaN, NaN), null);
});

const now = Date.parse('2026-11-07T12:00:00Z');
const j = (id, status, created, extra = {}) => ({ id, media_id: `m${id}`, status, attempts: 0, updated_at: '2026-11-07T11:59:00Z', created_at: created, ...extra });

test('detectBatches: only jobs the function would take, oldest first, in batches of 5', () => {
  assert.equal(DETECT_BATCH_SIZE, 5);
  const jobs = [
    j('b', 'queued', '2026-11-07T10:00:02Z'),
    j('a', 'queued', '2026-11-07T10:00:01Z'),
    j('done', 'done', '2026-11-07T10:00:00Z'),
    j('failed', 'failed', '2026-11-07T10:00:00Z'),
    j('fresh-running', 'running', '2026-11-07T10:00:00Z'),
    j('stale-running', 'running', '2026-11-07T10:00:03Z', { updated_at: '2026-11-07T11:50:00Z', attempts: 1 }),
    j('stale-out', 'running', '2026-11-07T10:00:00Z', { updated_at: '2026-11-07T11:50:00Z', attempts: 3 }),
    j('queued-out', 'queued', '2026-11-07T10:00:00Z', { attempts: 3 }),
    ...['c', 'd', 'e', 'f'].map((id, i) => j(id, 'queued', `2026-11-07T10:00:0${4 + i}Z`)),
  ];
  const batches = detectBatches(jobs, now);
  assert.deepEqual(batches.map((b) => b.map((x) => x.id)), [['a', 'b', 'stale-running', 'c', 'd'], ['e', 'f']]);
  assert.deepEqual(detectBatches([], now), []);
});

test('classifyDetectUpload: success, existing copy (retry), and failures', () => {
  assert.equal(classifyDetectUpload(null), 'uploaded');
  assert.equal(classifyDetectUpload({ statusCode: '409', message: 'The resource already exists' }), 'exists');
  assert.equal(classifyDetectUpload({ status: 409, message: 'Duplicate' }), 'exists');
  assert.equal(classifyDetectUpload({ message: 'The resource already exists' }), 'exists');
  assert.equal(classifyDetectUpload({ statusCode: '403', message: 'new row violates row-level security policy' }), 'failed');
  assert.equal(classifyDetectUpload({ message: 'Network request failed' }), 'failed');
});

test('mapLimit runs at most N at once and keeps order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 * (6 - n)));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
