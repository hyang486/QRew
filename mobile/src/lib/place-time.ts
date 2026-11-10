// Place and time unit (migration 0026): optional meeting place name, optional pin and optional start time on a room.
// Pure helpers, no React Native imports, so `npm test` can run them. The server (create_room) is the authority;
// these mirror its rules so the host sees a clear message before sending.

export type LatLng = { latitude: number; longitude: number };

export type PlaceTime = { placeName: string | null; pin: LatLng | null; startsAt: Date | null };

/** rooms.place_name and create_room: trimmed, 1-80 characters. */
export const MAX_PLACE_NAME = 80;

/** Trimmed name capped at 80 characters, or null for an empty or blank name (no place). */
export function normalizePlaceName(name: string): string | null {
  const trimmed = name.trim().slice(0, MAX_PLACE_NAME).trim();
  return trimmed ? trimmed : null;
}

function validPin(pin: LatLng | null): pin is LatLng {
  return (
    pin !== null &&
    Number.isFinite(pin.latitude) &&
    Number.isFinite(pin.longitude) &&
    Math.abs(pin.latitude) <= 90 &&
    Math.abs(pin.longitude) <= 180
  );
}

/**
 * The optional create_room arguments. Nothing set → no extra arguments, so the call is the same as before 0026.
 * A pin is sent only with a place name (rooms_place_pin_needs_name) and only when it is in range.
 */
export function placeTimeArgs(input: { placeName: string; pin: LatLng | null; startsAt: Date | null }) {
  const args: { p_place_name?: string; p_place_lat?: number; p_place_lng?: number; p_starts_at?: string } = {};
  const name = normalizePlaceName(input.placeName);
  if (name) {
    args.p_place_name = name;
    if (validPin(input.pin)) {
      args.p_place_lat = input.pin.latitude;
      args.p_place_lng = input.pin.longitude;
    }
  }
  if (input.startsAt) args.p_starts_at = input.startsAt.toISOString();
  return args;
}

const DAY_MS = 24 * 3_600_000;

/** create_room: the start must be before the room closes and not more than one day in the past. */
export function startTimeError(startsAt: Date | null, expiresMs: number, nowMs: number): 'afterClose' | 'tooEarly' | null {
  if (!startsAt) return null;
  const t = startsAt.getTime();
  if (t >= expiresMs) return 'afterClose';
  if (t < nowMs - DAY_MS) return 'tooEarly';
  return null;
}

/** The date picker's range: from now until one minute before the room closes. */
export function startTimeRange(expiresMs: number, nowMs: number) {
  return { start: new Date(nowMs), end: new Date(Math.max(nowMs, expiresMs - 60_000)) };
}

/** The place and time a room or preview carries, or null when it has none (the screen then shows nothing new). */
export function placeTimeOf(row: {
  place_name: string | null;
  place_lat: number | null;
  place_lng: number | null;
  starts_at: string | null;
}): PlaceTime | null {
  const placeName = row.place_name || null;
  const pin =
    placeName && row.place_lat !== null && row.place_lng !== null
      ? { latitude: row.place_lat, longitude: row.place_lng }
      : null;
  const startsAt = row.starts_at ? new Date(row.starts_at) : null;
  if (!placeName && !startsAt) return null;
  return { placeName, pin, startsAt };
}

/** Open in Maps: Apple Maps searches the name (at the pin when set); Google Maps searches the pin, else the name. */
export function mapsUrl(app: 'apple' | 'google', placeName: string, pin: LatLng | null) {
  if (app === 'apple') {
    const ll = pin ? `&ll=${pin.latitude},${pin.longitude}` : '';
    return `https://maps.apple.com/?q=${encodeURIComponent(placeName)}${ll}`;
  }
  const query = pin ? `${pin.latitude},${pin.longitude}` : placeName;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** qa 4: any edit of the place name text drops the pin, so "Find on map" shows again for the new name. */
export function pinAfterNameChange(pin: LatLng | null, oldName: string, newName: string): LatLng | null {
  return newName === oldName ? pin : null;
}

/**
 * qa 3: when the room length changes, the start time must stay inside the picker's range, so that what the
 * picker shows is what is sent. A start past the new end moves to the end (moved: true); one before the start
 * of the range moves to its start.
 */
export function clampStart(startsAt: Date | null, range: { start: Date; end: Date }) {
  if (!startsAt) return { startsAt: null, moved: false };
  const t = startsAt.getTime();
  if (t > range.end.getTime()) return { startsAt: new Date(range.end.getTime()), moved: true };
  if (t < range.start.getTime()) return { startsAt: new Date(range.start.getTime()), moved: true };
  return { startsAt, moved: false };
}

/**
 * qa 5: where the pin is, from a reverse geocode: "Los Angeles, CA". City (or subregion) and region; the
 * country only when neither is known. Null when nothing useful came back (then nothing is shown).
 */
export function pinAreaLabel(
  address: {
    city?: string | null;
    subregion?: string | null;
    region?: string | null;
    country?: string | null;
  } | null | undefined,
): string | null {
  if (!address) return null;
  const local = address.city || address.subregion || null;
  const parts = [local, address.region || null].filter((p): p is string => !!p);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  if (unique.length) return unique.join(', ');
  return address.country || null;
}
