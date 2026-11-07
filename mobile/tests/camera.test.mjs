// Run: npm test (node --test, Node 24 strips the .ts types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cameraFor, MAX_CAMERA_ZOOM, MIN_CAMERA_ZOOM } from '../src/lib/location-plan.ts';

const p = (latitude, longitude) => ({ latitude, longitude });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('no points: no camera', () => {
  assert.equal(cameraFor([]), null);
  assert.equal(cameraFor([p(NaN, 0), p(91, 0)]), null);
});

test('one point: street level on that point', () => {
  assert.deepEqual(cameraFor([p(37.7793, -122.4193)]), { coordinates: p(37.7793, -122.4193), zoom: MAX_CAMERA_ZOOM });
});

test('the R1 world-scale route (F5-3) fits instead of street-level water', () => {
  const cam = cameraFor([p(-16.1865410712183, -31.9921875), p(4.68227962838259, 17.2265625), p(-44.757135998073, -3.8671875)]);
  assert.ok(near(cam.coordinates.latitude, -20.03742818484521));
  assert.ok(near(cam.coordinates.longitude, -7.3828125));
  // Span 49.4 deg x 1.4 padding -> about zoom 2.38, so the whole route is in view.
  assert.ok(cam.zoom > 2 && cam.zoom < 3, `zoom ${cam.zoom}`);
  assert.ok(360 / 2 ** cam.zoom >= 49.4);
});

test('a city-scale route zooms to fit, not to the clamp', () => {
  const cam = cameraFor([p(37.7793, -122.4193), p(37.7810, -122.4170), p(37.7900, -122.4000)]);
  assert.ok(cam.zoom > 10 && cam.zoom < MAX_CAMERA_ZOOM, `zoom ${cam.zoom}`);
  assert.ok(360 / 2 ** cam.zoom >= (37.79 - 37.7793) * 1.4);
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
});

test('the antimeridian center stays in [-180, 180]', () => {
  const cam = cameraFor([p(0, 170), p(0, -160)]);
  assert.ok(near(cam.coordinates.longitude, -175));
});
