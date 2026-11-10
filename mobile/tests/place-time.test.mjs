// Run: npm test. Place and time unit (migration 0026): optional meeting place, pin and start time.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_PLACE_NAME,
  mapsUrl,
  normalizePlaceName,
  clampStart,
  pinAfterNameChange,
  pinAreaLabel,
  placeTimeArgs,
  placeTimeOf,
  startTimeError,
  startTimeRange,
} from '../src/lib/place-time.ts';

const HOUR = 3_600_000;

test('a blank place name counts as no place; names are trimmed and capped', () => {
  assert.equal(normalizePlaceName(''), null);
  assert.equal(normalizePlaceName('   '), null);
  assert.equal(normalizePlaceName('  North Gate  '), 'North Gate');
  assert.equal(normalizePlaceName('x'.repeat(100)).length, MAX_PLACE_NAME);
});

test('no place and no time sends no extra arguments (old behaviour)', () => {
  assert.deepEqual(placeTimeArgs({ placeName: '', pin: null, startsAt: null }), {});
});

test('a place name without a pin sends only the name', () => {
  assert.deepEqual(placeTimeArgs({ placeName: ' North Gate ', pin: null, startsAt: null }), {
    p_place_name: 'North Gate',
  });
});

test('a pin is sent only with a place name', () => {
  const pin = { latitude: 37.77, longitude: -122.45 };
  assert.deepEqual(placeTimeArgs({ placeName: 'North Gate', pin, startsAt: null }), {
    p_place_name: 'North Gate',
    p_place_lat: 37.77,
    p_place_lng: -122.45,
  });
  assert.deepEqual(placeTimeArgs({ placeName: '  ', pin, startsAt: null }), {});
});

test('an out-of-range or non-finite pin is dropped, the name kept', () => {
  for (const pin of [
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: Number.NaN, longitude: 0 },
  ]) {
    assert.deepEqual(placeTimeArgs({ placeName: 'Park', pin, startsAt: null }), { p_place_name: 'Park' });
  }
});

test('a start time is sent as ISO', () => {
  const startsAt = new Date('2026-11-14T17:00:00Z');
  assert.deepEqual(placeTimeArgs({ placeName: '', pin: null, startsAt }), {
    p_starts_at: '2026-11-14T17:00:00.000Z',
  });
});

test('the start time must be before the room closes and not more than a day ago (create_room rule)', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const expires = now + 4 * 24 * HOUR;
  assert.equal(startTimeError(null, expires, now), null);
  assert.equal(startTimeError(new Date(now + HOUR), expires, now), null);
  assert.equal(startTimeError(new Date(expires), expires, now), 'afterClose');
  assert.equal(startTimeError(new Date(expires + HOUR), expires, now), 'afterClose');
  assert.equal(startTimeError(new Date(now - 25 * HOUR), expires, now), 'tooEarly');
  assert.equal(startTimeError(new Date(now - HOUR), expires, now), null);
});

test('the picker range runs from now to one minute before the room closes', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const { start, end } = startTimeRange(now + 3 * HOUR, now);
  assert.equal(start.getTime(), now);
  assert.equal(end.getTime(), now + 3 * HOUR - 60_000);
});

test('placeTimeOf reads the room fields; an empty room has nothing to show', () => {
  assert.equal(
    placeTimeOf({ place_name: null, place_lat: null, place_lng: null, starts_at: null }),
    null,
  );
  assert.deepEqual(
    placeTimeOf({ place_name: 'North Gate', place_lat: 37.77, place_lng: -122.45, starts_at: null }),
    { placeName: 'North Gate', pin: { latitude: 37.77, longitude: -122.45 }, startsAt: null },
  );
  const t = placeTimeOf({ place_name: null, place_lat: null, place_lng: null, starts_at: '2026-11-14T17:00:00Z' });
  assert.equal(t.placeName, null);
  assert.equal(t.pin, null);
  assert.equal(t.startsAt.toISOString(), '2026-11-14T17:00:00.000Z');
});

test('Maps links search by name and drop the pin when there is one', () => {
  assert.equal(mapsUrl('apple', 'North Gate & Co', null), 'https://maps.apple.com/?q=North%20Gate%20%26%20Co');
  assert.equal(
    mapsUrl('apple', 'North Gate', { latitude: 37.77, longitude: -122.45 }),
    'https://maps.apple.com/?q=North%20Gate&ll=37.77,-122.45',
  );
  assert.equal(
    mapsUrl('google', 'North Gate', null),
    'https://www.google.com/maps/search/?api=1&query=North%20Gate',
  );
  assert.equal(
    mapsUrl('google', 'North Gate', { latitude: 37.77, longitude: -122.45 }),
    'https://www.google.com/maps/search/?api=1&query=37.77%2C-122.45',
  );
});

test('qa 4: any change of the place name drops the pin', () => {
  const pin = { latitude: 37.788, longitude: -122.407 };
  assert.equal(pinAfterNameChange(pin, 'Union Square', 'Union Hall'), null);
  assert.equal(pinAfterNameChange(pin, 'Union Square', 'Union Square '), null);
  assert.equal(pinAfterNameChange(pin, 'Union Square', ''), null);
  assert.equal(pinAfterNameChange(pin, 'Union Square', 'Union Square'), pin);
  assert.equal(pinAfterNameChange(null, 'a', 'b'), null);
});

test('qa 3: a shorter room length moves the start time to the new end, and says so', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const longRange = startTimeRange(now + 96 * HOUR, now);
  const shortRange = startTimeRange(now + 3 * HOUR, now);
  const start = new Date(now + 24 * HOUR);
  assert.deepEqual(clampStart(start, longRange), { startsAt: start, moved: false });
  const moved = clampStart(start, shortRange);
  assert.equal(moved.moved, true);
  assert.equal(moved.startsAt.getTime(), shortRange.end.getTime());
  // What is shown (clamped) is what is sent: it passes the create_room rule.
  assert.equal(startTimeError(moved.startsAt, now + 3 * HOUR, now), null);
  assert.deepEqual(clampStart(null, shortRange), { startsAt: null, moved: false });
  const early = clampStart(new Date(now - HOUR), shortRange);
  assert.equal(early.moved, true);
  assert.equal(early.startsAt.getTime(), now);
});

test('qa 5: the pin area reads city and region, else the country, else nothing', () => {
  assert.equal(pinAreaLabel({ city: 'Los Angeles', region: 'CA', country: 'United States' }), 'Los Angeles, CA');
  assert.equal(pinAreaLabel({ city: null, subregion: 'Marin County', region: 'CA' }), 'Marin County, CA');
  assert.equal(pinAreaLabel({ city: 'Singapore', region: 'Singapore' }), 'Singapore');
  assert.equal(pinAreaLabel({ country: 'Iceland' }), 'Iceland');
  assert.equal(pinAreaLabel({}), null);
  assert.equal(pinAreaLabel(null), null);
});
