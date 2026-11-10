// Run: npm test (node --test, Node 24 strips the .ts types).
// #10: the route length label (haversine, km with one decimal) on the Map screen and in the route editor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en } from '../src/i18n/en.ts';
import { formatRouteKm, routeLengthMeters } from '../src/lib/location-plan.ts';
import { joinStrokes } from '../src/lib/route-draw.ts';

// One degree of latitude on a 6,371 km sphere: 6371000 * PI / 180 = 111,194.9 m.
const DEG_M = (6_371_000 * Math.PI) / 180;
const at = (latitude, longitude) => ({ latitude, longitude });

test('an empty or one-point route has no length and no label', () => {
  assert.equal(routeLengthMeters([]), 0);
  assert.equal(routeLengthMeters([at(37.77, -122.42)]), 0);
  assert.equal(formatRouteKm([]), null);
  assert.equal(formatRouteKm([at(37.77, -122.42)]), null);
});

test('one degree of latitude is about 111.2 km', () => {
  const route = [at(0, 0), at(1, 0)];
  assert.ok(Math.abs(routeLengthMeters(route) - DEG_M) < 1e-6);
  assert.equal(formatRouteKm(route), '111.2 km');
});

test('the length sums every segment in order, not the straight start-to-end distance', () => {
  // Out 0.02 deg north and back: 2 * 2.224 km = 4.4 km, while start and end are the same point.
  const route = [at(37.7, -122.4), at(37.72, -122.4), at(37.7, -122.4)];
  assert.ok(Math.abs(routeLengthMeters(route) - 2 * 0.02 * DEG_M) < 1e-3);
  assert.equal(formatRouteKm(route), '4.4 km');
});

test('a 5 km loop along the equator reads "Route 5.0 km"; a short one keeps its decimal', () => {
  const step = 5000 / DEG_M; // degrees of longitude for 5 km on the equator
  assert.equal(en.map.routeDistance(formatRouteKm([at(0, 0), at(0, step / 2), at(0, step)])), 'Route 5.0 km');
  assert.equal(formatRouteKm([at(0, 0), at(0, 400 / DEG_M)]), '0.4 km');
  assert.equal(formatRouteKm([at(0, 0), at(0, 5200 / DEG_M)]), '5.2 km');
});

test('a route shorter than 0.05 km reads "< 0.1 km" instead of 0.0', () => {
  assert.equal(formatRouteKm([at(0, 0), at(0, 30 / DEG_M)]), '< 0.1 km');
  assert.equal(formatRouteKm([at(0, 0), at(0, 0)]), '< 0.1 km');
  assert.equal(formatRouteKm([at(0, 0), at(0, 60 / DEG_M)]), '0.1 km');
});

test('invalid points are skipped, and fewer than 2 valid points hide the label', () => {
  const route = [at(0, 0), at(Number.NaN, 0), at(1, 0), at(200, 500)];
  assert.ok(Math.abs(routeLengthMeters(route) - DEG_M) < 1e-6);
  assert.equal(formatRouteKm([at(0, 0), at(Number.NaN, 1)]), null);
});

test('editor strokes are measured as the one joined line the map draws and Done saves', () => {
  // The saved route is joinStrokes(draft): the jump from one stroke's end to the next stroke's start is part
  // of the drawn polyline, so the editor and the Map screen agree after saving.
  const strokes = [
    [at(0, 0), at(0.01, 0)],
    [at(0.02, 0), at(0.03, 0)],
  ];
  assert.ok(Math.abs(routeLengthMeters(joinStrokes(strokes)) - 0.03 * DEG_M) < 1e-3);
  assert.equal(formatRouteKm(joinStrokes(strokes)), '3.3 km');
});
