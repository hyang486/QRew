// Run: npm test (node --test, Node 24 strips the .ts types).
// Item 10 (option A): a signed-out invite (code, QR or link) is held through the name / sign-in step and
// opened once, right after sign-in. Module state is shared, so every test starts by draining it.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  isValidInvite,
  openInvite,
  parseInvite,
  resumePendingInvite,
  setPendingInvite,
  takePendingInvite,
} from '../src/lib/invite.ts';

const TOKEN = 'a'.repeat(36);

function fakeNav() {
  const calls = [];
  return { calls, preview: (invite) => calls.push(['preview', invite]), name: () => calls.push(['name']) };
}

beforeEach(() => takePendingInvite());

test('signed out, a code is held and the name step opens; nothing is previewed yet', () => {
  const nav = fakeNav();
  openInvite({ code: '12345' }, false, nav);
  assert.deepEqual(nav.calls, [['name']]);
  assert.deepEqual(takePendingInvite(), { code: '12345' });
});

test('signed out, a scanned QR token is held the same way', () => {
  const nav = fakeNav();
  openInvite(parseInvite(`moment://join/${TOKEN.toUpperCase()}`), false, nav);
  assert.deepEqual(nav.calls, [['name']]);
  assert.deepEqual(takePendingInvite(), { token: TOKEN });
});

test('signed in, the preview opens directly and nothing is held', () => {
  const nav = fakeNav();
  openInvite({ token: TOKEN }, true, nav);
  assert.deepEqual(nav.calls, [['preview', { token: TOKEN }]]);
  assert.equal(takePendingInvite(), null);
});

test('after sign-in, Rooms opens the held invite exactly once (no double join)', () => {
  setPendingInvite({ code: '54321' });
  const opened = [];
  assert.equal(resumePendingInvite((i) => opened.push(i)), true);
  // A second focus of Rooms (back from the preview, another sign-in event) opens nothing.
  assert.equal(resumePendingInvite((i) => opened.push(i)), false);
  assert.deepEqual(opened, [{ code: '54321' }]);
});

test('leaving the name step keeps the invite for a later sign-in', () => {
  openInvite({ token: TOKEN }, false, fakeNav());
  // The user goes back from the name step; nothing takes the invite until Rooms after a sign-in.
  const opened = [];
  resumePendingInvite((i) => opened.push(i));
  assert.deepEqual(opened, [{ token: TOKEN }]);
});

test('a newer invite replaces the held one', () => {
  openInvite({ code: '11111' }, false, fakeNav());
  openInvite({ code: '22222' }, false, fakeNav());
  assert.deepEqual(takePendingInvite(), { code: '22222' });
});

test('a malformed invite is not held and does not replace a valid one', () => {
  assert.equal(setPendingInvite({ code: '12a45' }), false);
  assert.equal(setPendingInvite({ token: 'not-a-token' }), false);
  assert.equal(takePendingInvite(), null);
  setPendingInvite({ code: '12345' });
  setPendingInvite({ token: 'xyz' });
  assert.deepEqual(takePendingInvite(), { code: '12345' });
});

test('a link token is stored lower-case', () => {
  assert.equal(setPendingInvite({ token: TOKEN.toUpperCase() }), true);
  assert.deepEqual(takePendingInvite(), { token: TOKEN });
});

test('nothing held: Rooms loads normally', () => {
  assert.equal(resumePendingInvite(() => assert.fail('should not open')), false);
});

test('invite validation and QR parsing', () => {
  assert.equal(isValidInvite({ code: '00000' }), true);
  assert.equal(isValidInvite({ code: '0000' }), false);
  assert.equal(isValidInvite({ token: TOKEN }), true);
  assert.deepEqual(parseInvite(' 12345 '), { code: '12345' });
  assert.equal(parseInvite('https://example.com/join/' + TOKEN), null);
});
