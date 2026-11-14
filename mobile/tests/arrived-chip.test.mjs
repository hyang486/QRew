// Run: npm test. UI v2 bug 7 (qa, 2026-11-13): the Arrived chip was filled black before arriving, so it looked selected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../src/components/room-activity.tsx', import.meta.url), 'utf8');

test('the Arrived chip fills only after I have arrived, and says so to VoiceOver', () => {
  assert.match(src, /filled=\{!!activity\.myArrivedAt\}/);
  assert.match(src, /selected=\{!!activity\.myArrivedAt\}/);
  assert.doesNotMatch(src, /filled=\{!activity\.myArrivedAt\}/);
  assert.match(src, /accessibilityState=\{\{ disabled: !!disabled, busy: !!busy, selected \}\}/);
});
