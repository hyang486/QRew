// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addStrokePoint,
  appendStroke,
  isFlatNorthUp,
  joinStrokes,
  regionPoint,
  screenToLatLng,
  simplifyStroke,
  strokeToRoute,
} from '../src/lib/route-draw.ts';

const SIZE = { width: 360, height: 360 };
const SF = { latitude: 37.7749, longitude: -122.4194 };
const region = (overrides = {}) => ({
  center: SF,
  longitudeDelta: 360 / 2 ** 15,
  zoom: 15,
  bearing: 0,
  tilt: 0,
  ...overrides,
});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps ${eps})`);

test('the view center maps to the region center', () => {
  const p = screenToLatLng({ x: 180, y: 180 }, SIZE, region());
  close(p.latitude, SF.latitude);
  close(p.longitude, SF.longitude);
});

test('the left and right edges are half the longitude span away', () => {
  const r = region();
  const right = screenToLatLng({ x: 360, y: 180 }, SIZE, r);
  const left = screenToLatLng({ x: 0, y: 180 }, SIZE, r);
  close(right.longitude, SF.longitude + r.longitudeDelta / 2);
  close(left.longitude, SF.longitude - r.longitudeDelta / 2);
  close(right.latitude, SF.latitude);
});

test('up is north, and the latitude span shrinks by cos(latitude) (Mercator)', () => {
  const r = region();
  const top = screenToLatLng({ x: 180, y: 0 }, SIZE, r);
  const bottom = screenToLatLng({ x: 180, y: 360 }, SIZE, r);
  assert.ok(top.latitude > SF.latitude && bottom.latitude < SF.latitude);
  const expected = r.longitudeDelta * Math.cos((SF.latitude * Math.PI) / 180);
  close(top.latitude - bottom.latitude, expected, expected * 1e-3);
});

test('longitude wraps across the antimeridian', () => {
  const p = screenToLatLng({ x: 360, y: 180 }, SIZE, region({ center: { latitude: 0, longitude: 179.999 } }));
  assert.ok(p.longitude < -179.99 && p.longitude >= -180);
});

test('an unusable size or span gives null', () => {
  assert.equal(screenToLatLng({ x: 1, y: 1 }, { width: 0, height: 360 }, region()), null);
  assert.equal(screenToLatLng({ x: 1, y: 1 }, SIZE, region({ longitudeDelta: 0 })), null);
  assert.equal(screenToLatLng({ x: 1, y: 1 }, SIZE, region({ longitudeDelta: Number.NaN })), null);
});

test('a rotated or tilted map is not flat north-up', () => {
  assert.equal(isFlatNorthUp(region()), true);
  assert.equal(isFlatNorthUp(region({ bearing: 359.8 })), true);
  assert.equal(isFlatNorthUp(region({ bearing: 30 })), false);
  assert.equal(isFlatNorthUp(region({ bearing: -90 })), false);
  assert.equal(isFlatNorthUp(region({ tilt: 45 })), false);
});

test('finger moves under the minimum step add no point', () => {
  let s = addStrokePoint([], { x: 0, y: 0 });
  s = addStrokePoint(s, { x: 1, y: 1 });
  assert.equal(s.length, 1);
  s = addStrokePoint(s, { x: 10, y: 0 });
  assert.deepEqual(s, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
});

test('simplify keeps the ends and corners, drops wobble on a straight line', () => {
  const line = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: i % 2 === 0 ? 0 : 0.5 }));
  assert.deepEqual(simplifyStroke(line), [line[0], line[4]]);
  const corner = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
  ];
  assert.deepEqual(simplifyStroke(corner), [corner[0], corner[2], corner[3]]);
  assert.deepEqual(simplifyStroke([{ x: 3, y: 3 }]), [{ x: 3, y: 3 }]);
});

test('a stroke becomes route coordinates; a tap is dropped', () => {
  const r = region();
  const route = strokeToRoute(
    [
      { x: 180, y: 180 },
      { x: 270, y: 180 },
      { x: 360, y: 180 },
    ],
    SIZE,
    r,
  );
  assert.equal(route.length, 2);
  close(route[0].longitude, SF.longitude);
  close(route[1].longitude, SF.longitude + r.longitudeDelta / 2);
  assert.deepEqual(strokeToRoute([{ x: 10, y: 10 }], SIZE, r), []);
  assert.deepEqual(strokeToRoute([], SIZE, r), []);
});

// R1-D: numbers from the editor on an iPhone 17 Pro simulator (402 x 874 pt, safe area top 62 / bottom 34).
// MapKit reported a region whose latitude span covers exactly 778 pt (874 - 62 - 34): the region is the
// map's safe area, so its center is at y = 62 + 778 / 2 = 451, not at the view's middle (437).
const PHONE = { width: 402, height: 874 };
const PHONE_INSETS = { top: 62, right: 0, bottom: 34, left: 0 };
const LA = {
  center: { latitude: 34.03937068505354, longitude: -118.2567966179815 },
  longitudeDelta: 0.01902186534117334,
  zoom: 14.208050557965521,
  bearing: 0,
  tilt: 0,
};
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

test('R1-D: a view point is moved into the safe-area frame MapKit reports its region for', () => {
  const { point, size } = regionPoint({ x: 100, y: 300 }, PHONE, PHONE_INSETS);
  assert.deepEqual(point, { x: 100, y: 238 });
  assert.deepEqual(size, { width: 402, height: 778 });
  // No insets: the view is the frame.
  assert.deepEqual(regionPoint({ x: 5, y: 6 }, SIZE, { top: 0, right: 0, bottom: 0, left: 0 }), {
    point: { x: 5, y: 6 },
    size: SIZE,
  });
});

test('R1-D: under the safe areas, the safe-area center (not the view middle) is the region center', () => {
  const [a, b] = strokeToRoute([{ x: 201, y: 451 }, { x: 201, y: 300 }], PHONE, LA, PHONE_INSETS);
  close(a.latitude, LA.center.latitude);
  close(a.longitude, LA.center.longitude);
  // The finger at y = 300 is 151 pt above the region center: the saved point must be exactly there.
  const scale = PHONE.width / ((LA.longitudeDelta * Math.PI) / 180);
  close((mercY(b.latitude) - mercY(LA.center.latitude)) * scale, 151, 1e-6);
  // Without the insets the same finger lands 14 pt lower (the R1-D bug).
  const [, wrong] = strokeToRoute([{ x: 201, y: 451 }, { x: 201, y: 300 }], PHONE, LA);
  close((mercY(wrong.latitude) - mercY(LA.center.latitude)) * scale, 137, 1e-6);
});

test('strokes join in drawing order and stay within the point limit', () => {
  const a = [{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }];
  const b = [{ latitude: 3, longitude: 3 }, { latitude: 4, longitude: 4 }, { latitude: 5, longitude: 5 }];
  const one = appendStroke([], a, 4);
  assert.equal(one.truncated, false);
  const two = appendStroke(one.strokes, b, 4);
  assert.equal(two.truncated, true);
  assert.deepEqual(joinStrokes(two.strokes), [...a, ...b.slice(0, 2)]);
  const full = appendStroke(two.strokes, b, 4);
  assert.equal(full.truncated, true);
  assert.equal(full.strokes, two.strokes);
  assert.equal(appendStroke(one.strokes, [], 4).strokes, one.strokes);
});
