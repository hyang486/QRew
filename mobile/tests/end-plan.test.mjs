// Run: npm test. Qrew unit 4: End activity / End room confirm gate and single-flight End.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { endGate, runOnce } from '../src/lib/end-plan.ts';

const NOW = Date.UTC(2026, 10, 9, 20);
const room = (over = {}) => ({
  host_id: 'host',
  deleted_at: null,
  expires_at: new Date(NOW + 3_600_000).toISOString(),
  activity_state: 'active',
  ...over,
});

test('endGate: a missing, ended or expired room is gone', () => {
  assert.equal(endGate('room', null, 'host', NOW), 'gone');
  assert.equal(endGate('room', room({ deleted_at: new Date(NOW).toISOString() }), 'host', NOW), 'gone');
  assert.equal(endGate('activity', room({ expires_at: new Date(NOW).toISOString() }), 'host', NOW), 'gone');
});

test('endGate: only the host may end', () => {
  assert.equal(endGate('room', room(), 'guest', NOW), 'not-host');
  assert.equal(endGate('activity', room(), undefined, NOW), 'not-host');
  assert.equal(endGate('room', room(), 'host', NOW), 'ready');
});

test('endGate: End activity needs a running activity; End room does not', () => {
  assert.equal(endGate('activity', room({ activity_state: 'ended' }), 'host', NOW), 'not-running');
  assert.equal(endGate('activity', room({ activity_state: 'idle' }), 'host', NOW), 'not-running');
  assert.equal(endGate('activity', room(), 'host', NOW), 'ready');
  assert.equal(endGate('room', room({ activity_state: 'idle' }), 'host', NOW), 'ready');
});

test('runOnce: a double tap runs the action once', async () => {
  const state = { current: 'idle' };
  let calls = 0;
  let release;
  const action = () => {
    calls += 1;
    return new Promise((resolve) => (release = resolve));
  };
  const first = runOnce(state, action);
  const second = await runOnce(state, action);
  assert.equal(second, false);
  release();
  assert.equal(await first, true);
  assert.equal(await runOnce(state, action), false, 'no second End after success');
  assert.equal(calls, 1);
});

test('runOnce: a failure rethrows and allows a retry', async () => {
  const state = { current: 'idle' };
  await assert.rejects(runOnce(state, () => Promise.reject(new Error('net'))), /net/);
  assert.equal(state.current, 'idle');
  assert.equal(await runOnce(state, () => Promise.resolve()), true);
});
