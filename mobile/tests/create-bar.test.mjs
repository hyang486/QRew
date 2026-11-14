// Run: npm test. Create room bar (E2E finding i): hairline at the scroll edge and >= 12 pt non-tappable gap.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const bar = await import('../src/features/event/create-bar.ts');

test('the wrapper starts at the scroll boundary and spans the bar', () => {
  assert.equal(bar.QSCREEN_ACTIONS.paddingTop + bar.createBarLayout.marginTop, 0);
  assert.equal(bar.createBarLayout.marginHorizontal + bar.QSCREEN_ACTIONS.side, 0);
  assert.equal(bar.createBarLayout.paddingHorizontal, bar.QSCREEN_ACTIONS.side);
});

test('at least 12 pt of padding between the hairline and the Create button', () => {
  assert.ok(bar.createBarLayout.paddingTop >= 12);
});

test('QScreen actions padding still matches the values the bar cancels', () => {
  const src = readFileSync(new URL('../src/components/q-screen.tsx', import.meta.url), 'utf8');
  assert.match(src, /actions: \{ paddingHorizontal: qSpacing\.side, paddingTop: 12,/);
  assert.match(src, /qSpacing = \{ side: 24,/);
});

test('create-room wraps its actions in the bar with the theme separator', () => {
  const src = readFileSync(new URL('../src/app/create-room.tsx', import.meta.url), 'utf8');
  assert.match(src, /styles\.bar/);
  assert.match(src, /bar: \{ \.\.\.createBarLayout, borderTopWidth: StyleSheet\.hairlineWidth, borderTopColor: colors\.separator \}/);
});
