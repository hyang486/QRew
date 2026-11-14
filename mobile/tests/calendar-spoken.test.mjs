// Run: npm test. qa (s24): the diary card's VoiceOver label read "it.." because lines that already end in
// punctuation were joined with '. '.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { spokenJoin } = await import('../src/features/calendar/calendar-format.ts');

test('a period is added only where a part has no ending punctuation', () => {
  assert.equal(spokenJoin(['Coffee Night', 'Nov 13', 'We loved it.', 'Again?', 'Wow!', 'And then…']),
    'Coffee Night. Nov 13. We loved it. Again? Wow! And then…');
  assert.equal(spokenJoin(['Done.', 'Next']), 'Done. Next');
});

test('blank parts are skipped and trailing spaces do not hide punctuation', () => {
  assert.equal(spokenJoin(['A', '', '  ', 'B. ']), 'A. B.');
  assert.equal(spokenJoin([]), '');
});

test('the diary card label uses spokenJoin', () => {
  const src = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /diaryText\([^)]*\)\]\.join\('\. '\)/);
  assert.match(src, /spokenJoin\(\[diary\.name/);
});
