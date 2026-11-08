// Pure helpers for live location sharing (no React Native imports, so `npm test` can load them).

export type LatLng = { latitude: number; longitude: number };
export type Fix = LatLng & { atMs: number };

/** Never report more often than this (L4). */
export const REPORT_MIN_INTERVAL_MS = 5_000;
/** A new fix closer than this to the last report is not sent, except as a heartbeat. */
export const REPORT_MIN_DISTANCE_M = 10;
/**
 * A member who has not moved (iOS sends no watch updates under REPORT_MIN_DISTANCE_M) requests a FRESH
 * fix this long after their last report, so others do not see them as stale (MS2). A cached fix is never
 * re-sent with a new timestamp.
 */
export const HEARTBEAT_MS = 30_000;
/** A fresh-fix request that has not answered by then counts as failed: nothing is sent (the row goes stale). */
export const FRESH_FIX_TIMEOUT_MS = 10_000;
/** A reading whose own timestamp is older than this is not reported (no frozen fixes, C5). */
export const FRESH_FIX_MAX_AGE_MS = 15_000;
/** Other members show "Location stale" once the server row is older than this. */
export const STALE_AFTER_MS = 60_000;
/** Presence change notices arrive per report; refetch at most once per this window. */
export const PRESENCE_REFETCH_DEBOUNCE_MS = 1_500;
/** Server limit in set_route (migration 0020). */
export const MAX_ROUTE_POINTS = 2000;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a fix should be sent now. `lastSent` is the last report that reached the server.
 * Throttled to one report per REPORT_MIN_INTERVAL_MS; inside that, a move of REPORT_MIN_DISTANCE_M or
 * a HEARTBEAT_MS gap is needed.
 */
export function shouldReport(lastSent: Fix | null, next: LatLng, nowMs: number): boolean {
  if (!isValidLatLng(next)) return false;
  if (!lastSent) return true;
  const elapsed = nowMs - lastSent.atMs;
  if (elapsed < REPORT_MIN_INTERVAL_MS) return false;
  if (elapsed >= HEARTBEAT_MS) return true;
  return distanceMeters(lastSent, next) >= REPORT_MIN_DISTANCE_M;
}

/** One position reading with the device's own timestamp (`LocationObject.timestamp`). */
export type Reading = LatLng & {
  speed: number | null;
  accuracy: number | null;
  heading: number | null;
  timestampMs: number;
};

export type FreshFixResult = { ok: true; reading: Reading } | { ok: false };

/** Speed in m/s as measured for this reading. iOS gives -1 when it has none (e.g. standing still): null. */
export function reportedSpeed(speed: number | null | undefined): number | null {
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : null;
}

/**
 * A reading may be reported only if it is genuinely new: valid coordinates, its own timestamp newer
 * than the last reported reading (a cached reading repeats an old timestamp), and not older than
 * FRESH_FIX_MAX_AGE_MS.
 */
export function isFreshReading(reading: Reading, lastSentReadingMs: number | null, nowMs: number): boolean {
  if (!isValidLatLng(reading) || !Number.isFinite(reading.timestampMs)) return false;
  if (lastSentReadingMs !== null && reading.timestampMs <= lastSentReadingMs) return false;
  return nowMs - reading.timestampMs <= FRESH_FIX_MAX_AGE_MS;
}

/** Whether to request a fresh fix now: nothing reported yet, or HEARTBEAT_MS since the last report. */
export function heartbeatDue(lastSentAtMs: number | null, nowMs: number): boolean {
  return lastSentAtMs === null || nowMs - lastSentAtMs >= HEARTBEAT_MS;
}

/**
 * Whether to START a fresh-fix request now (MS-R1): the heartbeat is due, and no request was started
 * within the last HEARTBEAT_MS. A timed-out native request keeps running, so after a failure the next
 * attempt waits a full HEARTBEAT_MS instead of stacking requests every tick.
 */
export function freshFixAttemptDue(lastSentAtMs: number | null, lastAttemptAtMs: number | null, nowMs: number): boolean {
  if (!heartbeatDue(lastSentAtMs, nowMs)) return false;
  return lastAttemptAtMs === null || nowMs - lastAttemptAtMs >= HEARTBEAT_MS;
}

/**
 * What a heartbeat reports, given its fresh-fix request. A failed or timed-out request and a stale or
 * repeated reading report nothing, so the server row goes stale truthfully. Speed comes only from this
 * reading; a previous moving speed is never carried forward (MS1).
 */
export function planHeartbeat(result: FreshFixResult, lastSentReadingMs: number | null, nowMs: number): Reading | null {
  if (!result.ok || !isFreshReading(result.reading, lastSentReadingMs, nowMs)) return null;
  return { ...result.reading, speed: reportedSpeed(result.reading.speed) };
}

/** Rejects with "timed out" if `promise` has not settled within `ms`. The underlying work is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isValidLatLng(p: LatLng | null | undefined): p is LatLng {
  return (
    !!p &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}

export function isStale(updatedAtIso: string, nowMs: number): boolean {
  const t = Date.parse(updatedAtIso);
  return !Number.isFinite(t) || nowMs - t > STALE_AFTER_MS;
}

/** "just now", "2 min ago", "1 h ago". */
export function formatAge(updatedAtIso: string, nowMs: number): string {
  const t = Date.parse(updatedAtIso);
  if (!Number.isFinite(t)) return 'unknown';
  const minutes = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** Speed in km/h with one decimal, or null when unknown. Never call this for a stale row. */
export function formatSpeedKmh(mps: number | null | undefined): string | null {
  if (mps == null || !Number.isFinite(mps) || mps < 0) return null;
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

/** rooms.route (jsonb) as map coordinates. Anything malformed is skipped. */
export function parseRoute(route: unknown): LatLng[] {
  if (!Array.isArray(route)) return [];
  const out: LatLng[] = [];
  for (const p of route) {
    if (p && typeof p === 'object') {
      const { lat, lng } = p as { lat?: unknown; lng?: unknown };
      const point = { latitude: Number(lat), longitude: Number(lng) };
      if (typeof lat === 'number' && typeof lng === 'number' && isValidLatLng(point)) out.push(point);
    }
  }
  return out;
}

/** Map coordinates as the set_route payload. */
export function toRoutePayload(points: LatLng[]): { lat: number; lng: number }[] {
  return points.filter(isValidLatLng).slice(0, MAX_ROUTE_POINTS).map((p) => ({ lat: p.latitude, lng: p.longitude }));
}

export type Camera = { coordinates: LatLng; zoom: number };

/** Street level: a single point, or points closer together than this. */
export const MAX_CAMERA_ZOOM = 15;
/** Whole-world view for points spread across the globe. */
export const MIN_CAMERA_ZOOM = 1;
/** Screen-space margins, in points, that the fitted points must stay clear of. */
export type EdgePadding = { top: number; bottom: number; left: number; right: number };
/** The map view's size, in points. */
export type ViewSize = { width: number; height: number };
export type CameraFrame = { size: ViewSize; padding: EdgePadding };

/**
 * F5-5b: the room map's fit margins. expo-maps 58 has no edge padding or content inset, so the margins are
 * part of the fit itself. Each edge is the overlay band there plus how far a pin reaches past its point:
 * - top 88: the host's Pen button, top left (8 + ~34 pt; MapKit's compass and other controls sit top right,
 *   inside the same band), plus a marker balloon, drawn 44 pt above its point.
 * - bottom: the Show my location / Recenter buttons (8 + ~34 pt) plus, under the lowest point, a photo pin's
 *   lower half (25 pt), a 3 pt gap and the name label pill (P2: 22 pt per line + 10 pt, see roomMapPadding).
 * - left / right: half the widest label pill, which is centered on its pin; at least 64 pt ("Name · 4 km/h").
 * This constant is the one-line case; fitRoomCamera grows it for the labels it will actually draw.
 */
export const ROOM_MAP_PADDING: EdgePadding = { top: 88, bottom: 102, left: 64, right: 64 };
/** The room map until onLayout reports: 360 pt tall, full width of a 402 pt screen minus 16 pt gutters. */
export const ROOM_MAP_SIZE: ViewSize = { width: 370, height: 360 };

/** The points always get at least this share of each view dimension, even if the padding asks for more. */
const MIN_CONTENT_SHARE = 0.25;
const MAX_MERCATOR_LAT = 85.05112878;
const RAD = Math.PI / 180;

/** Web Mercator y, in degrees of longitude, so x and y share one screen scale. */
function mercatorY(latitude: number): number {
  const lat = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, latitude)) * RAD;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2)) / RAD;
}

function latitudeOfY(y: number): number {
  return (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD;
}

/**
 * Camera that shows all points (F5-3) inside the frame's padding (F5-5b). expo-maps turns zoom into a region
 * of 360 / 2^zoom degrees on both axes, and MapKit shows at least that region, scaled to fit the view: on
 * screen that is min(width, height * cos(lat)) points across the span (Mercator stretches latitude by
 * 1 / cos(lat)). So the fit picks the screen scale that puts the points' projected bounding box inside the
 * padded rect, turns that scale back into a zoom, and moves the center so the box sits in the middle of the
 * padded rect rather than of the whole view (the padding is uneven). Longitudes are taken across the
 * antimeridian when that span is shorter. Null when there are no points.
 */
export function cameraFor(
  points: LatLng[],
  size: ViewSize = ROOM_MAP_SIZE,
  padding: EdgePadding = ROOM_MAP_PADDING,
): Camera | null {
  const valid = points.filter(isValidLatLng);
  if (valid.length === 0) return null;
  const ys = valid.map((p) => mercatorY(p.latitude));
  const boxY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const ySpan = Math.max(...ys) - Math.min(...ys);

  const lngs = valid.map((p) => p.longitude);
  const wrapped = lngs.map((l) => (l < 0 ? l + 360 : l));
  const plainSpan = Math.max(...lngs) - Math.min(...lngs);
  const wrappedSpan = Math.max(...wrapped) - Math.min(...wrapped);
  const useWrapped = wrappedSpan < plainSpan;
  const range = useWrapped ? wrapped : lngs;
  const boxX = (Math.min(...range) + Math.max(...range)) / 2;
  const lngSpan = useWrapped ? wrappedSpan : plainSpan;

  const { width, height } = size;
  const innerW = Math.max(width - padding.left - padding.right, width * MIN_CONTENT_SHARE);
  const innerH = Math.max(height - padding.top - padding.bottom, height * MIN_CONTENT_SHARE);
  // Points per degree that fit the box in the padded rect (Infinity for a single point).
  const fitScale = Math.min(lngSpan > 0 ? innerW / lngSpan : Infinity, ySpan > 0 ? innerH / ySpan : Infinity);

  // Points across the camera's span on screen: the width, or the height when latitude binds first.
  const across = Math.min(width, height * Math.cos(latitudeOfY(boxY) * RAD));
  const fit = Number.isFinite(fitScale) ? Math.log2((360 * fitScale) / across) : MAX_CAMERA_ZOOM;
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, fit));
  const scale = across / (360 / 2 ** zoom); // the scale MapKit will draw at, after the clamp

  // Screen y grows downward, Mercator y upward: more top padding puts the box lower, so the center goes up.
  const latitude = latitudeOfY(boxY + (padding.top - padding.bottom) / 2 / scale);
  let longitude = boxX - (padding.left - padding.right) / 2 / scale;
  if (longitude > 180) longitude -= 360;
  if (longitude < -180) longitude += 360;
  return { coordinates: { latitude, longitude }, zoom };
}

/**
 * M7: what a read of the user's own room_members.share_location may change. The read and the
 * set_share_location RPC are separate requests, so a read that overlaps an opt-in (pending) or
 * started before consent last changed (generation moved) can see an old value: it is ignored, and
 * the store change after the RPC triggers a fresh read.
 */
export type ShareRead = {
  server: boolean;
  consented: boolean;
  pending: boolean;
  genAtStart: number;
  genNow: number;
};
export type ShareDecision = 'ignore' | 'on' | 'off' | 'drop-consent' | 'turn-off-server';

export function reconcileShare({ server, consented, pending, genAtStart, genNow }: ShareRead): ShareDecision {
  if (pending || genAtStart !== genNow) return 'ignore';
  if (server) return consented ? 'on' : 'turn-off-server';
  return consented ? 'drop-consent' : 'off';
}

// M1: member pins on the map.

export type PinInput = {
  userId: string;
  coordinates: LatLng;
  updatedAt: string;
  speedMps: number | null;
  /** Shown in the title ("You" for the current user). */
  label: string;
  /** Used for the initials monogram. */
  initialsOf: string;
  /** profiles.avatar_path of a current room member, or null. */
  avatarPath: string | null;
};

/** M1: a photo pin, or a monogram / stale pin. `T` is the loaded icon (an expo-image ImageRef in the app). */
export type PinPlan<T> =
  | { kind: 'photo'; id: string; coordinates: LatLng; title: string; icon: T }
  | { kind: 'monogram'; id: string; coordinates: LatLng; title: string; monogram: string }
  | { kind: 'stale'; id: string; coordinates: LatLng; title: string };

/** F6-1: the stale pin's marker id. Different from the fresh id so the map draws a new marker instead of
 * restyling the existing one in place (expo-maps' SwiftUI Map kept the red monogram on an in-place change). */
export function stalePinId(userId: string) {
  return `${userId}:stale`;
}

/**
 * C4: a stale member never shows a speed and is drawn as a grey clock pin, photo or not, titled
 * "<name> · <staleWord>" (F6-1) so stale coordinates never look current.
 * A fresh member shows their photo once it has loaded; with no photo, while it loads, or when
 * it failed (pre-0021, no access, room ended) they show their initials instead.
 */
export function planPins<T>(
  pins: PinInput[],
  nowMs: number,
  icons: ReadonlyMap<string, T>,
  staleWord = 'stale',
): PinPlan<T>[] {
  return pins.map((pin) => {
    const stale = isStale(pin.updatedAt, nowMs);
    const speed = stale ? null : formatSpeedKmh(pin.speedMps);
    const base = { id: pin.userId, coordinates: pin.coordinates, title: [pin.label, speed].filter(Boolean).join(' · ') };
    if (stale) return { kind: 'stale', ...base, id: stalePinId(pin.userId), title: `${pin.label} · ${staleWord}` };
    const icon = pin.avatarPath ? icons.get(pin.avatarPath) : undefined;
    if (icon !== undefined) return { kind: 'photo', ...base, icon };
    return { kind: 'monogram', ...base, monogram: initials(pin.initialsOf || pin.label) };
  });
}

// P2: member labels. MapKit collision-hides a Marker's or Annotation's title when pins are close, but never an
// annotation's content view, so the pins get no title and the "name · speed" text is its own text annotation.
// One label per pin overlapped its neighbours' pins and pills (MapKit picks the z-order), so pins whose pin or
// pill would touch are grouped on screen, and a group gets one multi-line pill under its lowest pin: every pin
// of the group is above the pill, and no other group comes near it.

/** A label is drawn under a photo (50 pt, centered on the point) or under a Marker balloon (tip on the point). */
export type LabelShape = 'photo' | 'marker';
/** What a label needs from a pin. `id` is the pin's id, which already differs for fresh and stale (F6-1). */
export type LabelPin = { id: string; coordinates: LatLng; shape: LabelShape; text: string; stale: boolean };
export type ScreenPoint = { x: number; y: number };
export type Anchor = { x: number; y: number };
export type MapLabel = {
  id: string;
  coordinates: LatLng;
  /** One "name · speed" (or stale text) line per member, joined with "\n". */
  text: string;
  anchor: Anchor;
  lines: number;
  /** Every member is stale: the pill uses the stale text color. */
  stale: boolean;
  /** The pin ids in this label, in line order. */
  members: string[];
  /** Under the group's lowest pin, or over its highest pin. */
  placement: LabelPlacement;
  /** Centred on its pin, or reaching out to the left or right of it (P2 placement candidates). */
  align: LabelAlign;
};

/**
 * expo-maps 58 draws a text-only annotation as Text in the 17 pt body font with 5 pt padding over a rounded
 * rect. Space is reserved with a 22 pt line (the body style's leading) and an 8.5 pt average character, both a
 * little more than SF Pro draws (a 16-character name measured ~8.4 pt), so the estimate errs toward grouping
 * and toward more padding.
 */
export const LABEL_LINE_HEIGHT = 22;
export const LABEL_CHAR_WIDTH = 8.5;
export const LABEL_TEXT_PADDING = 5;
/** The anchor uses a slightly shorter line (SF Pro 17 draws ~20.3 pt), so the real gap is never smaller. */
const LABEL_ANCHOR_LINE_HEIGHT = 20;
/** Between a pin's bottom and its pill's top. */
export const LABEL_GAP = 3;
/** Two pills, or a pill and another group's pin, closer than this (pt) count as touching. */
export const LABEL_GROUP_MARGIN = 4;
/**
 * P2 complete link: pins are one group only when every two of them are within this distance on screen (pt,
 * point to point, about one balloon width plus a gap). A pill never names anyone farther than this from the
 * pin it hangs from.
 */
export const LABEL_JOIN = 48;
const PHOTO_HALF = 25;
/** A Marker balloon: about 40 pt wide, drawn 44 pt above its point (the tip). */
const MARKER_HALF_WIDTH = 20;
const MARKER_HEIGHT = 44;
/** The bottom overlay band: the Show my location / Recenter buttons (8 + ~34 pt). */
const BOTTOM_BUTTON_BAND = 42;
/** The top overlay band: Pen (top left), the compass and the tracking button (top right); the fit's top padding. */
const TOP_BUTTON_BAND = ROOM_MAP_PADDING.top;
/** P2: a pill hangs under its group's lowest pin, or, when that has less room on screen, over its highest pin. */
export type LabelPlacement = 'below' | 'above';
/** P2: centred on the pin, or reaching left (its right edge at the pin body's right edge) or right. */
export type LabelAlign = 'center' | 'left' | 'right';

/** The estimated pill size in points for these lines. */
export function pillSize(lines: string[]): { width: number; height: number } {
  const longest = Math.max(0, ...lines.map((line) => Array.from(line).length));
  return {
    width: longest * LABEL_CHAR_WIDTH + 2 * LABEL_TEXT_PADDING,
    height: Math.max(1, lines.length) * LABEL_LINE_HEIGHT + 2 * LABEL_TEXT_PADDING,
  };
}

/** Half a pin body's width. */
function pinHalfWidth(shape: LabelShape) {
  return shape === 'photo' ? PHOTO_HALF : MARKER_HALF_WIDTH;
}

/** How far below its point a pin's body ends. */
function pinBottom(shape: LabelShape) {
  return shape === 'photo' ? PHOTO_HALF : 0;
}

/** How far above its point a pin's body starts. */
function pinTop(shape: LabelShape) {
  return shape === 'photo' ? PHOTO_HALF : MARKER_HEIGHT;
}

/**
 * Below: the anchor that puts the top of a `lines`-line pill LABEL_GAP below the bottom of a pin of `shape`.
 * Above: the anchor that puts the pill's bottom LABEL_GAP above the top of the pin.
 * Horizontally the pill is centred, or for `left` its right edge (for `right` its left edge) is at the edge
 * of the pin body, given the estimated pill width.
 * expo-maps passes the anchor to UnitPoint unclamped, so a negative y puts the point above the pill and a
 * y over 1 below it. The anchor's shorter line height makes the real gap a little larger, never smaller.
 */
export function labelAnchor(
  shape: LabelShape,
  lines: number,
  placement: LabelPlacement = 'below',
  align: LabelAlign = 'center',
  width = 0,
): Anchor {
  const height = Math.max(1, lines) * LABEL_ANCHOR_LINE_HEIGHT + 2 * LABEL_TEXT_PADDING;
  const half = pinHalfWidth(shape);
  const x = align === 'center' || !(width > 2 * half) ? 0.5 : align === 'left' ? 1 - half / width : half / width;
  return placement === 'below'
    ? { x, y: -(pinBottom(shape) + LABEL_GAP) / height }
    : { x, y: 1 + (pinTop(shape) + LABEL_GAP) / height };
}

/** P2: the label input for each pin, in pin order. */
export function labelPins<T>(pins: PinPlan<T>[]): LabelPin[] {
  return pins.map((pin) => ({
    id: pin.id,
    coordinates: pin.coordinates,
    shape: pin.kind === 'photo' ? 'photo' : 'marker',
    text: pin.title,
    stale: pin.kind === 'stale',
  }));
}

/** What the map shows: its center, its scale in points per degree of longitude, and its heading. */
export type Viewport = { center: LatLng; scale: number; bearing: number };

/**
 * The viewport after a camera move (expo-maps' onCameraMove: the region's center and spans, and the heading).
 * The region is the box around what is shown, so with a heading the box is wider than the view.
 * Null when the event is unusable.
 */
export function viewportFromRegion(
  region: { coordinates: { latitude?: number; longitude?: number }; longitudeDelta?: number; bearing?: number },
  size: ViewSize,
): Viewport | null {
  const { latitude, longitude } = region.coordinates;
  const delta = Number(region.longitudeDelta);
  if (latitude == null || longitude == null || !(delta > 0)) return null;
  const center = { latitude, longitude };
  if (!isValidLatLng(center)) return null;
  const bearing = Number.isFinite(region.bearing) ? Number(region.bearing) : 0;
  const t = bearing * RAD;
  const boxWidth = size.width * Math.abs(Math.cos(t)) + size.height * Math.abs(Math.sin(t));
  return { center, scale: boxWidth / delta, bearing };
}

/**
 * The viewport for a camera set through expo-maps (cameraPosition / setCameraPosition): a region of
 * 360 / 2^zoom degrees on both axes, which MapKit scales to fit inside the view, north up.
 */
export function viewportFromCamera(camera: Camera, size: ViewSize): Viewport {
  const span = 360 / 2 ** camera.zoom;
  const c = camera.coordinates.latitude;
  const regionHeight = mercatorY(c + span / 2) - mercatorY(c - span / 2);
  return { center: camera.coordinates, scale: Math.min(size.width / span, size.height / regionHeight), bearing: 0 };
}

/** Where `point` is drawn in the view, in points from the top left (Web Mercator, turned by the heading). */
export function projectPoint(point: LatLng, view: Viewport, size: ViewSize): ScreenPoint {
  let dLng = point.longitude - view.center.longitude;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const east = dLng * view.scale;
  const north = (mercatorY(point.latitude) - mercatorY(view.center.latitude)) * view.scale;
  // Heading t: the top of the view points t degrees clockwise from north, so the map turns t counterclockwise.
  const t = view.bearing * RAD;
  return {
    x: size.width / 2 + east * Math.cos(t) - north * Math.sin(t),
    y: size.height / 2 - (east * Math.sin(t) + north * Math.cos(t)),
  };
}

export type Rect = { left: number; top: number; right: number; bottom: number };
export type Placed = LabelPin & ScreenPoint;

function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bodyRect(pin: Placed): Rect {
  return pin.shape === 'photo'
    ? { left: pin.x - PHOTO_HALF, right: pin.x + PHOTO_HALF, top: pin.y - PHOTO_HALF, bottom: pin.y + PHOTO_HALF }
    : { left: pin.x - MARKER_HALF_WIDTH, right: pin.x + MARKER_HALF_WIDTH, top: pin.y - MARKER_HEIGHT, bottom: pin.y };
}

/** Line order: top to bottom on screen, then left to right, then id. */
function byScreen(a: Placed, b: Placed) {
  return a.y - b.y || a.x - b.x || compareIds(a.id, b.id);
}

/** The pin the pill hangs under: the one whose body reaches lowest on screen (ties: the later in line order). */
function lowestPin<P extends Placed>(members: P[]): P {
  return members.reduce((low, pin) => {
    const d = pin.y + pinBottom(pin.shape) - (low.y + pinBottom(low.shape));
    return d > 0 || (d === 0 && byScreen(pin, low) > 0) ? pin : low;
  });
}

/** The pin a pill sits over: the one whose body reaches highest on screen (ties: the earlier in line order). */
function highestPin<P extends Placed>(members: P[]): P {
  return members.reduce((high, pin) => {
    const d = pin.y - pinTop(pin.shape) - (high.y - pinTop(high.shape));
    return d < 0 || (d === 0 && byScreen(pin, high) < 0) ? pin : high;
  });
}

/** Where a group's pill goes, the pin it hangs from, and the pill's rect on screen. */
export type PillPlan<P extends Placed = Placed> = { placement: LabelPlacement; align: LabelAlign; pin: P; rect: Rect };

const ALIGNS: LabelAlign[] = ['center', 'left', 'right'];

/**
 * P2: a group's six candidate pills in their fixed order: under the lowest pin (centred, reaching left,
 * reaching right), then over the highest pin (the same three). A reaching pill keeps one edge at the edge of
 * its pin's body, so it always touches the pin it names.
 */
export function pillCandidates<P extends Placed>(members: P[]): PillPlan<P>[] {
  const { width, height } = pillSize(members.map((m) => m.text));
  const low = lowestPin(members);
  const high = highestPin(members);
  const span = (pin: P, align: LabelAlign) => {
    const half = pinHalfWidth(pin.shape);
    if (align === 'center' || !(width > 2 * half)) return { left: pin.x - width / 2, right: pin.x + width / 2 };
    return align === 'left' ? { left: pin.x + half - width, right: pin.x + half } : { left: pin.x - half, right: pin.x - half + width };
  };
  const belowTop = low.y + pinBottom(low.shape) + LABEL_GAP;
  const aboveBottom = high.y - pinTop(high.shape) - LABEL_GAP;
  return [
    ...ALIGNS.map((align) => ({
      placement: 'below' as const,
      align,
      pin: low,
      rect: { ...span(low, align), top: belowTop, bottom: belowTop + height },
    })),
    ...ALIGNS.map((align) => ({
      placement: 'above' as const,
      align,
      pin: high,
      rect: { ...span(high, align), top: aboveBottom - height, bottom: aboveBottom },
    })),
  ];
}

function overlapArea(a: Rect, b: Rect, margin = 0) {
  const w = Math.min(a.right + margin, b.right) - Math.max(a.left - margin, b.left);
  const h = Math.min(a.bottom + margin, b.bottom) - Math.max(a.top - margin, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The part of `rect` outside the map's free area: off the view, or under the top or bottom button band. */
function clippedArea(rect: Rect, size: ViewSize) {
  const area = (rect.right - rect.left) * (rect.bottom - rect.top);
  const free = { left: 0, right: size.width, top: TOP_BUTTON_BAND, bottom: size.height - BOTTOM_BUTTON_BAND };
  return area - overlapArea(rect, free);
}

/**
 * P2: a group's pill alone (nothing else on the map): the first candidate that fits the free area, else the
 * one least clipped (earliest on a tie). With no size (nothing known about the screen), under the lowest pin.
 */
export function placePill<P extends Placed>(members: P[], size?: ViewSize): PillPlan<P> {
  return placePills([members], size)[0];
}

/** How bad a candidate is: its clipped area plus the area it covers (with the margin) of `obstacles`. */
function pillCost(rect: Rect, obstacles: Rect[], size: ViewSize) {
  return clippedArea(rect, size) + obstacles.reduce((sum, r) => sum + overlapArea(rect, r, LABEL_GROUP_MARGIN), 0);
}

/** The first candidate of the lowest cost (0: fits the free area and touches nothing). */
function bestCandidate<P extends Placed>(candidates: PillPlan<P>[], obstacles: Rect[], size: ViewSize) {
  let best = candidates[0];
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const cost = pillCost(candidate.rect, obstacles, size);
    if (cost < bestCost) [best, bestCost] = [candidate, cost];
    if (cost === 0) break;
  }
  return { plan: best, cost: bestCost };
}

/** At most this many passes over the groups: the first places them in order, the others revise them. */
const PLACE_PASSES = 3;

/**
 * P2: every group's pill. Pass 1 goes over the groups in order: each takes the first of its six candidates
 * that fits the free area and keeps LABEL_GROUP_MARGIN from the pills already placed and from every other
 * group's pins, else the one with the least clipped plus covered area (earliest on a tie). Later passes (at
 * most PLACE_PASSES in all) let each group whose pill now costs something (the pills placed after it count
 * too) pick again against all the other pills,
 * keeping a change only when it lowers that group's cost, and stop once a pass changes nothing. Whatever is
 * left over is the worst case: that pill overlaps another pill or pin (countOverlaps). Deterministic for the
 * same groups in the same order.
 */
export function placePills<P extends Placed>(groups: P[][], size?: ViewSize): PillPlan<P>[] {
  const candidates = groups.map((g) => pillCandidates(g));
  if (!size) return candidates.map((c) => c[0]);
  const bodies = groups.map((g) => g.map(bodyRect));
  const others = (k: number) => bodies.flatMap((b, m) => (m === k ? [] : b));
  const plans: PillPlan<P>[] = [];
  candidates.forEach((c, k) => {
    plans.push(bestCandidate(c, [...plans.map((p) => p.rect), ...others(k)], size).plan);
  });
  for (let pass = 1; pass < PLACE_PASSES; pass++) {
    let changed = false;
    candidates.forEach((c, k) => {
      const obstacles = [...plans.flatMap((p, m) => (m === k ? [] : [p.rect])), ...others(k)];
      const now = pillCost(plans[k].rect, obstacles, size);
      if (now === 0) return;
      const { plan, cost } = bestCandidate(c, obstacles, size);
      if (cost < now) {
        plans[k] = plan;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return plans;
}

/** P2: how many pills overlap another pill or another group's pin (the worst-case fallback, for reports). */
export function countOverlaps(groups: Placed[][], plans: PillPlan[]): number {
  return plans.filter((plan, k) =>
    plans.some((other, m) => m !== k && overlapArea(plan.rect, other.rect) > 0) ||
    groups.some((g, m) => m !== k && g.some((pin) => overlapArea(plan.rect, bodyRect(pin)) > 0)),
  ).length;
}

function distance(a: ScreenPoint, b: ScreenPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The largest distance between a pin of `a` and a pin of `b` (complete link). */
function spread(a: Placed[], b: Placed[]) {
  return Math.max(...a.flatMap((p) => b.map((q) => distance(p, q))));
}

/**
 * P2: groups pins by where they are on screen (points), complete link: repeatedly merges the two groups whose
 * farthest pins are closest, while that distance is at most `join`, so every two pins in a group are within
 * `join` of each other and a chain of close pins never stretches a group. Pills play no part: contact between
 * pills is resolved by placePills, never by merging. Pure and deterministic: the result does not depend on the
 * input order. Groups are in order of their smallest pin id; members in line order (top to bottom).
 */
export function groupPins<P extends Placed>(pins: P[], join = LABEL_JOIN): P[][] {
  let groups: P[][] = [...pins].sort((a, b) => compareIds(a.id, b.id)).map((pin) => [pin]);
  for (;;) {
    let pick: [number, number] | null = null;
    let pickSpread = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = spread(groups[i], groups[j]);
        if (d <= join && d < pickSpread) {
          pick = [i, j];
          pickSpread = d;
        }
      }
    }
    if (!pick) break;
    const [i, j] = pick;
    const joined = [...groups[i], ...groups[j]];
    groups = groups.flatMap((g, k) => (k === i ? [joined] : k === j ? [] : [g]));
  }
  // Each group's first member (before the line sort) is its smallest id, and the groups keep that order.
  return groups.map((g) => [...g].sort(byScreen));
}

/**
 * P2 / F6-1: a label's identity. It changes when the member set, any member's fresh/stale id or photo/marker
 * shape, the pin the pill hangs from or its side (below / above) changes, so a changed label is drawn as a new
 * annotation rather than restyled in place. Only the text (speeds, line order) and the position change under
 * one id.
 */
export function labelId(
  members: { id: string; shape: LabelShape }[],
  under: { id: string; shape: LabelShape },
  placement: LabelPlacement = 'below',
  align: LabelAlign = 'center',
) {
  const tokens = members.map((m) => `${m.id}=${m.shape}`).sort();
  return `label:${tokens.join(',')}@${under.id}=${under.shape}:${placement}${align === 'center' ? '' : `-${align}`}`;
}

/** P2: the groups on this viewport and their pills (planLabels before it becomes labels; also for tests). */
export function layoutLabels(pins: LabelPin[], view: Viewport | null, size: ViewSize) {
  const valid = pins.filter((pin) => isValidLatLng(pin.coordinates));
  // With no viewport, nothing is known about the screen: every pin keeps its own label, under its pin.
  const groups: Placed[][] = view
    ? groupPins(valid.map((pin) => ({ ...pin, ...projectPoint(pin.coordinates, view, size) })))
    : [...valid].sort((a, b) => compareIds(a.id, b.id)).map((pin) => [{ ...pin, x: 0, y: 0 }]);
  return { groups, plans: placePills(groups, view ? size : undefined) };
}

/**
 * P2: the labels to draw for the pins on this viewport: one pill per group of pins within LABEL_JOIN of each
 * other (groupPins), placed by placePills.
 */
export function planLabels(pins: LabelPin[], view: Viewport | null, size: ViewSize): MapLabel[] {
  const { groups, plans } = layoutLabels(pins, view, size);
  return groups.map((members, k) => {
    const { placement, align, pin } = plans[k];
    const width = pillSize(members.map((m) => m.text)).width;
    return {
      id: labelId(members, pin, placement, align),
      coordinates: pin.coordinates,
      text: members.map((m) => m.text).join('\n'),
      anchor: labelAnchor(pin.shape, members.length, placement, align, width),
      lines: members.length,
      stale: members.every((m) => m.stale),
      members: members.map((m) => m.id),
      placement,
      align,
    };
  });
}

/**
 * The room map's padding (see ROOM_MAP_PADDING) for labels of up to `lines` lines and a widest pill of
 * `pillWidth` points: the bottom grows by a line height for each line beyond the first.
 */
export function roomMapPadding(lines = 1, pillWidth = 0): EdgePadding {
  const pill = Math.max(1, lines) * LABEL_LINE_HEIGHT + 2 * LABEL_TEXT_PADDING;
  const side = Math.max(ROOM_MAP_PADDING.left, Math.ceil(pillWidth / 2));
  return { top: ROOM_MAP_PADDING.top, bottom: BOTTOM_BUTTON_BAND + PHOTO_HALF + LABEL_GAP + pill, left: side, right: side };
}

/**
 * Recenter (F5-3, F5-5b, P2): the camera that fits `points` (route and members) with room for the labels it
 * will draw. Grouping depends on the zoom and the padding on the groups, so the fit is repeated with the
 * padding of the labels at the last fit until they fit in it. Zooming out only brings pins closer together,
 * so groups only grow and this settles in a few rounds. Null when there are no points.
 */
export function fitRoomCamera(points: LatLng[], pins: LabelPin[], size: ViewSize = ROOM_MAP_SIZE): Camera | null {
  let lines = 1;
  let width = Math.max(0, ...pins.map((pin) => pillSize([pin.text]).width));
  let camera: Camera | null = null;
  for (let round = 0; round < 6; round++) {
    camera = cameraFor(points, size, roomMapPadding(lines, width));
    if (!camera) return null;
    const labels = planLabels(pins, viewportFromCamera(camera, size), size);
    const needLines = Math.max(1, ...labels.map((l) => l.lines));
    const needWidth = Math.max(0, ...labels.map((l) => pillSize(l.text.split('\n')).width));
    if (needLines <= lines && needWidth <= width) return camera;
    lines = Math.max(lines, needLines);
    width = Math.max(width, needWidth);
  }
  return camera;
}

/**
 * The avatar paths whose icons should be held: fresh (not stale) pins of current members only.
 * Anything else is released, so a photo is never kept once its member left the map or the room.
 */
export function wantedIconPaths(pins: PinInput[], nowMs: number): Set<string> {
  const paths = new Set<string>();
  for (const pin of pins) {
    if (pin.avatarPath && !isStale(pin.updatedAt, nowMs)) paths.add(pin.avatarPath);
  }
  return paths;
}

/** Up to two letters for the marker balloon, e.g. "Test joiner" → "TJ". */
export function initials(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('');
  return letters.toUpperCase() || '?';
}

/**
 * F5-1 "Show my location": what a tap does for the current foreground permission. 'locate': read one
 * position; 'ask': show the When In Use prompt first (only from the tap); 'settings': iOS will not ask
 * again, so only Settings can turn it on.
 */
export type LocateStep = 'locate' | 'ask' | 'settings';

export function planLocate(permission: { granted: boolean; canAskAgain: boolean }): LocateStep {
  if (permission.granted) return 'locate';
  return permission.canAskAgain ? 'ask' : 'settings';
}
