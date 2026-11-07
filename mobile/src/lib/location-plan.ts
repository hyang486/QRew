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
/** Margin around the points, as a factor of their span. */
const CAMERA_PADDING = 1.4;

/**
 * Camera that shows all points (F5-3): the middle of their bounding box, zoomed to fit their span
 * instead of a fixed street-level zoom. expo-maps maps zoom to a longitude span of 360 / 2^zoom degrees.
 * Longitudes are taken across the antimeridian when that span is shorter. Null when there are no points.
 */
export function cameraFor(points: LatLng[]): Camera | null {
  const valid = points.filter(isValidLatLng);
  if (valid.length === 0) return null;
  const lats = valid.map((p) => p.latitude);
  const latSpan = Math.max(...lats) - Math.min(...lats);
  const latitude = (Math.min(...lats) + Math.max(...lats)) / 2;

  const lngs = valid.map((p) => p.longitude);
  const wrapped = lngs.map((l) => (l < 0 ? l + 360 : l));
  const plainSpan = Math.max(...lngs) - Math.min(...lngs);
  const wrappedSpan = Math.max(...wrapped) - Math.min(...wrapped);
  const useWrapped = wrappedSpan < plainSpan;
  const range = useWrapped ? wrapped : lngs;
  let longitude = (Math.min(...range) + Math.max(...range)) / 2;
  if (longitude > 180) longitude -= 360;
  const lngSpan = useWrapped ? wrappedSpan : plainSpan;

  const span = Math.max(latSpan, lngSpan) * CAMERA_PADDING;
  const fit = span > 0 ? Math.log2(360 / span) : MAX_CAMERA_ZOOM;
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, fit));
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
