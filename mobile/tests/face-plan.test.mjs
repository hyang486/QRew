// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyMatchRun,
  createMatchRunCache,
  FACE_REF_WIDTH,
  faceJobCounts,
  faceRefResize,
  faceViewState,
  photosOfMe,
  shouldRunMatch,
} from '../src/lib/face-plan.ts';

const NOW = Date.parse('2026-11-06T22:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const photo = (id, extra = {}) => ({ id, kind: 'photo', status: 'ready', ...extra });

test('photosOfMe keeps ready photos I matched and did not exclude, in media order', () => {
  const media = [
    photo('a'),
    photo('b'),
    photo('c'),
    { id: 'v', kind: 'video', status: 'ready' },
    photo('p', { status: 'uploading' }),
    photo('d'),
  ];
  const matches = [
    { media_id: 'c', matched: true, excluded: false },
    { media_id: 'a', matched: true, excluded: false },
    { media_id: 'b', matched: false, excluded: false },
    { media_id: 'd', matched: true, excluded: true },
    { media_id: 'v', matched: true, excluded: false },
    { media_id: 'p', matched: true, excluded: false },
  ];
  assert.deepEqual(
    photosOfMe(media, matches).map((m) => m.id),
    ['a', 'c'],
  );
  assert.deepEqual(photosOfMe(media, []), []);
});

test('faceJobCounts: queued and fresh running are pending; failed and abandoned running are failed', () => {
  const jobs = [
    { status: 'queued', attempts: 0, updated_at: ago(30) },
    { status: 'running', attempts: 1, updated_at: ago(1) },
    { status: 'running', attempts: 1, updated_at: ago(10) }, // retaken by the next run
    { status: 'running', attempts: 3, updated_at: ago(10) }, // out of attempts, never retaken
    { status: 'running', attempts: 3, updated_at: ago(1) }, // last attempt still in progress
    { status: 'failed', attempts: 1, updated_at: ago(1) },
    { status: 'done', attempts: 1, updated_at: ago(1) },
  ];
  assert.deepEqual(faceJobCounts(jobs, NOW), { pending: 4, failed: 2 });
  assert.deepEqual(faceJobCounts([], NOW), { pending: 0, failed: 0 });
});

test('classifyMatchRun maps the face-match response', () => {
  assert.deepEqual(classifyMatchRun({ status: 200 }), { kind: 'ok' });
  assert.deepEqual(classifyMatchRun({ status: 503, error: 'face_match_disabled' }), { kind: 'disabled' });
  assert.deepEqual(classifyMatchRun({ status: 503, error: 'aws_not_configured' }), {
    kind: 'error',
    message: 'aws_not_configured',
  });
  assert.deepEqual(classifyMatchRun({ status: 0, error: 'Network request failed' }), {
    kind: 'error',
    message: 'Network request failed',
  });
  assert.deepEqual(classifyMatchRun({ status: 500 }), { kind: 'error', message: 'HTTP 500' });
});

test('faceViewState: no enrollment always means consent, whatever the last run said', () => {
  assert.equal(faceViewState({ enrolled: false, run: { kind: 'disabled' }, pending: 3 }), 'consent');
});

test('faceViewState: disabled and error win over pending; otherwise checking or ready', () => {
  assert.equal(faceViewState({ enrolled: true, run: { kind: 'disabled' }, pending: 2 }), 'disabled');
  assert.equal(faceViewState({ enrolled: true, run: { kind: 'error', message: 'x' }, pending: 2 }), 'error');
  assert.equal(faceViewState({ enrolled: true, run: { kind: 'ok' }, pending: 2 }), 'checking');
  assert.equal(faceViewState({ enrolled: true, run: null, pending: 2 }), 'checking');
  assert.equal(faceViewState({ enrolled: true, run: { kind: 'ok' }, pending: 0 }), 'ready');
  assert.equal(faceViewState({ enrolled: true, run: null, pending: 0 }), 'ready');
});

test('shouldRunMatch (FG-2): only right after enrolling or while jobs are pending', () => {
  assert.equal(shouldRunMatch(true, 0), true);
  assert.equal(shouldRunMatch(false, 2), true);
  assert.equal(shouldRunMatch(false, 0), false);
});

test('faceRefResize: references up to the limit keep their size, never an empty resize (F7-1)', () => {
  assert.equal(faceRefResize(800), null); // QA-pattern.jpg
  assert.equal(faceRefResize(FACE_REF_WIDTH), null);
  assert.equal(faceRefResize(1), null);
});

test('faceRefResize: wider references are scaled down to the limit', () => {
  assert.deepEqual(faceRefResize(4032), { width: FACE_REF_WIDTH }); // typical iPhone camera JPEG/HEIC
  assert.deepEqual(faceRefResize(FACE_REF_WIDTH + 1), { width: FACE_REF_WIDTH });
});

test('faceRefResize: an unknown or invalid width keeps the size', () => {
  for (const w of [0, -5, NaN, Infinity, null, undefined]) assert.equal(faceRefResize(w), null);
});

test('match run cache: a run made elsewhere is readable for that room only (F7-2)', () => {
  const cache = createMatchRunCache();
  assert.equal(cache.get('r1'), null);
  cache.set('r1', { kind: 'disabled' });
  assert.deepEqual(cache.get('r1'), { kind: 'disabled' });
  assert.equal(cache.get('r3'), null);
});

test('match run cache: a newer run replaces the old one', () => {
  const cache = createMatchRunCache();
  cache.set('r1', { kind: 'disabled' });
  cache.set('r1', { kind: 'ok' });
  assert.deepEqual(cache.get('r1'), { kind: 'ok' });
  cache.set('r1', { kind: 'error', message: 'HTTP 500' });
  assert.equal(cache.get('r1').kind, 'error');
});

test('match run cache: clear forgets one room and keeps the others', () => {
  const cache = createMatchRunCache();
  cache.set('r1', { kind: 'disabled' });
  cache.set('r2', { kind: 'ok' });
  cache.clear('r1');
  assert.equal(cache.get('r1'), null);
  assert.deepEqual(cache.get('r2'), { kind: 'ok' });
});

test('a cached disabled run shows the disabled notice once enrolled, even with nothing pending (F7-2)', () => {
  const cache = createMatchRunCache();
  cache.set('r1', { kind: 'disabled' });
  assert.equal(faceViewState({ enrolled: true, run: cache.get('r1'), pending: 0 }), 'disabled');
  assert.equal(faceViewState({ enrolled: false, run: cache.get('r1'), pending: 0 }), 'consent');
});
