// Run: npm test (node --test, Node 24 strips the .ts types).
// P2: grouped member labels (pure screen-space grouping, label ids, anchors).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countOverlaps,
  groupPins,
  LABEL_JOIN,
  layoutLabels,
  labelAnchor,
  labelId,
  labelPins,
  placePill,
  placePills,
  planLabels,
  planPins,
  projectPoint,
  viewportFromRegion,
} from '../src/lib/location-plan.ts';

const at = (id, x, y, shape = 'marker', text = `${id} · 4.3 km/h`) => ({
  id,
  x,
  y,
  shape,
  text,
  stale: false,
  coordinates: { latitude: 0, longitude: 0 },
});
const ids = (groups) => groups.map((g) => g.map((m) => m.id));

test('groupPins: a lone pin is its own group', () => {
  assert.deepEqual(ids(groupPins([at('a', 100, 100)])), [['a']]);
  assert.deepEqual(groupPins([]), []);
});

test('groupPins: pins farther apart than LABEL_JOIN stay separate, even when their pills would touch', () => {
  assert.deepEqual(ids(groupPins([at('a', 60, 80), at('b', 300, 80), at('c', 60, 300), at('d', 300, 300)])), [
    ['a'],
    ['b'],
    ['c'],
    ['d'],
  ]);
  // 80 pt apart side by side: two ~130 pt pills under them would overlap, but that is for placement to solve.
  assert.deepEqual(ids(groupPins([at('a', 100, 100), at('b', 180, 100)])), [['a'], ['b']]);
  assert.deepEqual(ids(groupPins([at('a', 100, 100), at('b', 100, 100 + LABEL_JOIN)])), [['a', 'b']]);
  assert.deepEqual(ids(groupPins([at('a', 100, 100), at('b', 100, 100 + LABEL_JOIN + 1)])), [['a'], ['b']]);
});

test('groupPins: complete link, a chain of close pins never stretches into one group', () => {
  // a-b 40, b-c 40, a-c 80: no group may hold both a and c.
  const groups = ids(groupPins([at('a', 40, 100), at('b', 80, 100), at('c', 120, 100)]));
  assert.ok(!groups.some((g) => g.includes('a') && g.includes('c')), JSON.stringify(groups));
  assert.equal(groups.flat().length, 3);
  const chain = [at('a', 40, 100), at('b', 80, 100), at('c', 120, 100), at('d', 160, 100)];
  assert.deepEqual(ids(groupPins(chain)), [['a', 'b'], ['c', 'd']]);
});

test('groupPins: every two members of a group are within LABEL_JOIN', () => {
  const pins = [at('a', 100, 100), at('b', 130, 110), at('c', 150, 140), at('d', 170, 100), at('e', 110, 150), at('f', 125, 125)];
  for (const group of groupPins(pins)) {
    for (const p of group) for (const q of group) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) <= LABEL_JOIN);
  }
});

test('groupPins: deterministic, whatever the input order; groups by smallest id, lines top to bottom', () => {
  const pins = [at('d', 300, 300), at('b', 100, 80), at('c', 300, 320), at('a', 120, 60)];
  const expected = [['a', 'b'], ['d', 'c']];
  assert.deepEqual(ids(groupPins(pins)), expected);
  assert.deepEqual(ids(groupPins([...pins].reverse())), expected);
  assert.deepEqual(ids(groupPins([pins[2], pins[0], pins[3], pins[1]])), expected);
});

test('labelAnchor: the pill starts 3 pt under the balloon tip, or 25 + 3 pt under a photo point', () => {
  assert.deepEqual(labelAnchor('marker', 1), { x: 0.5, y: -3 / 30 });
  assert.deepEqual(labelAnchor('photo', 1), { x: 0.5, y: -28 / 30 });
  // A taller pill: the same offset in points, so a smaller fraction.
  assert.deepEqual(labelAnchor('photo', 3), { x: 0.5, y: -28 / 70 });
});

test('labelId: changes with the member set, a member going stale, a shape change, the pin it hangs from or its side', () => {
  const a = { id: 'u1', shape: 'photo' };
  const b = { id: 'u2', shape: 'marker' };
  const base = labelId([a, b], a);
  assert.equal(base, labelId([b, a], a), 'member order does not matter');
  assert.equal(base, 'label:u1=photo,u2=marker@u1=photo:below');
  const variants = [
    labelId([a], a),
    labelId([a, b, { id: 'u3', shape: 'marker' }], a),
    labelId([a, { id: 'u2:stale', shape: 'marker' }], a),
    labelId([{ id: 'u1', shape: 'marker' }, b], { id: 'u1', shape: 'marker' }),
    labelId([a, b], b),
    labelId([a, b], a, 'above'),
    labelId([a, b], a, 'below', 'left'),
    labelId([a, b], a, 'below', 'right'),
  ];
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
});

test('planLabels: a lone member keeps a one-line pill under its own pin', () => {
  const pins = [{ id: 'u1', coordinates: { latitude: 37.7, longitude: -122.4 }, shape: 'photo', text: 'You · 4.3 km/h', stale: false }];
  const view = { center: { latitude: 37.7, longitude: -122.4 }, scale: 30000, bearing: 0 };
  assert.deepEqual(planLabels(pins, view, { width: 370, height: 360 }), [
    {
      id: 'label:u1=photo@u1=photo:below',
      coordinates: pins[0].coordinates,
      text: 'You · 4.3 km/h',
      anchor: labelAnchor('photo', 1),
      lines: 1,
      stale: false,
      members: ['u1'],
      placement: 'below',
      align: 'center',
    },
  ]);
});

test('planLabels: a group gets one pill, lines top to bottom, under the pin that reaches lowest', () => {
  const view = { center: { latitude: 37.7, longitude: -122.4 }, scale: 30000, bearing: 0 };
  const size = { width: 370, height: 360 };
  // About 1 m apart: one group. The marker point is a little south of the photo point, but the photo's
  // lower half reaches lower on screen, so the pill hangs under the photo.
  const photo = { id: 'p', coordinates: { latitude: 37.70001, longitude: -122.4 }, shape: 'photo', text: 'Pat · 1.0 km/h', stale: false };
  const marker = { id: 'm', coordinates: { latitude: 37.7, longitude: -122.40001 }, shape: 'marker', text: 'Mo · stale', stale: true };
  const [label, ...rest] = planLabels([marker, photo], view, size);
  assert.equal(rest.length, 0);
  assert.equal(label.text, 'Pat · 1.0 km/h\nMo · stale');
  assert.equal(label.lines, 2);
  assert.equal(label.coordinates, photo.coordinates);
  assert.deepEqual(label.anchor, labelAnchor('photo', 2));
  assert.equal(label.id, 'label:m=marker,p=photo@p=photo:below');
  assert.equal(label.stale, false, 'one fresh member: normal text color');
  const allStale = planLabels([marker, { ...photo, stale: true }], view, size)[0];
  assert.equal(allStale.stale, true);
});

test('planLabels: with no viewport every pin keeps its own label', () => {
  const pins = [
    { id: 'b', coordinates: { latitude: 1, longitude: 1 }, shape: 'marker', text: 'B', stale: false },
    { id: 'a', coordinates: { latitude: 1, longitude: 1 }, shape: 'marker', text: 'A', stale: false },
  ];
  assert.deepEqual(
    planLabels(pins, null, { width: 370, height: 360 }).map((l) => l.members),
    [['a'], ['b']],
  );
});

test('labelPins: shape and stale come from the pin plan; the id follows the fresh/stale pin id', () => {
  const NOW = Date.parse('2026-11-07T12:00:00Z');
  const fresh = new Date(NOW - 5_000).toISOString();
  const old = new Date(NOW - 120_000).toISOString();
  const input = (userId, updatedAt, avatarPath) => ({
    userId,
    coordinates: { latitude: 37.7, longitude: -122.4 },
    updatedAt,
    speedMps: 1.2,
    label: userId,
    initialsOf: userId,
    avatarPath,
  });
  const pins = planPins(
    [input('u1', fresh, 'u1/a.jpg'), input('u2', fresh, null), input('u3', old, 'u3/a.jpg')],
    NOW,
    new Map([['u1/a.jpg', 'ICON'], ['u3/a.jpg', 'ICON']]),
  );
  assert.deepEqual(
    labelPins(pins).map(({ id, shape, text, stale }) => ({ id, shape, text, stale })),
    [
      { id: 'u1', shape: 'photo', text: 'u1 · 4.3 km/h', stale: false },
      { id: 'u2', shape: 'marker', text: 'u2 · 4.3 km/h', stale: false },
      { id: 'u3:stale', shape: 'marker', text: 'u3 · stale', stale: true },
    ],
  );
});

// P2 placement flip. The room map's bands: the top 88 pt (Pen, compass, tracking) and the bottom 42 pt
// (Show my location, Recenter).
const SIZE = { width: 370, height: 360 };
const TOP_BAND = 88;
const BOTTOM_LIMIT = SIZE.height - 42;

test('labelAnchor: above puts the pill bottom 3 pt over the balloon top (44 pt) or the photo top (25 pt)', () => {
  assert.deepEqual(labelAnchor('marker', 1, 'above'), { x: 0.5, y: 1 + 47 / 30 });
  assert.deepEqual(labelAnchor('photo', 2, 'above'), { x: 0.5, y: 1 + 28 / 50 });
  assert.deepEqual(labelAnchor('photo', 2, 'below'), labelAnchor('photo', 2));
});

test('labelAnchor: a reaching pill keeps its edge at the pin body edge', () => {
  // 100 pt wide over a 40 pt balloon: reaching left, the pin point is 20 pt from the right edge.
  assert.deepEqual(labelAnchor('marker', 1, 'below', 'left', 100), { x: 0.8, y: -3 / 30 });
  assert.deepEqual(labelAnchor('marker', 1, 'below', 'right', 100), { x: 0.2, y: -3 / 30 });
  // A pill narrower than the pin body stays centred.
  assert.deepEqual(labelAnchor('photo', 1, 'above', 'left', 40), { x: 0.5, y: 1 + 28 / 30 });
});

test('placePill: below and centred when it fits', () => {
  const plan = placePill([at('a', 100, 200)], SIZE);
  assert.equal(plan.placement, 'below');
  assert.equal(plan.align, 'center');
  assert.equal(plan.pin.id, 'a');
  assert.deepEqual(plan.rect, { left: 44, right: 156, top: 203, bottom: 235 });
});

test('placePill: above the highest pin when the bottom band leaves no room below', () => {
  const plan = placePill([at('a', 100, 280), at('b', 120, 250)], SIZE);
  assert.equal(plan.placement, 'above');
  assert.equal(plan.pin.id, 'b');
  assert.ok(plan.rect.top >= TOP_BAND && plan.rect.bottom === 250 - 44 - 3, JSON.stringify(plan.rect));
});

test('placePill: near the right edge it reaches left instead of running off the map', () => {
  const plan = placePill([at('a', 340, 200)], SIZE);
  assert.equal(plan.placement, 'below');
  assert.equal(plan.align, 'left');
  assert.equal(plan.rect.right, 360);
});

test('placePill: with no size (no viewport) always below and centred', () => {
  const plan = placePill([at('a', 100, 350)]);
  assert.equal(plan.placement, 'below');
  assert.equal(plan.align, 'center');
});

test('placePills: two side-by-side pins 80 pt apart get two clear pills', () => {
  const groups = groupPins([at('a', 150, 150), at('b', 230, 150)]);
  const plans = placePills(groups, SIZE);
  assert.equal(plans.length, 2);
  assert.equal(countOverlaps(groups, plans), 0);
});

test('placePills: deterministic for the same pins in any input order', () => {
  const pins = [at('a', 150, 150), at('b', 230, 150), at('c', 190, 200), at('d', 120, 230)];
  const run = (list) => JSON.stringify(placePills(groupPins(list), SIZE).map((p) => [p.pin.id, p.placement, p.align]));
  assert.equal(run(pins), run([...pins].reverse()));
});

test('placePills: worst case, a crowd with no clear spot overlaps and the overlap is counted', () => {
  // Six pins 60 pt apart in a 3 x 2 grid, each its own group, in a map only 220 pt square.
  const small = { width: 220, height: 220 };
  const pins = [0, 1, 2].flatMap((c) => [0, 1].map((r) => at(`p${c}${r}`, 50 + 60 * c, 110 + 60 * r)));
  const groups = groupPins(pins);
  assert.equal(groups.length, 6);
  const plans = placePills(groups, small);
  assert.equal(plans.length, 6, 'every group keeps a pill');
  assert.ok(countOverlaps(groups, plans) > 0);
});

// Replays of the room map logged during qa's (B) repro on 2026-11-07 (docs/evidence/2026-11-07-p2dbg-2-zoom-pan.png).
const LOGGED = [
  ['you', 34.049, -118.251, 'You'],
  ['g1', 34.04935, -118.2506, 'Guest 1 (17)'],
  ['g3', 34.0487, -118.2505, 'Guest 3 (17e)'],
  ['g4', 34.0492, -118.2515, 'Guest 4 (ProMax)'],
].map(([id, latitude, longitude, text]) => ({ id, coordinates: { latitude, longitude }, shape: 'marker', text, stale: false }));
const B_VIEWS = {
  // Zoom 16.96 after the pinch (18:37), and after the small pan (screenshot p2dbg-2).
  pinch: { center: { latitude: 34.04953234210502, longitude: -118.2510292043691 }, scale: 131098.49169990513, bearing: 0 },
  pan: { center: { latitude: 34.04937433978925, longitude: -118.2510292043691 }, scale: 131098.49169990513, bearing: 0 },
};

/** Checks every label hangs from a pin of its own group, at most LABEL_JOIN from every member. */
function assertHonest(groups, plans) {
  groups.forEach((group, k) => {
    assert.ok(group.includes(plans[k].pin));
    for (const m of group) assert.ok(Math.hypot(m.x - plans[k].pin.x, m.y - plans[k].pin.y) <= LABEL_JOIN);
  });
}

for (const [name, view] of Object.entries(B_VIEWS)) {
  test(`replay (B, ${name}): pins 73-82 pt apart are four pills, none overlapping`, () => {
    const { groups, plans } = layoutLabels(LOGGED, view, SIZE);
    assert.deepEqual(ids(groups), [['g1'], ['g3'], ['g4'], ['you']]);
    assertHonest(groups, plans);
    assert.equal(countOverlaps(groups, plans), 0);
    // No pill reaches into the top band; at most ~4 pt into the bottom band (pan: G3's pill, whose other
    // candidates would cover You's pin or another pill; reported, not hidden).
    for (const plan of plans) {
      assert.ok(plan.rect.top >= TOP_BAND && plan.rect.bottom <= BOTTOM_LIMIT + 4, `${plan.pin.id} ${JSON.stringify(plan.rect)}`);
    }
  });
}

// (C2) after Recenter with G4 ~5 km away (docs/evidence/2026-11-07-p2c-C2-lone-member-far.png), screen points
// read off the screenshot (G1 is hidden under G3): the cluster's pill used to chain into G4's.
const C2 = [
  at('g1', 139, 128, 'marker', 'Guest 1 (17)'),
  at('you', 141, 136, 'marker', 'You'),
  at('g3', 142, 126, 'marker', 'Guest 3 (17e)'),
  at('g4', 254, 192, 'marker', 'Guest 4 (ProMax)'),
];

test('replay (C2): the far member gets its own pill; the cluster pill never names G4', () => {
  const groups = groupPins(C2);
  assert.deepEqual(ids(groups), [['g3', 'g1', 'you'], ['g4']]);
  const plans = placePills(groups, SIZE);
  assertHonest(groups, plans);
  assert.equal(plans[1].pin.id, 'g4');
  assert.equal(countOverlaps(groups, plans), 0);
  assert.deepEqual(ids(groupPins([...C2].reverse())), ids(groups));
});

// (E) rotated: the onCameraMove logged on :8082 at a 261° heading (docs/evidence/2026-11-07-p2dbg-5-rotated.png).
const E_REGION = {
  coordinates: { latitude: 34.04159543916342, longitude: -118.22971946790581 },
  latitudeDelta: 0.11734404574193036,
  longitudeDelta: 0.13882262382614385,
  bearing: 260.9824469276233,
};
const E_PINS = [
  ['g4', 34.028, -118.205, 'Guest 4 (ProMax)'],
  ['you', 34.049, -118.251, 'You'],
  ['g3', 34.0487, -118.2505, 'Guest 3 (17e)'],
  ['g1', 34.04935, -118.2506, 'Guest 1 (17)'],
].map(([id, latitude, longitude, text]) => ({ id, coordinates: { latitude, longitude }, shape: 'marker', text, stale: false }));

test('viewportFromRegion (E, rotated 261°): pins land within 5 pt of the screenshot; the box height agrees', () => {
  const view = viewportFromRegion(E_REGION, SIZE);
  // Balloon tips read off p2dbg-5-rotated.png (map points): G1 (221, 123), G4 (124.5, 245).
  const g1 = projectPoint(E_PINS[3].coordinates, view, SIZE);
  const g4 = projectPoint(E_PINS[0].coordinates, view, SIZE);
  assert.ok(Math.hypot(g1.x - 221, g1.y - 123) < 5, JSON.stringify(g1));
  assert.ok(Math.hypot(g4.x - 124.5, g4.y - 245) < 5, JSON.stringify(g4));
  // The region is the bounding box of the turned view: its latitude span, in points, is that box's height.
  const t = (E_REGION.bearing * Math.PI) / 180;
  const boxHeight = SIZE.width * Math.abs(Math.sin(t)) + SIZE.height * Math.abs(Math.cos(t));
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * (180 / Math.PI);
  const c = E_REGION.coordinates.latitude;
  const spanPts = (merc(c + E_REGION.latitudeDelta / 2) - merc(c - E_REGION.latitudeDelta / 2)) * view.scale;
  assert.ok(Math.abs(spanPts - boxHeight) < 2, `${spanPts} vs ${boxHeight}`);
});

test('replay (E, rotated): the cluster has one pill, G4 its own, no overlap', () => {
  const view = viewportFromRegion(E_REGION, SIZE);
  const { groups, plans } = layoutLabels(E_PINS, view, SIZE);
  assert.deepEqual(ids(groups).map((g) => [...g].sort()), [['g1', 'g3', 'you'], ['g4']]);
  assertHonest(groups, plans);
  assert.equal(countOverlaps(groups, plans), 0);
});
