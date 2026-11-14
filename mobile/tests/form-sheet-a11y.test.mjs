// Run: npm test. qa re-record 2026-11-13: (3) the event form read "Starts Starts" / "Ends Ends"; (4) Mina's Qrewing AI
// consent sheet was invisible but took taps until Agree, after reopening the room (presented during the push).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('(3) a date row is read once: the visible label is hidden from VoiceOver, the picker keeps its title', () => {
  const src = read('features/calendar/event-editor.tsx');
  const row = src.slice(src.indexOf('function DateRow('), src.indexOf('const styles'));
  const label = row.match(/<Text[^>]*styles\.dateLabel[^>]*>/)[0];
  assert.match(label, /accessibilityElementsHidden/);
  assert.match(label, /importantForAccessibility="no-hide-descendants"/);
  assert.match(row, /<DatePicker[\s\S]*?title=\{label\}/);
});

test('(4) the consent sheet presents only on a focused screen whose push has finished', () => {
  const src = read('features/event/disclosure-sheet.tsx');
  assert.match(src, /<Modal[^>]*?\svisible=\{visible && settled\}/);
  const hook = src.slice(src.indexOf('function useSettledFocus'));
  assert.match(hook, /useIsFocused\(\)/);
  assert.match(hook, /addListener\('transitionEnd'/);
  // A screen without a transition still gets there, and leaving the screen resets it.
  assert.match(hook, /setTimeout\(/);
  assert.match(hook, /return focused && settled;/);
});

test('(4b) a refused presentation is retried: entry via the invite modal\'s Done (presenter still dismissing)', () => {
  const src = read('features/event/disclosure-sheet.tsx');
  const modal = src.slice(src.indexOf('<Modal'), src.indexOf('>', src.indexOf('onRequestClose')));
  // The Modal reports onShow and is remounted (key) to present again when UIKit refused it.
  assert.match(modal, /key=\{present\.key\}/);
  assert.match(modal, /onShow=\{present\.onShow\}/);
  assert.match(src, /usePresentRetry\(visible && settled\)/);
  const hook = src.slice(src.indexOf('function usePresentRetry'), src.indexOf('const styles'));
  // Retries only while wanted and not yet shown, bounded, and resets when the sheet is no longer wanted.
  assert.match(hook, /if \(!want \|\| shown \|\| attempt >= MAX_SHOW_RETRIES\) return;/);
  assert.match(hook, /setTimeout\(/);
  assert.match(hook, /clearTimeout\(t\)/);
  assert.match(hook, /setShown\(false\);\s*setAttempt\(0\);/);
  assert.match(hook, /onShow: \(\) => setShown\(true\)/);
});
