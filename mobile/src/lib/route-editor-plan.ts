import type { Camera, LatLng } from './location-plan';

/**
 * UI v2 (2): the route editor never opens on the world view. In a room with no place, route or member positions
 * the room map reports a world-wide camera, and one swipe there saved a 14,193.7 km route across the Atlantic.
 */

/** A camera zoomed out further than this (a continent or the world) is not a view to draw a route on. */
export const MIN_EDITOR_ZOOM = 5;
/** The regional default's zoom: about a city. */
export const REGION_ZOOM = 10;
/** A saved route longer than this is refused: a room's route is a walk, run or ride, not a flight. */
export const MAX_ROUTE_KM = 200;

/** Rough city centers by device time zone; anything else falls back to the America/Los_Angeles one. */
const REGION_BY_ZONE: Record<string, LatLng> = {
  'America/Los_Angeles': { latitude: 37.7749, longitude: -122.4194 },
  'America/Denver': { latitude: 39.7392, longitude: -104.9903 },
  'America/Phoenix': { latitude: 33.4484, longitude: -112.074 },
  'America/Chicago': { latitude: 41.8781, longitude: -87.6298 },
  'America/New_York': { latitude: 40.7128, longitude: -74.006 },
  'America/Toronto': { latitude: 43.6532, longitude: -79.3832 },
  'America/Vancouver': { latitude: 49.2827, longitude: -123.1207 },
  'Pacific/Honolulu': { latitude: 21.3069, longitude: -157.8583 },
  'Europe/London': { latitude: 51.5072, longitude: -0.1276 },
  'Europe/Paris': { latitude: 48.8566, longitude: 2.3522 },
  'Europe/Berlin': { latitude: 52.52, longitude: 13.405 },
  'Asia/Seoul': { latitude: 37.5665, longitude: 126.978 },
  'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 },
  'Australia/Sydney': { latitude: -33.8688, longitude: 151.2093 },
};

export function regionalDefaultCamera(timeZone: string | null | undefined): Camera {
  return { coordinates: REGION_BY_ZONE[timeZone ?? ''] ?? REGION_BY_ZONE['America/Los_Angeles'], zoom: REGION_ZOOM };
}

/**
 * Where the editor opens: the room map's last view when it is zoomed in enough, else the room camera (the room's
 * route and member positions, else my own position when location is permitted), else a regional default.
 */
export function editorStartCamera(input: {
  lastView: Camera | null;
  roomCamera: Camera | null;
  timeZone: string | null | undefined;
}): Camera {
  if (input.lastView && input.lastView.zoom >= MIN_EDITOR_ZOOM) return input.lastView;
  return input.roomCamera ?? regionalDefaultCamera(input.timeZone);
}

/** Save route refuses a route over MAX_ROUTE_KM (lengthM: routeLengthMeters, the length the editor shows). */
export function routeTooLong(lengthM: number): boolean {
  return lengthM > MAX_ROUTE_KM * 1000;
}
