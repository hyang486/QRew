// Run: npm test (node --test, Node 24 strips the .ts types).
// C-3: a reminder tap returns to the root (dismissing any modal) before pushing the room.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pushFromRoot, resetToRoot } from '../src/lib/root-nav.ts';

function fakeRouter(canDismiss) {
  const calls = [];
  return {
    calls,
    canDismiss: () => canDismiss,
    dismissAll: () => calls.push('dismissAll'),
    push: (href) => calls.push(['push', href]),
  };
}

const href = { pathname: '/room/[id]', params: { id: 'r1', from: 'reminder' } };

test('dismisses to the root first when screens or a modal are above Rooms', () => {
  const r = fakeRouter(true);
  pushFromRoot(r, href);
  assert.deepEqual(r.calls, ['dismissAll', ['push', href]]);
});

test('pushes directly when already at the root', () => {
  const r = fakeRouter(false);
  pushFromRoot(r, href);
  assert.deepEqual(r.calls, [['push', href]]);
});

test('P-3: a join link with a modal open is pushed from the root', () => {
  const r = fakeRouter(true);
  pushFromRoot(r, '/join/abc');
  assert.deepEqual(r.calls, ['dismissAll', ['push', '/join/abc']]);
});

// P-3: a warm root link with a modal open closes it the C-3 way before N-1's dismissTo.
function fakeResetRouter(canDismiss) {
  const calls = [];
  return {
    calls,
    canDismiss: () => canDismiss,
    dismissAll: () => calls.push('dismissAll'),
    dismissTo: (to) => calls.push(['dismissTo', to]),
  };
}

test('resetToRoot without a modal is N-1 unchanged (dismissTo only)', () => {
  const r = fakeResetRouter(true);
  resetToRoot(r, '/', false);
  assert.deepEqual(r.calls, [['dismissTo', '/']]);
});

test('resetToRoot with a modal open dismisses all first', () => {
  const r = fakeResetRouter(true);
  resetToRoot(r, '/', true);
  assert.deepEqual(r.calls, ['dismissAll', ['dismissTo', '/']]);
});

test('resetToRoot skips dismissAll when nothing can be dismissed', () => {
  const r = fakeResetRouter(false);
  resetToRoot(r, '/', true);
  assert.deepEqual(r.calls, [['dismissTo', '/']]);
});
