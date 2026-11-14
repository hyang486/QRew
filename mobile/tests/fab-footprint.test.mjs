// Run: npm test. UI audit 2026-11-13 item 1: the Ask Qrewing button's footprint lives in one file, and every
// in-room scroll area under it pads its content by that footprint; the map button floats above the map buttons.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const size = read('features/event/qrewing-fab-size.ts');
const fab = read('features/event/qrewing-fab.tsx');
const qscreen = read('components/q-screen.tsx');
const gallery = read('app/room/[id]/gallery.tsx');
const photosOfMe = read('components/photos-of-me.tsx');
const map = read('app/room/[id]/map.tsx');

test('footprint: clearance is margin + button + margin, and the button uses the same margin', () => {
  assert.match(size, /QREWING_FAB_CLEARANCE = QREWING_FAB_MARGIN \+ QREWING_FAB_SIZE \+ QREWING_FAB_MARGIN/);
  assert.doesNotMatch(size, /^import /m);
  assert.match(fab, /\+ QREWING_FAB_MARGIN, right:/);
});

test('QScreen floating slot (Room info) pads by the footprint, not a hard-coded number', () => {
  assert.match(qscreen, /floatingClear: \{ paddingBottom: QREWING_FAB_CLEARANCE \}/);
});

test('Photos & files and Photos of me pad grid and states by the footprint while the button shows', () => {
  assert.match(gallery, /bottomInset=\{can\.upload \? QREWING_FAB_CLEARANCE : 0\}/);
  assert.match(gallery, /contentContainerStyle=\{\{ paddingBottom: can\.upload \? QREWING_FAB_CLEARANCE : 0 \}\}/);
  assert.match(photosOfMe, /contentContainerStyle=\{\{ gap, paddingBottom: bottomInset \}\}/);
  assert.match(photosOfMe, /contentContainerStyle=\{\{ paddingBottom: bottomInset \}\}/);
});

test('Map: the button sits above the measured bottom map buttons', () => {
  assert.match(map, /onLayout=\{\(e\) => setOverlayHeight\(e\.nativeEvent\.layout\.height\)\}/);
  assert.match(map, /<QrewingFab roomId=\{room\.id\} bottom=\{OVERLAY_BOTTOM \+ overlayHeight\} \/>/);
  assert.match(map, /bottom: OVERLAY_BOTTOM,/);
});
