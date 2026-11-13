// Run: npm test. Client answer and question validation as one table against the server rules in spec 9.1/9.2
// (upsert_entry_answers and set_entry_questions, 22023). `ok` is the server's verdict; the client must never send
// what the server rejects, and must not reject what the server accepts unless noted as stricter.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANSWER_LIMITS,
  DEFAULT_QUESTIONS,
  QUESTION_LIMITS,
  validateAnswers,
  validateQuestions,
} from '../src/features/event/entry-questions.ts';

const S = 'q-short';
const L = 'q-long';
const K = 'q-links';
const QUESTIONS = [
  { id: K, position: 2, kind: 'links', prompt: 'Links', required: false },
  { id: S, position: 0, kind: 'short', prompt: 'Headline', required: true },
  { id: L, position: 1, kind: 'long', prompt: 'Interests', required: false },
];
const x = (n) => 'x'.repeat(n);
const url = (n) => `https://${x(n - 8)}`;
const links = (...l) => [...l, '', '', ''].slice(0, Math.max(ANSWER_LIMITS.links, l.length));

// [name, draft, server ok, expected problem when not ok]
const ANSWER_CASES = [
  ['required only', { [S]: 'hi' }, true],
  ['short at 80', { [S]: x(80) }, true],
  ['short at 81', { [S]: x(81) }, false, 'tooLong'],
  ['short trimmed to 80', { [S]: `  ${x(80)}  ` }, true],
  ['long at 300', { [S]: 'a', [L]: x(300) }, true],
  ['long at 301', { [S]: 'a', [L]: x(301) }, false, 'tooLong'],
  ['required missing', {}, false, 'required'],
  ['required blank', { [S]: '   ' }, false, 'required'],
  ['required given a wrong type', { [S]: ['a'] }, false, 'required'],
  ['optional blank', { [S]: 'a', [L]: '  ' }, true],
  ['3 links', { [S]: 'a', [K]: links('https://a.b', 'https://c.d', 'https://e.f') }, true],
  ['4 links', { [S]: 'a', [K]: ['https://a.b', 'https://c.d', 'https://e.f', 'https://g.h'] }, false, 'tooManyLinks'],
  ['http link', { [S]: 'a', [K]: links('http://a.b') }, false, 'linkInvalid'],
  ['no scheme', { [S]: 'a', [K]: links('a.b') }, false, 'linkInvalid'],
  ['uppercase scheme', { [S]: 'a', [K]: links('HTTPS://a.b') }, false, 'linkInvalid'],
  ['link at 200', { [S]: 'a', [K]: links(url(200)) }, true],
  ['link at 201', { [S]: 'a', [K]: links(url(201)) }, false, 'linkInvalid'],
  ['blank links dropped', { [S]: 'a', [K]: links('  ', '') }, true],
];

for (const [name, draft, ok, problem] of ANSWER_CASES) {
  test(`answers: ${name}`, () => {
    const r = validateAnswers(QUESTIONS, draft);
    if (ok) {
      assert.ok('value' in r, JSON.stringify(r));
    } else {
      assert.deepEqual(Object.keys(r).sort(), ['problem', 'questionId']);
      assert.equal(r.problem, problem);
    }
  });
}

test('answers: what is sent passes every server rule (ids, types, trims, no empties)', () => {
  const r = validateAnswers(QUESTIONS, {
    [S]: ' hi ',
    [L]: '',
    [K]: links(' https://a.b ', ''),
    'q-unknown': 'dropped',
  });
  assert.ok('value' in r);
  // Unknown ids (server 22023) are never sent; only known ids with the server's value types.
  assert.deepEqual(r.value, { [S]: 'hi', [K]: ['https://a.b'] });
});

test('answers: the first problem is in position order, not fetch order', () => {
  const r = validateAnswers(QUESTIONS, { [S]: '', [K]: links('http://a') });
  assert.deepEqual(r, { problem: 'required', questionId: S });
});

// [name, list, server ok, expected problem]
const q = (o = {}) => ({ key: `k${Math.random()}`, kind: 'short', prompt: 'P', required: false, ...o });
const QUESTION_CASES = [
  ['0 questions', [], false, 'noQuestions'],
  ['1 question', [q()], true],
  [`${QUESTION_LIMITS.max} questions`, Array.from({ length: QUESTION_LIMITS.max }, () => q()), true],
  [`${QUESTION_LIMITS.max + 1} questions`, Array.from({ length: QUESTION_LIMITS.max + 1 }, () => q()), false, 'tooManyQuestions'],
  ['prompt blank after trim', [q({ prompt: '   ' })], false, 'promptRequired'],
  ['prompt 120 after trim', [q({ prompt: ` ${x(120)} ` })], true],
  ['prompt 121', [q({ prompt: x(121) })], false, 'promptTooLong'],
];

for (const [name, list, ok, problem] of QUESTION_CASES) {
  test(`questions: ${name}`, () => {
    const r = validateQuestions(list);
    if (ok) assert.ok('value' in r, JSON.stringify(r));
    else assert.equal(r.problem, problem);
  });
}

test('questions: the payload is trimmed, in order, and the default four pass', () => {
  const r = validateQuestions(DEFAULT_QUESTIONS.map((d, i) => ({ ...d, key: `d${i}`, prompt: ` ${d.prompt} ` })));
  assert.deepEqual(r, { value: DEFAULT_QUESTIONS.map((d) => ({ ...d })) });
  assert.deepEqual(
    DEFAULT_QUESTIONS.map((d) => [d.kind, d.prompt, d.required]),
    [
      ['short', 'Headline', true],
      ['long', 'Interests', false],
      ['long', 'Looking for', false],
      ['links', 'Links', false],
    ],
  );
});
