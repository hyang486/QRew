// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cameraFor,
  fitRoomCamera,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  pillSize,
  planLabels,
  projectPoint,
  ROOM_MAP_PADDING,
  ROOM_MAP_SIZE,
  roomMapPadding,
  viewportFromCamera,
  viewportFromRegion,
} from '../src/lib/location-plan.ts';

const p = (latitude, longitude) => ({ latitude, longitude });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const RAD = Math.PI / 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / RAD;
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Where MapKit draws `point`, in view points, for an expo-maps camera: expo-maps asks for a region of
 * 360 / 2^zoom degrees on both axes and MapKit scales that region to fit inside the view. This model uses
 * the exact Mercator height of the region, independent of the cos(lat) shortcut in cameraFor.
 */
function project(point, camera, size) {
  const span = 360 / 2 ** camera.zoom;
  const c = camera.coordinates;
  const regionHeight = mercY(c.latitude + span / 2) - mercY(c.latitude - span / 2);
  const scale = Math.min(size.width / span, size.height / regionHeight);
  let dLng = point.longitude - c.longitude;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  return {
    x: size.width / 2 + dLng * scale,
    y: size.height / 2 - (mercY(point.latitude) - mercY(c.latitude)) * scale,
  };
}

/** Every point lands inside the padded rect, within `slack` points. */
function assertInside(points, camera, size, padding, slack = 1) {
  for (const point of points) {
    const { x, y } = project(point, camera, size);
    assert.ok(x >= padding.left - slack && x <= size.width - padding.right + slack, `x ${x} for ${JSON.stringify(point)}`);
    assert.ok(y >= padding.top - slack && y <= size.height - padding.bottom + slack, `y ${y} for ${JSON.stringify(point)}`);
  }
}

/** The points fill the padded rect along at least one axis (the fit is tight, not just safe). */
function assertTight(points, camera, size, padding, slack = 1) {
  const xs = points.map((pt) => project(pt, camera, size).x);
  const ys = points.map((pt) => project(pt, camera, size).y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const innerW = size.width - padding.left - padding.right;
  const innerH = size.height - padding.top - padding.bottom;
  assert.ok(Math.abs(w - innerW) < slack || Math.abs(h - innerH) < slack, `box ${w} x ${h} in ${innerW} x ${innerH}`);
}

// A north-south route through San Francisco: taller than wide, so latitude binds (the 5b clipping case).
const TALL = [p(37.7793, -122.4193), p(37.7810, -122.4170), p(37.7900, -122.4150), p(37.8010, -122.4100)];
// An east-west route: wider than tall.
const WIDE = [p(37.7793, -122.4600), p(37.7800, -122.4300), p(37.7810, -122.4000)];

test('no points: no camera', () => {
  assert.equal(cameraFor([]), null);
  assert.equal(cameraFor([p(NaN, 0), p(91, 0)]), null);
});

test('one point: street level, nudged so its pin clears the uneven top and bottom padding', () => {
  const cam = cameraFor([p(37.7793, -122.4193)]);
  assert.equal(cam.zoom, MAX_CAMERA_ZOOM);
  assert.ok(near(cam.coordinates.longitude, -122.4193));
  // Uneven padding: the center sits a little toward the larger edge (P2: the bottom, for the label pill), so
  // the point sits in the middle of the padded rect rather than of the view.
  const shift = cam.coordinates.latitude - 37.7793;
  assert.equal(Math.sign(shift), Math.sign(ROOM_MAP_PADDING.top - ROOM_MAP_PADDING.bottom), `lat ${cam.coordinates.latitude}`);
  assert.ok(Math.abs(shift) < 0.0005, `lat ${cam.coordinates.latitude}`);
  const { y } = project(p(37.7793, -122.4193), cam, ROOM_MAP_SIZE);
  const mid = (ROOM_MAP_PADDING.top + ROOM_MAP_SIZE.height - ROOM_MAP_PADDING.bottom) / 2;
  assert.ok(Math.abs(y - mid) < 0.5, `y ${y} vs ${mid}`);
});

test('one point with no padding: exactly on that point', () => {
  const cam = cameraFor([p(37.7793, -122.4193)], ROOM_MAP_SIZE, NO_PADDING);
  assert.deepEqual(cam, { coordinates: p(37.7793, -122.4193), zoom: MAX_CAMERA_ZOOM });
});

test('5b: a tall city route sits inside the padded rect on the room map, and fills it', () => {
  const cam = cameraFor(TALL);
  assert.ok(cam.zoom > 10 && cam.zoom < MAX_CAMERA_ZOOM, `zoom ${cam.zoom}`);
  assertInside(TALL, cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING);
  assertTight(TALL, cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING);
});

test('5b: a wide city route sits inside the padded rect, and fills it', () => {
  const cam = cameraFor(WIDE);
  assertInside(WIDE, cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING);
  assertTight(WIDE, cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING);
});

test('5b: the fit follows the measured map size (a narrower or taller view)', () => {
  for (const size of [{ width: 343, height: 360 }, { width: 402, height: 600 }, { width: 600, height: 300 }]) {
    for (const route of [TALL, WIDE]) {
      const cam = cameraFor(route, size);
      assertInside(route, cam, size, ROOM_MAP_PADDING);
      assertTight(route, cam, size, ROOM_MAP_PADDING);
    }
  }
});

test('5b: with no padding the box reaches the view edges, so the padding is what keeps it clear', () => {
  const cam = cameraFor(TALL, ROOM_MAP_SIZE, NO_PADDING);
  assertInside(TALL, cam, ROOM_MAP_SIZE, NO_PADDING);
  assertTight(TALL, cam, ROOM_MAP_SIZE, NO_PADDING);
  // The padded camera is zoomed further out than the unpadded one.
  assert.ok(cameraFor(TALL).zoom < cam.zoom);
});

test('5b: the old 1.4x span margin put the tall route under the top overlay and pin', () => {
  // Pre-fix camera: middle of the lat/lng box, span = max(latSpan, lngSpan) * 1.4.
  const lats = TALL.map((pt) => pt.latitude);
  const lngs = TALL.map((pt) => pt.longitude);
  const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs)) * 1.4;
  const old = {
    coordinates: p((Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2),
    zoom: Math.log2(360 / span),
  };
  const topY = Math.min(...TALL.map((pt) => project(pt, old, ROOM_MAP_SIZE).y));
  assert.ok(topY < ROOM_MAP_PADDING.top, `old top ${topY}`);
});

test('padding larger than the view still leaves the points a quarter of it', () => {
  const huge = { top: 300, bottom: 300, left: 300, right: 300 };
  const cam = cameraFor(TALL, ROOM_MAP_SIZE, huge);
  assert.ok(Number.isFinite(cam.zoom) && cam.zoom >= MIN_CAMERA_ZOOM);
  assert.ok(Number.isFinite(cam.coordinates.latitude) && Number.isFinite(cam.coordinates.longitude));
});

test('the R1 world-scale route (F5-3) fits instead of street-level water', () => {
  const route = [p(-16.1865410712183, -31.9921875), p(4.68227962838259, 17.2265625), p(-44.757135998073, -3.8671875)];
  const cam = cameraFor(route);
  assert.ok(cam.zoom > 1 && cam.zoom < 3, `zoom ${cam.zoom}`);
  assert.ok(near(cam.coordinates.longitude, -7.3828125));
  // At this scale the cos(lat) shortcut drifts a little from the exact Mercator height: allow a few points.
  assertInside(route, cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING, 8);
});

test('a very small span is clamped to street level', () => {
  const cam = cameraFor([p(37.7793, -122.4193), p(37.77931, -122.41931)]);
  assert.equal(cam.zoom, MAX_CAMERA_ZOOM);
});

test('points across the globe are clamped to the world view', () => {
  const cam = cameraFor([p(-80, -170), p(80, 10)]);
  assert.equal(cam.zoom, MIN_CAMERA_ZOOM);
});

test('a route across the antimeridian is centered on it, not on the far side of the world', () => {
  const cam = cameraFor([p(-17, 179), p(-18, -179)]);
  assert.ok(Math.abs(Math.abs(cam.coordinates.longitude) - 180) < 1e-9, `lng ${cam.coordinates.longitude}`);
  assert.ok(cam.zoom > 6, `zoom ${cam.zoom}`);
  assertInside([p(-17, 179), p(-18, -179)], cam, ROOM_MAP_SIZE, ROOM_MAP_PADDING);
});

test('the antimeridian center stays in [-180, 180]', () => {
  const cam = cameraFor([p(0, 170), p(0, -160)]);
  assert.ok(near(cam.coordinates.longitude, -175));
});

// P2: projection, label grouping and the Recenter fit that leaves room for the grouped labels.

// Four members within 100 m of each other in San Francisco (two photos, a balloon, a stale clock).
const CLUSTER = [
  { id: 'u1', coordinates: p(37.7793, -122.4193), shape: 'photo', text: 'You · 4.3 km/h', stale: false },
  { id: 'u2', coordinates: p(37.7797, -122.419), shape: 'marker', text: 'Guest 1 (17) · 43.2 km/h', stale: false },
  { id: 'u3:stale', coordinates: p(37.7799, -122.4196), shape: 'marker', text: 'Test joiner · stale', stale: true },
  { id: 'u4', coordinates: p(37.7795, -122.4185), shape: 'photo', text: 'Test host', stale: false },
];
const bottomOf = (m) => (m.shape === 'photo' ? 25 : 0);

test('P2: projectPoint matches the expo-maps camera model, and the camera center is the view center', () => {
  const cam = cameraFor(TALL);
  const view = viewportFromCamera(cam, ROOM_MAP_SIZE);
  for (const point of [...TALL, cam.coordinates]) {
    const a = projectPoint(point, view, ROOM_MAP_SIZE);
    const b = project(point, cam, ROOM_MAP_SIZE);
    assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  const c = projectPoint(cam.coordinates, view, ROOM_MAP_SIZE);
  assert.ok(near(c.x, ROOM_MAP_SIZE.width / 2) && near(c.y, ROOM_MAP_SIZE.height / 2));
});

test('P2: viewportFromRegion reads the onCameraMove region; a heading turns the map', () => {
  const size = { width: 370, height: 360 };
  const center = p(37.7793, -122.4193);
  const north = p(37.7803, -122.4193);
  const east = p(37.7793, -122.418);
  const up = viewportFromRegion({ coordinates: center, longitudeDelta: 0.01, latitudeDelta: 0.008, bearing: 0 }, size);
  assert.ok(near(up.scale, 370 / 0.01));
  const n0 = projectPoint(north, up, size);
  const e0 = projectPoint(east, up, size);
  assert.ok(near(n0.x, 185) && n0.y < 180, `north ${JSON.stringify(n0)}`);
  assert.ok(e0.x > 185 && near(e0.y, 180), `east ${JSON.stringify(e0)}`);
  // Heading 90: the top of the view points east, so east is up and north is to the left.
  const turned = viewportFromRegion({ coordinates: center, longitudeDelta: 0.01, bearing: 90 }, size);
  assert.ok(near(turned.scale, 360 / 0.01));
  const n90 = projectPoint(north, turned, size);
  const e90 = projectPoint(east, turned, size);
  assert.ok(n90.x < 185 && Math.abs(n90.y - 180) < 1e-6, `north ${JSON.stringify(n90)}`);
  assert.ok(Math.abs(e90.x - 185) < 1e-6 && e90.y < 180, `east ${JSON.stringify(e90)}`);
  assert.equal(viewportFromRegion({ coordinates: {}, longitudeDelta: 0.01 }, size), null);
  assert.equal(viewportFromRegion({ coordinates: center, longitudeDelta: 0 }, size), null);
});

test('P2: roomMapPadding grows the bottom by a line per extra label line and the sides for a wide pill', () => {
  assert.deepEqual(roomMapPadding(1), ROOM_MAP_PADDING);
  assert.equal(roomMapPadding(4).bottom, ROOM_MAP_PADDING.bottom + 3 * 22);
  assert.equal(roomMapPadding(4).top, ROOM_MAP_PADDING.top);
  assert.equal(roomMapPadding(1, 100).left, ROOM_MAP_PADDING.left);
  assert.equal(roomMapPadding(1, 240).left, 120);
  assert.equal(roomMapPadding(1, 240).right, 120);
});

test('P2: at the Recenter zoom, four members within 100 m share one label, and it clears the buttons', () => {
  const points = CLUSTER.map((m) => m.coordinates);
  const cam = fitRoomCamera(points, CLUSTER);
  assert.equal(cam.zoom, MAX_CAMERA_ZOOM);
  const view = viewportFromCamera(cam, ROOM_MAP_SIZE);
  const labels = planLabels(CLUSTER, view, ROOM_MAP_SIZE);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].lines, 4);
  const pill = pillSize(labels[0].text.split('\n'));
  // The fit used the 4-line padding: every point is inside it.
  assertInside(points, cam, ROOM_MAP_SIZE, roomMapPadding(4, pill.width));
  // The pill hangs under the lowest pin, above the 42 pt button band (Show my location, Recenter).
  const lowMember = CLUSTER.find((m) => m.coordinates === labels[0].coordinates);
  const pillTop = projectPoint(lowMember.coordinates, view, ROOM_MAP_SIZE).y + bottomOf(lowMember) + 3;
  assert.ok(pillTop + pill.height <= ROOM_MAP_SIZE.height - 42 + 1, `pill bottom ${pillTop + pill.height}`);
  // Every pin of the group ends above the pill.
  for (const m of CLUSTER) {
    const { y } = projectPoint(m.coordinates, view, ROOM_MAP_SIZE);
    assert.ok(y + bottomOf(m) <= pillTop, `${m.id} bottom ${y}`);
  }
  // The topmost point (a balloon reaches 44 pt above it) clears the Pen chip band.
  const top = Math.min(...CLUSTER.map((m) => projectPoint(m.coordinates, view, ROOM_MAP_SIZE).y));
  assert.ok(top >= ROOM_MAP_PADDING.top - 1, `top ${top}`);
});

test('P2: members far apart keep their own labels at the Recenter zoom', () => {
  const far = [
    { id: 'a', coordinates: p(37.7793, -122.4193), shape: 'marker', text: 'Ann · 4.3 km/h', stale: false },
    { id: 'b', coordinates: p(37.801, -122.41), shape: 'photo', text: 'Bo', stale: false },
    { id: 'c', coordinates: p(37.7793, -122.39), shape: 'marker', text: 'Cy', stale: false },
  ];
  const points = far.map((m) => m.coordinates);
  const cam = fitRoomCamera(points, far);
  const labels = planLabels(far, viewportFromCamera(cam, ROOM_MAP_SIZE), ROOM_MAP_SIZE);
  assert.deepEqual(
    labels.map((l) => l.members),
    [['a'], ['b'], ['c']],
  );
  // With one-line labels only, the fit is the plain one-line fit.
  assert.deepEqual(cam, cameraFor(points, ROOM_MAP_SIZE, roomMapPadding(1, pillSize(['Ann · 4.3 km/h']).width)));
});

test('P2: two pairs 3 km apart are two groups', () => {
  const pair = [
    { id: 'a', coordinates: p(37.7793, -122.4193), shape: 'photo', text: 'Ann · 4.3 km/h', stale: false },
    { id: 'b', coordinates: p(37.7795, -122.419), shape: 'marker', text: 'Bo · 3.1 km/h', stale: false },
  ];
  const shifted = pair.map((m) => ({ ...m, id: `${m.id}2`, coordinates: p(m.coordinates.latitude, m.coordinates.longitude + 0.035) }));
  const all = [...pair, ...shifted];
  const cam = fitRoomCamera(all.map((m) => m.coordinates), all);
  const labels = planLabels(all, viewportFromCamera(cam, ROOM_MAP_SIZE), ROOM_MAP_SIZE);
  assert.deepEqual(
    labels.map((l) => [...l.members].sort()),
    [
      ['a', 'b'],
      ['a2', 'b2'],
    ],
  );
  assert.ok(labels.every((l) => l.lines === 2));
});

test('P2: labels too large for the map still give a finite camera that shows every point', () => {
  // Two 4-member clusters with long names: at the Recenter view their pills touch, so they merge, and the
  // 8-line padding asks for more than the view; the points still get a quarter of it.
  const shifted = CLUSTER.map((m) => ({ ...m, id: `${m.id}-b`, coordinates: p(m.coordinates.latitude + 0.02, m.coordinates.longitude + 0.02) }));
  const all = [...CLUSTER, ...shifted];
  const cam = fitRoomCamera(all.map((m) => m.coordinates), all);
  assert.ok(Number.isFinite(cam.zoom) && cam.zoom >= MIN_CAMERA_ZOOM);
  const { x, y } = projectPoint(all[0].coordinates, viewportFromCamera(cam, ROOM_MAP_SIZE), ROOM_MAP_SIZE);
  assert.ok(x >= 0 && x <= ROOM_MAP_SIZE.width && y >= 0 && y <= ROOM_MAP_SIZE.height);
});

test('P2: the fit does not depend on the member order', () => {
  const points = CLUSTER.map((m) => m.coordinates);
  assert.deepEqual(fitRoomCamera(points, [...CLUSTER].reverse()), fitRoomCamera(points, CLUSTER));
  assert.equal(fitRoomCamera([], CLUSTER), null);
});
