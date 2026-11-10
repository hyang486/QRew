// Run: npm test (node --test, Node 24 strips the .ts types).
// G4 (#5) qa repro, 2026-11-08 (docs/evidence/2026-11-08-rc-g4-a-recenter.png, rc-g4-a-zoom.png):
// the "Saturday Run Crew" loop and four members on the 17 Pro room map (370 x 360 pt).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fitRoomCamera,
  LABEL_GROUP_MARGIN,
  layoutLabels,
  MAX_PILL_GAP,
  pillCandidates,
  placePills,
  pinBodyRect,
  projectPoint,
  ROOM_MAP_PADDING,
  routeOverlap,
  viewportFromCamera,
} from '../src/lib/location-plan.ts';

const SIZE = { width: 370, height: 360 };
const ROUTE = [
  [34.0557663202692, -118.246494871913],
  [34.0568336763707, -118.244121653461],
  [34.0547832172327, -118.242596013028],
  [34.0540809937975, -118.242426497424],
  [34.052676529476, -118.244121653461],
  [34.0521147372324, -118.24496923148],
  [34.0523956338195, -118.245816809498],
  [34.0532383179967, -118.247511965536],
  [34.0540809937975, -118.247342449932],
  [34.0549236612216, -118.247003418724],
  [34.0557101432599, -118.246494871913],
].map(([latitude, longitude]) => ({ latitude, longitude }));
const pin = (id, latitude, longitude, text) => ({ id, coordinates: { latitude, longitude }, shape: 'marker', text, stale: false });
const PINS = [
  pin('host', 34.0563, -118.2468, 'You'),
  pin('g1', 34.056, -118.244, 'Guest 1 (17)'),
  pin('g3', 34.054, -118.2425, 'Guest 3 (17e) · Need water'),
  pin('g4', 34.0532, -118.2455, 'Guest 4 (ProMax) · Need water'),
];

function overlaps(a, b) {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}
function gap(a, b) {
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
}

// The map area a pill may use: under the Pen / compass band, above the Show my location / Recenter band.
const FREE = { left: 0, right: SIZE.width, top: ROOM_MAP_PADDING.top, bottom: SIZE.height - 42 };
const grow = (r, m) => ({ left: r.left - m, right: r.right + m, top: r.top - m, bottom: r.bottom + m });
// F5 (qa v2, docs/evidence/2026-11-08-rc-g4-a-recenter-v2.png): MapKit's right control column (tracking
// button, and the 3D button under it when pitch is offered) reaches ~114 pt down, x >= width - 64.
const COLUMN = { left: SIZE.width - 64, right: SIZE.width, top: 0, bottom: 118 };
const inside = (r) =>
  r.left >= FREE.left && r.right <= FREE.right && r.top >= FREE.top && r.bottom <= FREE.bottom && !overlaps(r, COLUMN);

function check(view, label) {
  const { groups, plans } = layoutLabels(PINS, view, SIZE, ROUTE);
  const line = ROUTE.map((p) => projectPoint(p, view, SIZE));
  const bodies = PINS.map((p) => ({ id: p.id, rect: pinBodyRect({ ...p, ...projectPoint(p.coordinates, view, SIZE) }) }));
  plans.forEach((plan, k) => {
    const name = `${label}: ${groups[k].map((m) => m.id).join('+')}`;
    for (const body of bodies) assert.ok(!overlaps(plan.rect, body.rect), `${name} covers pin ${body.id}`);
    plans.forEach((other, m) => assert.ok(m === k || !overlaps(plan.rect, other.rect), `${name} covers another pill`));
    assert.ok(plan.rect.left >= 0 && plan.rect.right <= SIZE.width, `${name} leaves the map sideways`);
    assert.ok(plan.rect.top >= 0 && plan.rect.bottom <= SIZE.height, `${name} leaves the map vertically`);
    assert.ok(gap(plan.rect, pinBodyRect(plan.pin)) <= MAX_PILL_GAP, `${name} is too far from its pin`);
    // The route: covered only when no candidate of this group is clear of the pins, the other pills, the
    // button bands and the line; and then at most 120 pt of line (a 4 pt line: 480 pt²).
    const covered = routeOverlap(plan.rect, line);
    if (covered > 0) {
      const obstacles = [...bodies.map((b) => b.rect), ...plans.filter((_, m) => m !== k).map((p) => p.rect)];
      const clear = pillCandidates(groups[k]).find(
        (c) => inside(c.rect) && obstacles.every((o) => !overlaps(grow(c.rect, LABEL_GROUP_MARGIN), o)) && routeOverlap(c.rect, line) === 0,
      );
      assert.equal(clear, undefined, `${name} covers the route although ${clear?.placement} ${clear?.variant ?? ''} is clear`);
      assert.ok(covered <= 480, `${name} covers ${covered / 4} pt of route`);
    }
  });
  return { groups, plans };
}

const camera = fitRoomCamera([...ROUTE, ...PINS.map((p) => p.coordinates)], PINS, SIZE, ROUTE);

test('G4 repro, Recenter: no pill covers a pin or a pill, nor the route while a clear spot exists; inside the map, near its pin', () => {
  const { plans } = check(viewportFromCamera(camera, SIZE), 'recenter');
  assert.equal(plans.length, 4);
});

test('G4 repro, pinch in on G4: pills of pins outside the map are not drawn; the rest pass the same checks', () => {
  for (const zoom of [camera.zoom + 1, camera.zoom + 1.5, camera.zoom + 2]) {
    const view = viewportFromCamera({ coordinates: PINS[3].coordinates, zoom }, SIZE);
    const { groups } = check(view, `zoom ${zoom}`);
    for (const g of groups) {
      assert.ok(
        g.some((m) => m.x >= 0 && m.x <= SIZE.width && m.y >= 0 && m.y <= SIZE.height),
        `zoom ${zoom}: a pill for ${g.map((m) => m.id)} whose pins are all off the map`,
      );
    }
  }
});

test('G4 (supervisor n2): a lone wrapped pill near the bottom band goes beside or above its pin, never clipped', () => {
  // A marker 20 pt above the Show my location / Recenter band: a 2-line pill below it would run into the band.
  const lone = [{ id: 'a', x: 185, y: SIZE.height - 42 - 20, shape: 'marker', text: 'Guest 4 (ProMax) · Need water', stale: false, coordinates: { latitude: 0, longitude: 0 } }];
  const plan = placePills([lone], SIZE)[0];
  assert.ok(inside(plan.rect), JSON.stringify(plan));
  assert.notEqual(plan.placement, 'below');
});


test('G4 F5: a pin near the top right never puts its pill under the map control column', () => {
  for (const [x, y] of [[230, 125], [250, 110], [280, 140], [300, 120]]) {
    const pin = { id: 'g1', x, y, shape: 'marker', text: 'Guest 1 (17)', stale: false, coordinates: { latitude: 0, longitude: 0 } };
    const plan = placePills([[pin]], SIZE)[0];
    assert.ok(!overlaps(plan.rect, COLUMN), `pin at ${x},${y}: ${plan.placement} ${JSON.stringify(plan.rect)}`);
    assert.ok(inside(plan.rect), `pin at ${x},${y} pill leaves the free area`);
  }
});

test('G4 F5: the qa Recenter geometry keeps every pill clear of the control column', () => {
  const { plans } = layoutLabels(PINS, viewportFromCamera(camera, SIZE), SIZE, ROUTE);
  for (const plan of plans) assert.ok(!overlaps(plan.rect, COLUMN), `${plan.pin.id}: ${JSON.stringify(plan.rect)}`);
});
