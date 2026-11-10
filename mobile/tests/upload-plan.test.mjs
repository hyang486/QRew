// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyProgress,
  isAbortError,
  nextQueued,
  patchJob,
  removeJob,
  requeue,
  roomIdle,
  roomSummary,
  sharedBody,
} from '../src/lib/upload-plan.ts';

const job = (id, roomId, state, progress = 0, error) => ({ id, roomId, state, progress, error });

test('nextQueued picks the oldest queued job and skips failed and uploading ones', () => {
  const jobs = [job('a', 'r', 'failed'), job('b', 'r', 'uploading'), job('c', 'r', 'queued'), job('d', 's', 'queued')];
  assert.equal(nextQueued(jobs)?.id, 'c');
  assert.equal(nextQueued([job('a', 'r', 'failed')]), undefined);
});

test('requeue resets only a failed job', () => {
  const jobs = [job('a', 'r', 'failed', 0.4, 'HTTP 500'), job('b', 'r', 'uploading', 0.5)];
  const next = requeue(jobs, 'a');
  assert.deepEqual(next[0], { id: 'a', roomId: 'r', state: 'queued', progress: 0, error: undefined });
  assert.equal(requeue(next, 'b'), next, 'uploading job is untouched');
  assert.equal(requeue(next, 'missing'), next);
});

test('applyProgress ignores late callbacks for cancelled, failed or finished jobs', () => {
  const jobs = [job('a', 'r', 'uploading', 0.2), job('b', 'r', 'failed', 0.3, 'x')];
  assert.equal(applyProgress(jobs, 'a', 0.5)[0].progress, 0.5);
  assert.equal(applyProgress(jobs, 'b', 0.9), jobs, 'failed job keeps its state');
  assert.equal(applyProgress(removeJob(jobs, 'a'), 'a', 0.9).length, 1, 'removed job is not revived');
});

test('applyProgress clamps, never moves backwards, and ignores non-finite values', () => {
  const jobs = [job('a', 'r', 'uploading', 0.6)];
  assert.equal(applyProgress(jobs, 'a', 0.3), jobs);
  assert.equal(applyProgress(jobs, 'a', Number.NaN), jobs);
  assert.equal(applyProgress(jobs, 'a', 7)[0].progress, 1);
});

test('patchJob and removeJob return the same array when nothing changes', () => {
  const jobs = [job('a', 'r', 'queued')];
  assert.equal(patchJob(jobs, 'x', { progress: 1 }), jobs);
  assert.equal(removeJob(jobs, 'x'), jobs);
  assert.deepEqual(removeJob(jobs, 'a'), []);
});

test('roomSummary counts one room only', () => {
  const jobs = [
    job('a', 'r', 'uploading', 0.25),
    job('b', 'r', 'queued'),
    job('c', 'r', 'failed', 0, 'x'),
    job('d', 's', 'failed', 0, 'x'),
  ];
  assert.deepEqual(roomSummary(jobs, 'r'), { pending: 2, failed: 1, progress: 0.25 });
  assert.deepEqual(roomSummary(jobs, 's'), { pending: 0, failed: 1, progress: null });
  assert.deepEqual(roomSummary([], 'r'), { pending: 0, failed: 0, progress: null });
});

test('isAbortError recognises AbortError only', () => {
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(new Error('AbortError')), false);
  assert.equal(isAbortError(null), false);
});

test('roomIdle: only queued or uploading jobs of that room keep a batch open (#8)', () => {
  const jobs = [
    { id: 'a', roomId: 'r1', state: 'failed', progress: 0 },
    { id: 'b', roomId: 'r2', state: 'uploading', progress: 0.5 },
  ];
  assert.equal(roomIdle(jobs, 'r1'), true);
  assert.equal(roomIdle(jobs, 'r2'), false);
  assert.equal(roomIdle([...jobs, { id: 'c', roomId: 'r1', state: 'queued', progress: 0 }], 'r1'), false);
});

test('sharedBody: counts by kind, singular and plural, none for an empty batch (#8)', () => {
  assert.equal(sharedBody(['photo', 'photo', 'photo']), 'shared 3 photos');
  assert.equal(sharedBody(['file']), 'shared a file');
  assert.equal(sharedBody(['video', 'photo', 'photo']), 'shared 2 photos and a video');
  assert.equal(sharedBody(['file', 'video', 'photo', 'file']), 'shared a photo, a video and 2 files');
  assert.equal(sharedBody([]), null);
});
