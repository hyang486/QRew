// Run: npm test. Calendar polish after the 453712d device pass (supervisor + qa, 2026-11-13): (a) one date label,
// (b) "Icon" header, (c) hand-font day list, (d/e) calendar paper behind the screen and header, light and dark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const editor = read('features/calendar/event-editor.tsx');
const screen = read('features/calendar/calendar-screen.tsx');

test('(a) a date row shows one label: the picker title is spoken only (labelsHidden)', () => {
  const row = editor.slice(editor.indexOf('function DateRow('), editor.indexOf('const styles'));
  assert.match(row, /<DatePicker[\s\S]*?title=\{label\}[\s\S]*?modifiers=\{\[labelsHidden\(\)\]\}/);
  assert.match(row, /<Text[^>]*styles\.dateLabel[^>]*accessibilityElementsHidden/);
});

test('(b) the picker section is called Icon', () => {
  assert.match(read('i18n/en.ts'), /emojiLabel: 'Icon',/);
});

test('(c) superseded by tiers FINAL 2026-11-13 PM: there is no day list under the calendar', () => {
  assert.doesNotMatch(screen, /styles\.(dayList|dayHead|dayTitle|daySub|dayRow)\b/);
});

test('(d/e) both screens sit on the calendar paper token, header included, no hard-coded color', () => {
  for (const [name, src, paper] of [
    ['calendar', screen, 'palette.paper'],
    ['editor', editor, 'paper'],
  ]) {
    for (const key of ['headerStyle', 'contentStyle']) assert.match(src, new RegExp(`${key}: \\{ backgroundColor: ${paper} \\}`), `${name} ${key}`);
    assert.match(src, new RegExp(`background=\\{${paper}\\}`), `${name} QScreen`);
    assert.doesNotMatch(src, /#FBF|#1D1B17/i, name);
  }
  assert.match(editor, /const paper = useCalendarColors\(\)\.paper;/);
  const q = read('components/q-screen.tsx');
  assert.match(q, /styles\.root, \{ paddingBottom: keyboardPad \}, background \? \{ backgroundColor: background \} : null/);
});

test('(f) the Starts/Ends row labels use the hand font; the title field and Save stay system', () => {
  const ed = read('features/calendar/event-editor.tsx');
  const row = ed.slice(ed.indexOf('function DateRow('), ed.indexOf('const styles'));
  assert.match(row, /const \[handLoaded\] = useFonts\(HAND_FONTS\);/);
  assert.match(row, /styles\.dateLabel, handLoaded \? \{ fontFamily: handFontFor\(label\) \} : null/);
  const form = ed.slice(ed.indexOf('export function EventEditor'), ed.indexOf('function DateRow('));
  assert.doesNotMatch(form, /fontFamily|handFontFor/);
});
