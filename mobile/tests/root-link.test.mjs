// Run: npm test (node --test, Node 24 strips the .ts types).
// N-1: only the bare root link resets to Rooms; invite links and cold starts pass through.
// P-3: with a modal open, the root link closes it on the way, and a join link opens from the root.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MODAL_ROUTES,
  handleRootLink,
  hasOpenModal,
  isRootLink,
  joinLinkHref,
  rootLinkPlan,
  setRootLinkHandler,
} from '../src/lib/root-link.ts';

const TOKEN = '0123456789abcdef0123456789abcdef0123';

test('root URL forms are root links', () => {
  for (const p of ['moment:///', 'moment://', 'MOMENT:///', 'moment:///?a=1', 'moment:///#x', '/', '', ' moment:/// ']) {
    assert.equal(isRootLink(p), true, p);
  }
});

test('other links are not root links', () => {
  for (const p of [
    'moment://join/abc123',
    'moment:///join/abc123',
    'moment:///room/1',
    '/join/abc',
    'moment://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    'https://example.com/',
    'moment:',
  ]) {
    assert.equal(isRootLink(p), false, p);
  }
});

test('join link forms map to the join/[token] href', () => {
  assert.equal(joinLinkHref(`moment://join/${TOKEN}`), `/join/${TOKEN}`);
  assert.equal(joinLinkHref(`moment:///join/${TOKEN}`), `/join/${TOKEN}`);
  assert.equal(joinLinkHref(`MOMENT://JOIN/${TOKEN}`), `/join/${TOKEN}`);
  assert.equal(joinLinkHref(`/join/${TOKEN}`), `/join/${TOKEN}`);
  assert.equal(joinLinkHref(`moment://join/${TOKEN}/`), `/join/${TOKEN}`);
  assert.equal(joinLinkHref(`moment://join/${TOKEN}?x=1#y`), `/join/${TOKEN}`);
  // An unknown token still opens join/[token], which shows the invalid-invite message.
  assert.equal(joinLinkHref('moment://join/not-a-token'), '/join/not-a-token');
});

test('non-join links have no join href', () => {
  for (const p of [
    'moment:///',
    'moment://join',
    'moment://join/',
    `moment://join/${TOKEN}/extra`,
    'moment:///room/1',
    `https://example.com/join/${TOKEN}`,
    'moment://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    `moment:join/${TOKEN}`,
  ]) {
    assert.equal(joinLinkHref(p), null, p);
  }
});

test('hasOpenModal looks at the active root routes only', () => {
  assert.deepEqual([...MODAL_ROUTES], ['upgrade', 'room/[id]/invite']);
  assert.equal(hasOpenModal(undefined), false);
  assert.equal(hasOpenModal({ index: 0, routes: [{ name: 'index' }] }), false);
  assert.equal(hasOpenModal({ index: 2, routes: [{ name: 'index' }, { name: 'room/[id]/index' }, { name: 'room/[id]/info' }] }), false);
  assert.equal(hasOpenModal({ index: 2, routes: [{ name: 'index' }, { name: 'room/[id]/index' }, { name: 'room/[id]/invite' }] }), true);
  assert.equal(hasOpenModal({ index: 2, routes: [{ name: 'index' }, { name: 'profile' }, { name: 'upgrade' }] }), true);
  // A screen pushed above a modal is still inside it.
  assert.equal(hasOpenModal({ index: 3, routes: [{ name: 'index' }, { name: 'room/[id]/index' }, { name: 'room/[id]/invite' }, { name: 'preview' }] }), true);
  // A preloaded route above the focused one is not open.
  assert.equal(hasOpenModal({ index: 0, routes: [{ name: 'index' }, { name: 'upgrade' }] }), false);
  // No index: the last route is the focused one.
  assert.equal(hasOpenModal({ routes: [{ name: 'index' }, { name: 'upgrade' }] }), true);
});

test('hasOpenModal follows the nested __root state (shape from the P-3 qa log)', () => {
  const wrap = (index, names) => ({ index: 0, routes: [{ name: '__root', state: { index, routes: names.map((name) => ({ name })) } }] });
  assert.equal(hasOpenModal(wrap(2, ['index', 'room/[id]/index', 'room/[id]/invite'])), true);
  assert.equal(hasOpenModal(wrap(2, ['index', 'profile', 'upgrade'])), true);
  assert.equal(hasOpenModal(wrap(2, ['index', 'room/[id]/index', 'room/[id]/info'])), false);
  assert.equal(hasOpenModal(wrap(0, ['index', 'upgrade'])), false);
  assert.equal(hasOpenModal({ index: 0, routes: [{ name: '__root' }] }), false);
  assert.equal(hasOpenModal({ index: 0, routes: [] }), false);
});

test('plan: root link resets, a join link is taken only with a modal open', () => {
  assert.equal(rootLinkPlan('moment:///', false, true), 'reset');
  assert.equal(rootLinkPlan('moment:///', false, true, true), 'reset');
  assert.equal(rootLinkPlan('moment:///', true, true), 'pass');
  assert.equal(rootLinkPlan('moment:///', false, false), 'pass');
  assert.equal(rootLinkPlan('moment://join/abc', false, true), 'pass');
  assert.equal(rootLinkPlan('moment://join/abc', false, true, false), 'pass');
  assert.equal(rootLinkPlan('moment://join/abc', false, true, true), 'join');
  // Cold start and signed out stay on default handling even with a modal.
  assert.equal(rootLinkPlan('moment://join/abc', true, true, true), 'pass');
  assert.equal(rootLinkPlan('moment://join/abc', false, false, true), 'pass');
  // Other links are never taken.
  assert.equal(rootLinkPlan('moment:///room/1', false, true, true), 'pass');
  assert.equal(rootLinkPlan('moment://expo-development-client/?url=x', false, true, true), 'pass');
});

function fakeHandler(modalOpen) {
  const calls = [];
  return {
    calls,
    isModalOpen: () => modalOpen,
    reset: (open) => calls.push(['reset', open]),
    openFromRoot: (href) => calls.push(['openFromRoot', href]),
  };
}

test('no modal: the root link resets (N-1) and a join link passes through', () => {
  const h = fakeHandler(false);
  setRootLinkHandler(h);
  assert.equal(handleRootLink('moment:///', false), true);
  assert.equal(handleRootLink(`moment://join/${TOKEN}`, false), false);
  assert.equal(handleRootLink('moment:///', true), false);
  assert.deepEqual(h.calls, [['reset', false]]);
  setRootLinkHandler(null);
});

test('modal open: the root link resets through it and a join link opens from the root', () => {
  const h = fakeHandler(true);
  setRootLinkHandler(h);
  assert.equal(handleRootLink('moment:///', false), true);
  assert.equal(handleRootLink(`moment://join/${TOKEN}`, false), true);
  assert.equal(handleRootLink('moment:///room/1', false), false);
  assert.equal(handleRootLink(`moment://join/${TOKEN}`, true), false);
  assert.deepEqual(h.calls, [
    ['reset', true],
    ['openFromRoot', `/join/${TOKEN}`],
  ]);
  setRootLinkHandler(null);
});

test('signed out (no handler): every link passes through', () => {
  setRootLinkHandler(null);
  assert.equal(handleRootLink('moment:///', false), false);
  assert.equal(handleRootLink(`moment://join/${TOKEN}`, false), false);
});
