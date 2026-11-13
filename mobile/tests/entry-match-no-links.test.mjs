// Run: npm test. Spec 9.3: links answers, links prompts and question ids never reach the match model. Reads the
// deployed qrewing function's pure helpers (supabase/ is developer-owned; this file only imports it).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compactPerson, matchLegend } from '../../supabase/functions/qrewing/core.ts';
import { matchUser } from '../../supabase/functions/qrewing/prompts.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINK = 'https://secret-link.example/me';

function prompt(rows, profiles) {
  const { questions, keyOf } = matchLegend(rows);
  const people = profiles.map((p, i) => ({ ...compactPerson(`Name${i}`, p, keyOf), id: `p${i}` }));
  return matchUser(questions, people[0], people.slice(1));
}

const profile = (answers, extra = {}) => ({
  headline: '',
  interests: '',
  lookingFor: '',
  links: [LINK],
  answers,
  ...extra,
});

test('default four: the links question and its answers are never in the prompt', () => {
  const rows = [
    { id: id(1), position: 0, kind: 'short', prompt: 'Headline' },
    { id: id(2), position: 1, kind: 'long', prompt: 'Interests' },
    { id: id(3), position: 2, kind: 'long', prompt: 'Looking for' },
    { id: id(4), position: 3, kind: 'links', prompt: 'Links' },
  ];
  const a = profile({ [id(1)]: 'Builder', [id(2)]: `see ${'x'.repeat(5)}`, [id(4)]: [LINK, 'https://two.example'] });
  const b = profile({ [id(1)]: 'Recruiter', [id(4)]: ['https://three.example'] });
  const u = prompt(rows, [a, b]);
  for (const s of [LINK, 'two.example', 'three.example', '>Links<', 'kind="links"', ...rows.map((r) => r.id)]) {
    assert.ok(!u.includes(s), `prompt leaked ${s}`);
  }
  assert.ok(u.includes('<question id="q3" kind="long">Looking for</question>\n</questions>'));
});

test('a links question first in position: numbering skips it and nothing of it is sent', () => {
  const rows = [
    { id: id(9), position: 0, kind: 'links', prompt: 'Portfolio' },
    { id: id(8), position: 1, kind: 'short', prompt: 'Role' },
  ];
  const u = prompt(rows, [profile({ [id(9)]: [LINK], [id(8)]: 'Designer' }), profile({ [id(8)]: 'Dev' })]);
  assert.ok(u.includes('<question id="q1" kind="short">Role</question>\n</questions>'));
  assert.ok(!u.includes('Portfolio') && !u.includes(LINK));
});

test('wrong-typed values under a links question id (a string) are still not sent', () => {
  const rows = [
    { id: id(1), position: 0, kind: 'short', prompt: 'Headline' },
    { id: id(2), position: 1, kind: 'links', prompt: 'Links' },
  ];
  const u = prompt(rows, [profile({ [id(1)]: 'Me', [id(2)]: LINK }), profile({ [id(1)]: 'You', [id(2)]: { url: LINK } })]);
  assert.ok(!u.includes(LINK));
});

test('a person with only a links answer sends a name and no answers, and the links column is never read', () => {
  const rows = [
    { id: id(1), position: 0, kind: 'short', prompt: 'Headline' },
    { id: id(2), position: 1, kind: 'links', prompt: 'Links' },
  ];
  const u = prompt(rows, [profile({ [id(1)]: 'Me' }), profile({ [id(2)]: [LINK] })]);
  assert.ok(u.includes('<person id="p1"><name>Name1</name></person>'));
  assert.ok(!u.includes(LINK));
});

test('a legacy row (answers empty) sends h/i/l text but never its links column', () => {
  const rows = [{ id: id(1), position: 0, kind: 'short', prompt: 'Headline' }];
  const legacy = profile({}, { headline: 'Old head', interests: 'Old interests' });
  const u = prompt(rows, [profile({ [id(1)]: 'Me' }), legacy]);
  assert.ok(u.includes('<answer q="h">Old head</answer>'));
  assert.ok(!u.includes(LINK));
});
