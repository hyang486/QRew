// Run: npm test. Calendar tiers (human FINAL 2026-11-13 PM): Plus upsell card and "+N" day items sheet.
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { en } = await import('../src/i18n/en.ts');
const t = en.calendar;
const read = (f) => readFileSync(new URL(`../src/components/calendar/${f}`, import.meta.url), 'utf8');

test('barLabel names what a tap does; Free rooms are a Plus feature', () => {
  assert.equal(t.barLabel('Beach', 'Nov 13–14', 'diary'), 'Beach, Nov 13–14, open diary');
  assert.equal(t.barLabel('Beach', 'Nov 13–14', 'plus'), 'Beach, Nov 13–14, Plus feature');
  assert.equal(t.barLabel('Run', 'Nov 13', 'edit'), 'Run, Nov 13, edit event');
});

test('moreLabel and dayItemsTitle read naturally', () => {
  assert.equal(t.moreLabel(2, 'Friday, November 13'), '2 more on Friday, November 13');
  assert.equal(t.dayItemsTitle(1), '1 item');
  assert.equal(t.dayItemsTitle(3), '3 items');
});

test('upsell card never takes or shows diary text', () => {
  const src = read('plus-upsell-card.tsx');
  assert.doesNotMatch(src, /diary(Text|None|Later)|lines=/);
  // The close scrim is a sibling, not a wrapper, so VoiceOver reaches the card.
  assert.ok(src.indexOf('accessibilityLabel={t.upsellClose}') < src.indexOf('styles.card'));
  assert.match(src, /accessibilityViewIsModal/);
});

test('day items sheet hands the key to onPick and does not close itself', () => {
  const src = read('day-items-sheet.tsx');
  assert.match(src, /onPress=\{\(\) => onPick\(item\.key\)\}/);
  assert.match(src, /accessibilityLabel=\{item\.a11yLabel\}/);
  assert.doesNotMatch(src, /onPick\([^)]*\);\s*onClose/);
});

test('both components are exported from the calendar index', () => {
  const idx = read('index.ts');
  assert.match(idx, /PlusUpsellCard/);
  assert.match(idx, /DayItemsSheet/);
});
