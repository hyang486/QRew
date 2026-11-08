// Run: npm test (node --test, Node 24 strips the .ts types).
// G-1: switching the gallery filter must load the new filter, and a slow fetch for the old
// filter must not overwrite it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLatestLoader, loadLatest } from '../src/lib/latest-load.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('applies the result when the key is unchanged', async () => {
  const applied = [];
  const r = await loadLatest('r|all|u', () => 'r|all|u', async () => ['a'], (o) => applied.push(o));
  assert.equal(r, 'applied');
  assert.deepEqual(applied, [{ ok: true, data: ['a'] }]);
});

test('a slow fetch for the old filter cannot overwrite the new filter', async () => {
  let current = 'r|all|u';
  const applied = [];
  const slowAll = deferred();
  const allRun = loadLatest('r|all|u', () => current, () => slowAll.promise, (o) => applied.push(['all', o]));
  current = 'r|mine|u';
  const mineRun = loadLatest('r|mine|u', () => current, async () => ['mine'], (o) => applied.push(['mine', o]));
  assert.equal(await mineRun, 'applied');
  slowAll.resolve(['all']);
  assert.equal(await allRun, 'stale');
  assert.deepEqual(applied, [['mine', { ok: true, data: ['mine'] }]]);
});

test('errors are applied for the current key and dropped for a stale one', async () => {
  const boom = new Error('x');
  const applied = [];
  assert.equal(await loadLatest('k', () => 'k', async () => { throw boom; }, (o) => applied.push(o)), 'applied');
  assert.deepEqual(applied, [{ ok: false, error: boom }]);
  assert.equal(await loadLatest('k', () => 'other', async () => { throw boom; }, (o) => applied.push(o)), 'stale');
  assert.equal(applied.length, 1);
});

// FG-L1: repeated loads of the face screens (focus, pull, after an action).
test('createLatestLoader applies only the newest of overlapping loads', async () => {
  const run = createLatestLoader();
  const applied = [];
  const slowFocus = deferred();
  const focusRun = run('room|user', () => slowFocus.promise, (o) => applied.push(['focus', o]));
  const pullRun = run('room|user', async () => 'pull', (o) => applied.push(['pull', o]));
  assert.equal(await pullRun, 'applied');
  slowFocus.resolve('focus');
  assert.equal(await focusRun, 'stale');
  assert.deepEqual(applied, [['pull', { ok: true, data: 'pull' }]]);
});

test('createLatestLoader applies sequential loads and drops a stale error', async () => {
  const run = createLatestLoader();
  const applied = [];
  assert.equal(await run('s', async () => 1, (o) => applied.push(o)), 'applied');
  assert.equal(await run('s', async () => 2, (o) => applied.push(o)), 'applied');
  const slowFail = deferred();
  const failRun = run('s', () => slowFail.promise, (o) => applied.push(o));
  const okRun = run('s', async () => 3, (o) => applied.push(o));
  assert.equal(await okRun, 'applied');
  slowFail.reject(new Error('late'));
  assert.equal(await failRun, 'stale');
  assert.deepEqual(applied, [
    { ok: true, data: 1 },
    { ok: true, data: 2 },
    { ok: true, data: 3 },
  ]);
});

test('separate loaders do not interfere', async () => {
  const a = createLatestLoader();
  const b = createLatestLoader();
  const slow = deferred();
  const aRun = a('x', () => slow.promise, () => {});
  assert.equal(await b('x', async () => 1, () => {}), 'applied');
  slow.resolve(0);
  assert.equal(await aRun, 'applied');
});
