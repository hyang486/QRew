// Run: npm test. Qrewing Calendar look (human final 2026-11-13 ~10:50): ink line icons instead of color emoji.
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { INK_ICONS, emojiBase, inkIconKey, inkIconLabel } = await import('../src/components/calendar/ink-icon-map.ts');

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const gridLine = src('features/calendar/event-editor.tsx').match(/EVENT_EMOJIS = \[([^\]]+)\]/)[1];
const GRID = [...gridLine.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('every editor grid emoji has its own icon, none falls back to the pin except the pin', () => {
  assert.equal(GRID.length, 16);
  const keys = GRID.map(inkIconKey);
  assert.equal(new Set(keys).size, 16, `duplicate icons: ${keys}`);
  GRID.forEach((e, i) => assert.ok(keys[i] !== 'pin' || e === '📌', `${e} fell back to the pin`));
});

test('server room-type fallbacks and the client default map to their own icons', () => {
  const core = readFileSync(new URL('../../supabase/functions/qrewing/core.ts', import.meta.url), 'utf8');
  const server = core.match(/ROOM_TYPE_EMOJI[^=]*= \{([^}]+)\}/)[1];
  const emojis = [...server.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(emojis.map(inkIconKey), ['run', 'party', 'hourglass', 'chat']);
});

test('variation selectors, skin tones and ZWJ tails reduce to the base emoji', () => {
  assert.equal(emojiBase('❤️'), '❤');
  assert.equal(inkIconKey('✈️'), 'plane');
  assert.equal(inkIconKey('🏃🏽‍♀️'), 'run');
  assert.equal(inkIconKey('🚴‍♂'), 'bike');
  assert.equal(inkIconKey(' ☕ '), 'coffee');
});

test('unknown, empty and missing emoji fall back to the pin', () => {
  for (const e of ['🦄', '', '   ', null, undefined, 'abc']) assert.equal(inkIconKey(e), 'pin');
});

test('VoiceOver labels are words, never emoji', () => {
  for (const [key, { label, paths }] of Object.entries(INK_ICONS)) {
    assert.match(label, /^[A-Z][a-z]+$/, key);
    assert.ok(paths.length > 0, key);
    for (const d of paths) assert.match(d, /^M[\d.\sMLHVQTACZ-]+$/, `${key}: ${d}`);
  }
  assert.equal(inkIconLabel('🎂'), 'Birthday');
  assert.equal(inkIconLabel('🦄'), 'Pin');
});

test('call sites draw the icon, not the emoji text', () => {
  const screen = src('features/calendar/calendar-screen.tsx');
  const editor = src('features/calendar/event-editor.tsx');
  // Tiers FINAL: the day list (the screen's own InkIcon call) is gone; "+N" rows draw icons in DayItemsSheet.
  assert.doesNotMatch(screen, /\{item\.emoji\}<\/Text>/);
  assert.match(editor, /accessibilityLabel=\{inkIconLabel\(e\)\}/);
  assert.doesNotMatch(editor, /<Text[^>]*>\{e\}<\/Text>/);
  const stroke = src('components/calendar/highlighter-stroke.tsx');
  assert.match(stroke, /<InkIcon emoji=\{emoji\}/);
  assert.doesNotMatch(stroke, /\{emoji\}\s*<\/Text>/);
});

test('tiers FINAL: the day list is removed; interaction lives on the grid', () => {
  const screen = src('features/calendar/calendar-screen.tsx');
  assert.doesNotMatch(screen, /styles\.dayList/);
});
