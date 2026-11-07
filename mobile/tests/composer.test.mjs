// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canSendDraft, composerAutoFocus, composerReducer, initialComposer } from '../src/lib/composer.ts';

test('typing updates the draft of the current input', () => {
  const s = composerReducer(initialComposer, { type: 'change', key: 0, text: 'Ok' });
  assert.deepEqual(s, { draft: 'Ok', key: 0 });
});

test('a send empties the draft and replaces the input', () => {
  const typed = composerReducer(initialComposer, { type: 'change', key: 0, text: 'Ok' });
  assert.deepEqual(composerReducer(typed, { type: 'sent' }), { draft: '', key: 1 });
});

test('a late change from the sent input cannot refill the new one (C-2)', () => {
  const sent = composerReducer({ draft: 'Ok', key: 0 }, { type: 'sent' });
  const late = composerReducer(sent, { type: 'change', key: 0, text: 'ok' });
  assert.equal(late, sent);
  assert.equal(late.draft, '');
});

test('the new input accepts typing after a send', () => {
  const sent = composerReducer({ draft: 'Ok', key: 0 }, { type: 'sent' });
  assert.equal(composerReducer(sent, { type: 'change', key: 1, text: 'Next' }).draft, 'Next');
});

test('an unchanged draft keeps the same state object', () => {
  const s = { draft: 'a', key: 2 };
  assert.equal(composerReducer(s, { type: 'change', key: 2, text: 'a' }), s);
});

test('only a replacement input autofocuses', () => {
  assert.equal(composerAutoFocus(initialComposer), false);
  assert.equal(composerAutoFocus(composerReducer(initialComposer, { type: 'sent' })), true);
});

test('whitespace-only drafts cannot be sent', () => {
  assert.equal(canSendDraft('  \n '), false);
  assert.equal(canSendDraft(' ok '), true);
});
