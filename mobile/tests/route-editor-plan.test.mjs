// Run: npm test. UI v2 (2): the route editor never opens on the world view; routes over 200 km are not saved.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  editorStartCamera,
  MAX_ROUTE_KM,
  MIN_EDITOR_ZOOM,
  regionalDefaultCamera,
  routeTooLong,
} from '../src/lib/route-editor-plan.ts';
import { routeLengthMeters } from '../src/lib/location-plan.ts';

const sf = { latitude: 37.7749, longitude: -122.4194 };
const mine = { coordinates: { latitude: 37.33, longitude: -122.03 }, zoom: 15 };

test('the room map view is kept when zoomed in, a world view is not', () => {
  const view = { coordinates: sf, zoom: 13 };
  assert.deepEqual(editorStartCamera({ lastView: view, roomCamera: mine, timeZone: 'Asia/Seoul' }), view);
  const world = { coordinates: { latitude: 20, longitude: -40 }, zoom: 2 };
  assert.deepEqual(editorStartCamera({ lastView: world, roomCamera: mine, timeZone: null }), mine);
  assert.ok(MIN_EDITOR_ZOOM > world.zoom);
});

test('no room points and no position: a regional default by time zone, never the world', () => {
  const seoul = editorStartCamera({ lastView: null, roomCamera: null, timeZone: 'Asia/Seoul' });
  assert.deepEqual(seoul.coordinates, { latitude: 37.5665, longitude: 126.978 });
  assert.ok(seoul.zoom >= MIN_EDITOR_ZOOM);
  // Unknown zone: the Los Angeles default.
  assert.deepEqual(regionalDefaultCamera('Mars/Base').coordinates, sf);
  assert.deepEqual(regionalDefaultCamera(undefined).coordinates, sf);
  const world = { coordinates: { latitude: 0, longitude: 0 }, zoom: 1 };
  assert.deepEqual(editorStartCamera({ lastView: world, roomCamera: null, timeZone: 'Europe/London' }).coordinates, {
    latitude: 51.5072,
    longitude: -0.1276,
  });
});

const tooLong = (points) => routeTooLong(routeLengthMeters(points));

test('routes over 200 km are refused; a long run is not', () => {
  assert.equal(MAX_ROUTE_KM, 200);
  // qa: one swipe across the Atlantic, about 14,000 km.
  assert.equal(tooLong([{ latitude: 40.7, longitude: -74 }, { latitude: 51.5, longitude: -0.13 }]), true);
  // A marathon-ish line (about 42 km) and a short loop are fine.
  assert.equal(tooLong([sf, { latitude: 38.15, longitude: -122.4194 }]), false);
  assert.equal(tooLong([sf, { latitude: 37.78, longitude: -122.42 }, sf]), false);
  // About 222 km (2 degrees of latitude): refused.
  assert.equal(tooLong([sf, { latitude: 39.7749, longitude: -122.4194 }]), true);
  assert.equal(tooLong([]), false);
});
