// Run: npm test. Host-defined entry questions (spec 9.4): editor caps, reorder, required, answer validation that
// mirrors upsert_entry_answers, saved-answer loading and the server error codes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addQuestion,
  answerDraft,
  answersDirty,
  canAdd,
  canRemove,
  defaultDraft,
  DEFAULT_QUESTIONS,
  entryQuestionsErrorKind,
  moveQuestion,
  parseQuestions,
  removeQuestion,
  updateQuestion,
  validateAnswers,
  validateQuestions,
} from '../src/features/event/entry-questions.ts';

test('the editor starts with the default four', () => {
  const d = defaultDraft();
  assert.deepEqual(
    d.map(({ kind, prompt, required }) => ({ kind, prompt, required })),
    DEFAULT_QUESTIONS,
  );
  assert.equal(new Set(d.map((q) => q.key)).size, 4);
  assert.deepEqual(validateQuestions(d), { value: DEFAULT_QUESTIONS });
});

test('add stops at 8, remove stops at 1', () => {
  let d = defaultDraft();
  for (let i = 0; i < 10; i++) d = addQuestion(d, 'short');
  assert.equal(d.length, 8);
  assert.equal(canAdd(d), false);
  assert.equal(d[7].prompt, '');
  assert.equal(d[7].required, false);
  while (d.length > 1) d = removeQuestion(d, d[0].key);
  assert.equal(canRemove(d), false);
  assert.equal(removeQuestion(d, d[0].key), d);
});

test('reorder moves one place and stays put at the ends', () => {
  const d = defaultDraft();
  const [a, b, c, e] = d.map((q) => q.key);
  assert.deepEqual(moveQuestion(d, b, -1).map((q) => q.key), [b, a, c, e]);
  assert.deepEqual(moveQuestion(d, c, 1).map((q) => q.key), [a, b, e, c]);
  assert.equal(moveQuestion(d, a, -1), d);
  assert.equal(moveQuestion(d, e, 1), d);
  assert.equal(moveQuestion(d, 'missing', 1), d);
});

test('prompt rules: trimmed, 1 to 120 chars; required and kind kept', () => {
  let d = defaultDraft();
  const k = d[1].key;
  d = updateQuestion(d, k, { prompt: '   ' });
  assert.deepEqual(validateQuestions(d), { problem: 'promptRequired', key: k });
  d = updateQuestion(d, k, { prompt: 'x'.repeat(121) });
  assert.deepEqual(validateQuestions(d), { problem: 'promptTooLong', key: k });
  d = updateQuestion(d, k, { prompt: `  ${'x'.repeat(120)}  `, required: true, kind: 'short' });
  const r = validateQuestions(d);
  assert.ok('value' in r);
  assert.deepEqual(r.value[1], { kind: 'short', prompt: 'x'.repeat(120), required: true });
  assert.deepEqual(validateQuestions([]), { problem: 'noQuestions' });
  const nine = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, kind: 'short', prompt: 'p', required: false }));
  assert.deepEqual(validateQuestions(nine), { problem: 'tooManyQuestions' });
});

const Q = [
  { id: 'L', position: 3, kind: 'links', prompt: 'Links', required: false },
  { id: 'H', position: 0, kind: 'short', prompt: 'Headline', required: true },
  { id: 'I', position: 1, kind: 'long', prompt: 'Interests', required: false },
];

test('answers: required, caps, https, optional empties left out', () => {
  const draft = answerDraft(Q, null);
  assert.deepEqual(draft, { L: ['', '', ''], H: '', I: '' });
  assert.deepEqual(validateAnswers(Q, draft), { problem: 'required', questionId: 'H' });
  assert.deepEqual(validateAnswers(Q, { ...draft, H: 'x'.repeat(81) }), { problem: 'tooLong', questionId: 'H' });
  assert.deepEqual(validateAnswers(Q, { ...draft, H: 'a', I: 'x'.repeat(301) }), { problem: 'tooLong', questionId: 'I' });
  assert.deepEqual(validateAnswers(Q, { ...draft, H: 'a', L: ['http://x.com', '', ''] }), { problem: 'linkInvalid', questionId: 'L' });
  assert.deepEqual(validateAnswers(Q, { ...draft, H: 'a', L: [`https://${'x'.repeat(193)}`] }), { problem: 'linkInvalid', questionId: 'L' });
  assert.deepEqual(validateAnswers(Q, { ...draft, H: 'a', L: ['https://a', 'https://b', 'https://c', 'https://d'] }), {
    problem: 'tooManyLinks',
    questionId: 'L',
  });
  assert.deepEqual(validateAnswers(Q, { H: ' CS junior ', I: '  ', L: ['', ' https://a.dev ', ''] }), {
    value: { H: 'CS junior', L: ['https://a.dev'] },
  });
});

test('a required links question needs at least one link', () => {
  const q = [{ id: 'L', position: 0, kind: 'links', prompt: 'Portfolio', required: true }];
  assert.deepEqual(validateAnswers(q, answerDraft(q, {})), { problem: 'required', questionId: 'L' });
  assert.deepEqual(validateAnswers(q, { L: ['https://x.dev', '', ''] }), { value: { L: ['https://x.dev'] } });
});

test('saved answers load per question; unknown and wrong-typed values are dropped', () => {
  const d = answerDraft(Q, { H: 'Hi', I: 42, L: ['https://a', 7, 'https://b'], X: 'gone' });
  assert.deepEqual(d, { L: ['https://a', 'https://b', ''], H: 'Hi', I: '' });
  assert.equal(answersDirty(d, structuredClone(d)), false);
  assert.equal(answersDirty(d, { ...d, I: 'new' }), true);
  assert.equal(answersDirty(d, { ...d, L: ['https://a', 'https://b', 'https://c'] }), true);
});

test('server error codes', () => {
  assert.equal(entryQuestionsErrorKind('55000', false), 'locked');
  assert.equal(entryQuestionsErrorKind('42501', false), 'notHost');
  assert.equal(entryQuestionsErrorKind('22023', false), 'invalid');
  assert.equal(entryQuestionsErrorKind('XX000', false), 'failed');
  assert.equal(entryQuestionsErrorKind('55000', true), 'network');
});

test('question rows: malformed dropped, position order', () => {
  const rows = [...Q, { id: 'Z', position: 2, kind: 'video', prompt: 'x' }, null, { id: 1 }];
  assert.deepEqual(parseQuestions(rows).map((q) => q.id), ['H', 'I', 'L']);
  assert.deepEqual(parseQuestions(null), []);
});
