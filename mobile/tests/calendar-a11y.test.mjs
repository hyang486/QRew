// Run: npm test. Qrewing Calendar VoiceOver labels and empty states (2026-11-13 a11y pass).
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const f = await import('../src/features/calendar/calendar-format.ts');
const { en } = await import('../src/i18n/en.ts');
const t = en.calendar;

test('diaryText: never blank, at most 3 lines, skips empty or non-string lines', () => {
  assert.deepEqual(f.diaryText(null, t.diaryNone), [t.diaryNone]);
  assert.deepEqual(f.diaryText([], t.diaryNone), [t.diaryNone]);
  assert.deepEqual(f.diaryText(['  ', 3, null], t.diaryNone), [t.diaryNone]);
  assert.deepEqual(f.diaryText(['a', '', 'b', 'c', 'd'], t.diaryNone), ['a', 'b', 'c']);
});

test('ask error names the Add event button, not a bare "+"', () => {
  assert.match(t.askErrors.other, /Add event/);
});

test('diary modal: the close button does not wrap the card (VoiceOver would hide the diary)', () => {
  const src = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
  const close = src.indexOf('accessibilityLabel={t.diaryClose}');
  assert.ok(close > 0);
  const pressableOpen = src.lastIndexOf('<Pressable', close);
  const card = src.indexOf('<DiaryCard', close);
  assert.ok(card > close);
  // Between the close button and the card the Pressable must already be closed (self-closing, no </Pressable>).
  assert.ok(src.slice(pressableOpen, card).includes('/>'), 'close Pressable must be self-closing');
  assert.ok(!src.slice(card, src.indexOf('</Modal>', card)).includes('</Pressable>'), 'card must not sit inside the close Pressable');
  assert.match(src, /onAccessibilityEscape=\{\(\) => setDiary\(null\)\}/);
});

test('diary card: the room icon is an ink line icon beside the name, not a color emoji in the title', () => {
  const screen = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
  const card = screen.slice(screen.indexOf('<DiaryCard'), screen.indexOf('/>', screen.indexOf('<DiaryCard')));
  assert.match(card, /\btitle=\{diary\.name\}/);
  assert.match(card, /\bicon=\{diary\.emoji\}/);
  assert.doesNotMatch(card, /title=\{`\$\{diary\.emoji\}/);
  const paper = readFileSync(new URL('../src/components/calendar/ruled-diary-paper.tsx', import.meta.url), 'utf8');
  assert.match(paper, /\{icon \? <InkIcon emoji=\{icon\}/);
  // Decorative: the InkIcon itself is hidden from VoiceOver, and the card label never includes the emoji.
  const ink = readFileSync(new URL('../src/components/calendar/ink-icon.tsx', import.meta.url), 'utf8');
  assert.match(ink, /accessibilityElementsHidden|importantForAccessibility="no(-hide-descendants)?"/);
  assert.doesNotMatch(card.slice(card.indexOf('accessibilityLabel')), /diary\.emoji/);
});
