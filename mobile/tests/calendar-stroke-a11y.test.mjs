// Run: npm test. Qrewing Calendar: a room that spans several week rows is ONE VoiceOver element (2026-11-13).
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { primarySegments, strokeA11y } = await import('../src/components/calendar/sketch.ts');

test('primarySegments: only the first visible row of each room carries VoiceOver', () => {
  const segs = [
    { itemId: 'a', row: 2 },
    { itemId: 'a', row: 1 },
    { itemId: 'a', row: 3 },
    { itemId: 'b', row: 3 },
  ];
  assert.deepEqual([...primarySegments(segs)].sort(), ['a:1', 'b:3']);
  assert.equal(primarySegments([]).size, 0);
});

test('strokeA11y: primary is a labelled button; the rest are hidden from VoiceOver', () => {
  assert.deepEqual(strokeA11y(true, 'Run, Nov 1 – 20'), {
    accessible: true,
    accessibilityRole: 'button',
    accessibilityLabel: 'Run, Nov 1 – 20',
  });
  const rest = strokeA11y(false, 'Run, Nov 1 – 20');
  assert.equal(rest.accessible, false);
  assert.equal(rest.accessibilityElementsHidden, true);
  assert.equal(rest.importantForAccessibility, 'no-hide-descendants');
  assert.equal(rest.accessibilityLabel, undefined);
});

test('the stroke and the calendar screen use them', () => {
  const stroke = readFileSync(new URL('../src/components/calendar/highlighter-stroke.tsx', import.meta.url), 'utf8');
  assert.match(stroke, /strokeA11y\(/);
  const screen = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
  assert.match(screen, /primarySegments\(/);
  assert.match(screen, /a11yPrimary=\{/);
});
