// Run: npm test. Calendar tiers and interaction (human FINAL 2026-11-13 PM): Free gets the month, "+" and room
// bars; a room tap opens the diary on Plus and the upsell on Free; "Add with Qrewing" is Plus only; no day list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const screen = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
const en = readFileSync(new URL('../src/i18n/en.ts', import.meta.url), 'utf8');

test('no Plus gate on the screen: signed in is enough', () => {
  assert.match(screen, /calendarGate\(!!uid\) === 'signedOut'/);
  assert.doesNotMatch(screen, /upsellTitle|upsellCta/);
});

test('"Add with Qrewing" renders only on Plus (Free makes no server call)', () => {
  assert.match(screen, /plus !== true \? undefined : \(/);
});

test('taps route through itemAction: diary on Plus, PlusUpsellCard on Free, the editor for my events', () => {
  assert.match(screen, /const action = itemAction\(item\.kind, plus\);/);
  assert.match(screen, /if \(action === 'diary'\) setDiary\(room\);\n\s+else setUpsell\(room\);/);
  assert.match(screen, /pathname: '\/calendar-event', params: \{ id: item\.id\.slice\('event:'\.length\) \}/);
  // The upsell gets name, dates and icon only, never the diary.
  const card = screen.slice(screen.indexOf('<PlusUpsellCard'), screen.indexOf('/>', screen.indexOf('<PlusUpsellCard')));
  assert.doesNotMatch(card, /diary/);
});

test('day cells are not tap targets; bars and "+N" are, and "+N" opens DayItemsSheet', () => {
  assert.doesNotMatch(screen, /onPress=\{\(\) => setSelected\(/);
  assert.match(screen, /onPress=\{\(\) => setSheetDay\(key\)\}/);
  assert.match(screen, /accessibilityLabel=\{t\.moreLabel\(more, dayTitle\(key\)\)\}/);
  assert.match(screen, /a11yLabel: itemLabel\(i\)/);
  assert.match(screen, /onPress=\{\(\) => openItem\(item\)\}\n\s+accessibilityLabel=\{itemLabel\(item\)\}/);
  assert.match(screen, /a11yPrimary=\{a11yFirst\.has\(/);
});

test('bar labels name the action: open diary, Plus feature, edit event', () => {
  assert.match(screen, /t\.barLabel\(item\.title, rangeLabel\(item\.start, item\.end, thisYear\), barAction\(item\.kind, plus\)\)/);
});

test('Plan preview table: Calendar on both, Qrewing diary and Add with Qrewing on Plus', () => {
  assert.match(en, /\{ label: 'Calendar', free: 'Included', plus: 'Included' \}/);
  assert.match(en, /\{ label: 'Qrewing diary', free: 'Not included', plus: 'Included' \}/);
  assert.match(en, /\{ label: 'Add with Qrewing', free: 'Not included', plus: 'Included' \}/);
});
