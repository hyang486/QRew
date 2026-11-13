// Qrewing AI pace maker (spec 3.4): the pure, on-device rules. No React Native imports, so `npm test` runs it.
// No model and no server: stats come from the user's own fixes, the lead group from live_presence rows.

export type Point = { latitude: number; longitude: number };
/** One position of mine, with its device time and, when known, its horizontal accuracy (live_presence.accuracy_m). */
export type PaceFix = Point & { atMs: number; accuracyM?: number | null };

/** A finished or running session as stored in history (AsyncStorage `qrewing.pace.v1.history`). */
export type PaceSession = {
  roomId: string;
  /** Epoch ms. */
  startedAt: number;
  /** Moving seconds (pauses left out). */
  durationS: number;
  /** Seconds from the first to the last accepted fix, stops included. Missing in sessions saved before it. */
  elapsedS?: number;
  distanceM: number;
  /** Null under MIN_PACE_DISTANCE_M. */
  avgSecPerKm: number | null;
  /** Seconds each full km took, in order. */
  splits: number[];
};

export type PaceTarget =
  | { kind: 'usual' }
  | { kind: 'pace'; secPerKm: number }
  | { kind: 'time'; distanceM: number; timeS: number };

const EARTH_RADIUS_M = 6_371_000;
/** A step implying more than this (43 km/h) is GPS noise for a runner, not movement. */
export const MAX_STEP_SPEED_MPS = 12;
/** Under this distance a session has no meaningful average pace. */
export const MIN_PACE_DISTANCE_M = 100;
export const USUAL_PACE_SESSIONS = 5;
export const RECENT_WINDOW_MS = 60_000;
const MIN_RECENT_DISTANCE_M = 20;
/** Off-target cue: more than this share off the target pace ... */
export const OFF_TARGET_SHARE = 0.05;
/** ... at most this often. */
export const OFF_TARGET_EVERY_MS = 2 * 60_000;
export const LEAD_GROUP_SPAN_M = 50;
export const BEHIND_GAP_M = 150;
export const CATCH_UP_S = 3 * 60;
export const STATIONARY_RADIUS_M = 25;
export const STATIONARY_MS = 3 * 60_000;
export const STATIONARY_SNOOZE_MS = 10 * 60_000;
/** The newest fix must be this fresh to judge (the reporter sends a heartbeat every 30 s while still). */
const STATIONARY_FRESH_MS = 75_000;
/** A longer gap between fixes inside the window means the reporter was not running (app in background). */
const STATIONARY_MAX_GAP_MS = 90_000;

/** Great-circle distance in meters (same formula as lib/location-plan distanceMeters). */
export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "5:41" for 341 s per km; null when there is no finite pace. */
export function formatPace(secPerKm: number | null | undefined): string | null {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return null;
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "Usual pace": the median average pace of the last 5 sessions that have one. */
export function usualPace(history: PaceSession[]): number | null {
  const paces = [...history]
    .sort((a, b) => b.startedAt - a.startedAt)
    .flatMap((s) => (s.avgSecPerKm != null && Number.isFinite(s.avgSecPerKm) ? [s.avgSecPerKm] : []))
    .slice(0, USUAL_PACE_SESSIONS);
  return median(paces);
}

export function targetSecPerKm(target: PaceTarget, usual: number | null): number | null {
  if (target.kind === 'usual') return usual;
  if (target.kind === 'pace') return target.secPerKm > 0 ? target.secPerKm : null;
  return target.distanceM > 0 && target.timeS > 0 ? target.timeS / (target.distanceM / 1000) : null;
}

// --- session tracker --------------------------------------------------------------------------------------------

export type Tracker = {
  roomId: string;
  startedAt: number;
  /** The newest accepted fix (a move, a pause or the start); dropped jumps do not replace it. */
  lastFix: PaceFix | null;
  /** Device time of lastFix (or startedAt before the first fix): steps are measured from both together. */
  lastAtMs: number;
  /** Device time of the newest kept fix, including fixes within GPS noise of lastFix (order, elapsed time). */
  seenAtMs: number;
  /** The newest fix within GPS noise of lastFix since it was set (standing still), or null. */
  noiseFix: PaceFix | null;
  /** Set by breakTracker (switch or sharing off): the next fix re-anchors the session without distance or time. */
  broken: boolean;
  /** Device time of the first accepted fix (elapsed time counts from it). */
  firstAtMs: number | null;
  /** Where the first accepted fix was (the activity start point for progress without a route or place pin). */
  firstPoint: Point | null;
  distanceM: number;
  /** Time spent moving, ms: pauses (standing still) are left out, so average and splits are moving pace. */
  movingMs: number;
  splits: number[];
  /** Moving time when the last full km was crossed (0 before the first). */
  lastSplitMovingMs: number;
  /** Consecutive fixes dropped as GPS jumps since the last accepted one. */
  rejects: PaceFix[];
  /** Session distance and moving time at each kept fix of the last RECENT_WINDOW_MS or so (recent pace). */
  trail: { atMs: number; distanceM: number; movingMs: number }[];
};

/** A step slower than this (heartbeats while standing, GPS drift) is a pause: no distance and no moving time. */
export const PAUSE_SPEED_MPS = 0.5;
/** After this many consecutive dropped fixes that agree with each other, the old position was the outlier. */
export const REANCHOR_AFTER = 3;
/** Per-fix cap on the accuracy used as GPS noise, so one coarse fix does not hide a real move. */
export const MAX_NOISE_ACCURACY_M = 50;
/** Per-fix floor on the accuracy used as GPS noise: phones often report a few metres while wandering more. */
export const MIN_NOISE_ACCURACY_M = 15;

/** How far two fixes can be apart from GPS error alone: the sum of their accuracies, each kept between the floor and the cap. */
export function noiseM(a: PaceFix, b: PaceFix): number {
  const acc = (f: PaceFix) =>
    f.accuracyM != null && Number.isFinite(f.accuracyM) && f.accuracyM > MIN_NOISE_ACCURACY_M
      ? Math.min(f.accuracyM, MAX_NOISE_ACCURACY_M)
      : MIN_NOISE_ACCURACY_M;
  return acc(a) + acc(b);
}

export function newTracker(roomId: string, startedAt: number): Tracker {
  return {
    roomId,
    startedAt,
    lastFix: null,
    lastAtMs: startedAt,
    seenAtMs: startedAt,
    noiseFix: null,
    broken: false,
    firstAtMs: null,
    firstPoint: null,
    distanceM: 0,
    movingMs: 0,
    splits: [],
    lastSplitMovingMs: 0,
    rejects: [],
    trail: [],
  };
}

/**
 * The switch or sharing went off: the next fix re-anchors the session, so the off period (a bus ride, say) adds
 * no distance, moving time, km cue or split. Elapsed time still counts it. Leaving the screen does not break.
 */
export function breakTracker(t: Tracker): Tracker {
  return t.lastFix && !t.broken ? { ...t, broken: true } : t;
}

/**
 * Whether `running` changing from `prev` to `next` is a real stop (switch or sharing turned off): only an observed
 * true -> false within one mount. A mount starts with prev null, and the share state loads as false first, so
 * re-entering the screen (null/false -> true) never breaks the run.
 */
export function runStopped(prev: boolean | null, next: boolean): boolean {
  return prev === true && !next;
}

function plausibleStep(a: PaceFix, b: PaceFix): boolean {
  const dt = (b.atMs - a.atMs) / 1000;
  return dt > 0 && distanceM(a, b) / dt <= MAX_STEP_SPEED_MPS;
}

/**
 * Adds one fix. `kept` is false for a fix that goes back in time or implies a jump faster than
 * MAX_STEP_SPEED_MPS (GPS noise); only kept fixes should feed recent pace and the stationary check.
 * - A pause (slower than PAUSE_SPEED_MPS) adds no distance or moving time, and the next step is measured from it
 *   (distance and time from the same fix, so slow creep or drift over several pauses never adds up to a move).
 * - REANCHOR_AFTER dropped fixes in a row that agree with each other re-anchor the session there, without
 *   adding distance (the earlier position was the bad one, e.g. a wrong first fix).
 * - A long gap (the screen was closed) counts as the straight line between the fixes when it was movement.
 */
export function stepFix(t: Tracker, fix: PaceFix): { tracker: Tracker; kept: boolean } {
  const r = stepFixRaw(t, fix);
  if (!r.kept) return r;
  const tr = r.tracker;
  const trail = [...tr.trail.filter((p) => p.atMs >= tr.seenAtMs - 2 * RECENT_WINDOW_MS), { atMs: tr.seenAtMs, distanceM: tr.distanceM, movingMs: tr.movingMs }];
  return { tracker: { ...tr, trail }, kept: true };
}

function stepFixRaw(t: Tracker, fix: PaceFix): { tracker: Tracker; kept: boolean } {
  if (!t.lastFix) {
    const atMs = Math.max(t.lastAtMs, fix.atMs);
    return { tracker: { ...t, lastFix: fix, lastAtMs: atMs, seenAtMs: atMs, firstAtMs: atMs, firstPoint: { latitude: fix.latitude, longitude: fix.longitude }, rejects: [] }, kept: true };
  }
  const newest = t.rejects.length ? t.rejects[t.rejects.length - 1].atMs : t.seenAtMs;
  if (fix.atMs <= Math.max(t.seenAtMs, newest)) return { tracker: t, kept: false };
  if (t.broken) {
    const tracker = { ...t, lastFix: fix, lastAtMs: fix.atMs, seenAtMs: fix.atMs, noiseFix: null, broken: false, rejects: [] };
    return { tracker, kept: true };
  }
  let dt = (fix.atMs - t.lastAtMs) / 1000;
  const step = distanceM(t.lastFix, fix);
  // Within GPS noise of lastFix (standing still with a wandering fix): kept, but no distance or time, and lastFix
  // stays, so a run of noisy fixes never adds up; the next real move is measured from lastFix.
  if (step < noiseM(t.lastFix, fix)) return { tracker: { ...t, seenAtMs: fix.atMs, noiseFix: fix, rejects: [] }, kept: true };
  if (step / dt > MAX_STEP_SPEED_MPS) {
    const prev = t.rejects[t.rejects.length - 1];
    const rejects = prev && plausibleStep(prev, fix) ? [...t.rejects, fix] : [fix];
    if (rejects.length >= REANCHOR_AFTER) {
      // No distance yet: the first fix was the outlier, so the start point moves too.
      const firstPoint = t.distanceM === 0 ? { latitude: fix.latitude, longitude: fix.longitude } : t.firstPoint;
      return { tracker: { ...t, lastFix: fix, lastAtMs: fix.atMs, seenAtMs: fix.atMs, noiseFix: null, firstPoint, rejects: [] }, kept: true };
    }
    return { tracker: { ...t, rejects }, kept: false };
  }
  if (step / dt < PAUSE_SPEED_MPS) {
    // Leaving the noise circle after a stop: timed from the anchor it looks like a pause, but if it moves at least
    // PAUSE_SPEED_MPS since the last noise fix it is a move. Its distance is from the anchor, its time is that
    // distance at the speed since the last noise fix (the time spent standing is left out).
    const n = t.noiseFix;
    const sinceS = n ? (fix.atMs - n.atMs) / 1000 : 0;
    const speed = n && sinceS > 0 ? distanceM(n, fix) / sinceS : 0;
    // Over MAX_STEP_SPEED_MPS since the noise fix (an outlier at the end of a stop): a pause, as before.
    if (speed < PAUSE_SPEED_MPS || speed > MAX_STEP_SPEED_MPS) {
      return { tracker: { ...t, lastFix: fix, lastAtMs: fix.atMs, seenAtMs: fix.atMs, noiseFix: null, rejects: [] }, kept: true };
    }
    dt = step / speed;
  }
  const before = t.distanceM;
  const after = before + step;
  const movingMs = t.movingMs + dt * 1000;
  const splits = [...t.splits];
  let lastSplitMovingMs = t.lastSplitMovingMs;
  // Each km boundary crossed on this step, at the interpolated moving time.
  for (let km = Math.floor(before / 1000) + 1; km * 1000 <= after; km++) {
    const crossedAt = t.movingMs + ((km * 1000 - before) / step) * dt * 1000;
    splits.push((crossedAt - lastSplitMovingMs) / 1000);
    lastSplitMovingMs = crossedAt;
  }
  return {
    tracker: {
      ...t,
      lastFix: fix,
      lastAtMs: fix.atMs,
      seenAtMs: fix.atMs,
      noiseFix: null,
      distanceM: after,
      movingMs,
      splits,
      lastSplitMovingMs,
      rejects: [],
    },
    kept: true,
  };
}

/**
 * Several fixes at once (delayed fixes delivered together after the app was in the background): in time order,
 * repeats once. Returns the fixes that were kept, in order.
 */
export function stepFixes(t: Tracker, fixes: PaceFix[]): { tracker: Tracker; kept: PaceFix[] } {
  const ordered = [...fixes].filter((f) => Number.isFinite(f.atMs)).sort((a, b) => a.atMs - b.atMs);
  const kept: PaceFix[] = [];
  for (const f of ordered) {
    const r = stepFix(t, f);
    t = r.tracker;
    if (r.kept) kept.push(f);
  }
  return { tracker: t, kept };
}

export function addFix(t: Tracker, fix: PaceFix): Tracker {
  return stepFix(t, fix).tracker;
}

/** durationS is moving time, elapsedS first to last fix; avgSecPerKm is moving pace (null under MIN_PACE_DISTANCE_M). */
export function summarize(t: Tracker): PaceSession {
  const durationS = Math.max(0, Math.round(t.movingMs / 1000));
  const avgSecPerKm = t.distanceM >= MIN_PACE_DISTANCE_M && durationS > 0 ? durationS / (t.distanceM / 1000) : null;
  const elapsedS = t.firstAtMs == null ? 0 : Math.max(durationS, Math.round((t.seenAtMs - t.firstAtMs) / 1000));
  return {
    roomId: t.roomId,
    startedAt: t.startedAt,
    durationS,
    elapsedS,
    distanceM: t.distanceM,
    avgSecPerKm,
    splits: t.splits,
  };
}

/**
 * My pace over the last minute of fixes: the session distance gained over the moving time it took (GPS noise and
 * pauses add neither, so stopping does not read as running slow); null with fewer than 2 fixes in the window or
 * under 20 m gained.
 */
export function recentPace(t: Tracker, nowMs: number, windowMs = RECENT_WINDOW_MS): number | null {
  const inWindow = t.trail.filter((p) => p.atMs >= nowMs - windowMs && p.atMs <= nowMs);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const gained = last.distanceM - first.distanceM;
  const dt = (last.movingMs - first.movingMs) / 1000;
  if (gained < MIN_RECENT_DISTANCE_M || dt <= 0) return null;
  return dt / (gained / 1000);
}

// --- cues -------------------------------------------------------------------------------------------------------

export type PaceCueState = { lastKm: number; lastOffCueAtMs: number | null };
export type PaceCue =
  | { kind: 'km'; km: number; pace: string | null; target: string | null }
  | { kind: 'slow' | 'fast'; pace: string; target: string };

export function newPaceCueState(): PaceCueState {
  return { lastKm: 0, lastOffCueAtMs: null };
}

/**
 * At each new km: the km's split and the target. Otherwise, every OFF_TARGET_EVERY_MS at most, a cue when the
 * last minute's pace is more than 5% off the target: slower says pick it up, faster says ease off.
 */
export function paceCue(
  state: PaceCueState,
  input: { nowMs: number; km: number; lastSplitS: number | null; recentSecPerKm: number | null; targetSecPerKm: number | null },
): { state: PaceCueState; cue: PaceCue | null } {
  const target = formatPace(input.targetSecPerKm);
  if (input.km > state.lastKm) {
    return {
      state: { lastKm: input.km, lastOffCueAtMs: input.nowMs },
      cue: { kind: 'km', km: input.km, pace: formatPace(input.lastSplitS), target },
    };
  }
  const recent = input.recentSecPerKm;
  const goal = input.targetSecPerKm;
  if (recent == null || goal == null || !target) return { state, cue: null };
  if (state.lastOffCueAtMs != null && input.nowMs - state.lastOffCueAtMs < OFF_TARGET_EVERY_MS) return { state, cue: null };
  if (Math.abs(recent - goal) / goal <= OFF_TARGET_SHARE) return { state, cue: null };
  const pace = formatPace(recent);
  if (!pace) return { state, cue: null };
  return {
    state: { ...state, lastOffCueAtMs: input.nowMs },
    cue: { kind: recent > goal ? 'slow' : 'fast', pace, target },
  };
}

// --- lead group -------------------------------------------------------------------------------------------------

/** Meters along the route to the point's projection on the nearest segment (flat projection per segment). */
export function progressAlongRoute(point: Point, route: Point[]): number {
  if (route.length < 2) return 0;
  const rad = Math.PI / 180;
  const kx = Math.cos(point.latitude * rad) * rad * EARTH_RADIUS_M;
  const ky = rad * EARTH_RADIUS_M;
  const xy = (p: Point) => ({ x: p.longitude * kx, y: p.latitude * ky });
  const q = xy(point);
  let best = { dist: Infinity, progress: 0 };
  let along = 0;
  for (let i = 1; i < route.length; i++) {
    const a = xy(route[i - 1]);
    const b = xy(route[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const dist = Math.hypot(q.x - px, q.y - py);
    const segLen = distanceM(route[i - 1], route[i]);
    if (dist < best.dist) best = { dist, progress: along + t * segLen };
    along += segLen;
  }
  return best.progress;
}

/**
 * How far along a member is: along the room's route when it has 2+ points, otherwise the distance from the
 * anchor (the room's place pin, or where the activity started); null with neither.
 */
export function progressOf(point: Point, route: Point[], anchor: Point | null): number | null {
  if (route.length >= 2) return progressAlongRoute(point, route);
  return anchor ? distanceM(anchor, point) : null;
}

export type Runner = { userId: string; progressM: number; speedMps: number | null };
export type LeadGroup = { members: string[]; frontM: number; rearM: number; speedMps: number | null };

/** Members within LEAD_GROUP_SPAN_M of the front-most member. */
export function leadGroup(runners: Runner[]): LeadGroup | null {
  if (runners.length === 0) return null;
  const frontM = Math.max(...runners.map((r) => r.progressM));
  const inGroup = runners.filter((r) => r.progressM >= frontM - LEAD_GROUP_SPAN_M);
  const speeds = inGroup.flatMap((r) => (r.speedMps != null && Number.isFinite(r.speedMps) && r.speedMps >= 0 ? [r.speedMps] : []));
  return {
    members: inGroup.map((r) => r.userId),
    frontM,
    rearM: Math.min(...inGroup.map((r) => r.progressM)),
    speedMps: speeds.length ? speeds.reduce((s, v) => s + v, 0) / speeds.length : null,
  };
}

/** pace null: the catch-up pace is unrealistic (CATCH_UP_LIMIT), so the cue says "keep your pace" instead. */
export type GapCue = { gapM: number; secPerKm: number; pace: string | null };

/** A catch-up pace faster than this share of the target time per km is not asked for. */
export const CATCH_UP_LIMIT = 0.7;
/** With no target: no catch-up pace faster than 3:00 per km. */
export const CATCH_UP_FASTEST_SEC_PER_KM = 180;

/**
 * More than BEHIND_GAP_M behind the lead group's last member: the pace that closes the gap in CATCH_UP_S at the
 * group's average speed (the gap alone when no group speed is known). A pace faster than CATCH_UP_LIMIT × target
 * (CATCH_UP_FASTEST_SEC_PER_KM with no target) comes back with pace null ("too far, keep your pace").
 */
export function gapCue(myId: string, runners: Runner[], targetSecPerKm: number | null = null): GapCue | null {
  const me = runners.find((r) => r.userId === myId);
  const group = leadGroup(runners);
  if (!me || !group || group.members.includes(myId)) return null;
  const gapM = Math.round(group.rearM - me.progressM);
  if (gapM <= BEHIND_GAP_M) return null;
  const needed = (group.speedMps ?? 0) + gapM / CATCH_UP_S;
  const secPerKm = 1000 / needed;
  const fastest = targetSecPerKm != null && targetSecPerKm > 0 ? CATCH_UP_LIMIT * targetSecPerKm : CATCH_UP_FASTEST_SEC_PER_KM;
  if (secPerKm < fastest) return { gapM, secPerKm, pace: null };
  const pace = formatPace(secPerKm);
  return pace ? { gapM, secPerKm, pace } : null;
}

/** My fixes of this window decide whether I am standing still for cues. */
export const STOPPED_WINDOW_MS = 60_000;

/**
 * Standing still for cues: at least 2 of my fixes in the last STOPPED_WINDOW_MS and all within STATIONARY_RADIUS_M
 * of their centroid. A wobbling simulator or GPS fix can read as slow movement (a recent pace) while I stand.
 */
export function standingStill(fixes: PaceFix[], nowMs: number): boolean {
  const inWindow = fixes.filter((f) => f.atMs >= nowMs - STOPPED_WINDOW_MS && f.atMs <= nowMs);
  return inWindow.length >= 2 && withinStationaryRadius(inWindow);
}

// --- cue cadence ------------------------------------------------------------------------------------------------

/** Two cues never come closer than this, so they do not talk over each other. */
export const MIN_CUE_GAP_MS = 20_000;

/** Pace cues (km, slow, fast) and gap cues keep separate clocks; lastCueAtMs is any cue. */
export type CueSchedule = { pace: PaceCueState; lastGapCueAtMs: number | null; lastCueAtMs: number | null };
export type ChosenCue = PaceCue | ({ kind: 'gap' } & GapCue);

export function newCueSchedule(): CueSchedule {
  return { pace: newPaceCueState(), lastGapCueAtMs: null, lastCueAtMs: null };
}

/**
 * At most one cue per fix, never within MIN_CUE_GAP_MS of the last one. A km cue that falls in that window waits
 * (its km is not marked done) and comes on the first fix after it, with the latest split. Order: km, then the
 * lead-group gap (at most every OFF_TARGET_EVERY_MS on its own clock), then off-target (at most every
 * OFF_TARGET_EVERY_MS, through paceCue; a km cue restarts that clock); off-target stays quiet while I am behind the lead group.
 * No gap cue while I am standing still (no recent pace): "Run 2:18 per km" to someone stopped, maybe with the
 * "Everything okay?" sheet open, is wrong; it comes once I move again. `stopped` (the sheet is open, or standingStill)
 * also keeps the gap and off-target cues quiet, even when a wobbling fix gives a recent pace.
 */
export function chooseCue(
  schedule: CueSchedule,
  input: {
    nowMs: number;
    km: number;
    lastSplitS: number | null;
    recentSecPerKm: number | null;
    targetSecPerKm: number | null;
    gap: GapCue | null;
    stopped?: boolean;
  },
): { schedule: CueSchedule; cue: ChosenCue | null } {
  if (schedule.lastCueAtMs != null && input.nowMs - schedule.lastCueAtMs < MIN_CUE_GAP_MS) return { schedule, cue: null };
  const paced = paceCue(schedule.pace, input);
  const said = (next: Partial<CueSchedule>, cue: ChosenCue) => ({
    schedule: { ...schedule, ...next, lastCueAtMs: input.nowMs },
    cue,
  });
  if (paced.cue?.kind === 'km') return said({ pace: paced.state }, paced.cue);
  if (input.stopped) return { schedule, cue: null };
  const gapDue = schedule.lastGapCueAtMs == null || input.nowMs - schedule.lastGapCueAtMs >= OFF_TARGET_EVERY_MS;
  if (input.gap && gapDue && input.recentSecPerKm != null) return said({ lastGapCueAtMs: input.nowMs }, { kind: 'gap', ...input.gap });
  if (!input.gap && paced.cue) return said({ pace: paced.state }, paced.cue);
  return { schedule, cue: null };
}

// --- stationary -------------------------------------------------------------------------------------------------

export type StationaryState = { openSinceMs: number | null; snoozeUntilMs: number | null };

export function newStationaryState(): StationaryState {
  return { openSinceMs: null, snoozeUntilMs: null };
}

/** Every fix within radiusM of the fixes' centroid (a fix wandering around a standing point stays inside). */
export function withinStationaryRadius(fixes: Point[], radiusM = STATIONARY_RADIUS_M): boolean {
  if (fixes.length === 0) return false;
  const center = {
    latitude: fixes.reduce((s, f) => s + f.latitude, 0) / fixes.length,
    longitude: fixes.reduce((s, f) => s + f.longitude, 0) / fixes.length,
  };
  return fixes.every((f) => distanceM(center, f) <= radiusM);
}

/**
 * Whether to ask "Everything okay?": during the activity, my fixes covered the last 3 minutes (one at or
 * before its start, no long gaps, the newest fresh) and all stayed within 25 m of their centroid. Not while the prompt is open
 * or snoozed after Dismiss. It only opens the status sheet; it never sets a status by itself.
 */
export function stationaryDue(
  fixes: PaceFix[],
  nowMs: number,
  activityStartMs: number,
  state: StationaryState,
): boolean {
  if (state.openSinceMs != null) return false;
  if (state.snoozeUntilMs != null && nowMs < state.snoozeUntilMs) return false;
  const windowStart = nowMs - STATIONARY_MS;
  if (windowStart < activityStartMs) return false;
  const sorted = fixes.filter((f) => f.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs);
  const newest = sorted[sorted.length - 1];
  if (!newest || nowMs - newest.atMs > STATIONARY_FRESH_MS) return false;
  let anchorIndex = -1;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].atMs <= windowStart) anchorIndex = i;
  if (anchorIndex < 0) return false;
  const window = sorted.slice(anchorIndex);
  for (let i = 1; i < window.length; i++) if (window[i].atMs - window[i - 1].atMs > STATIONARY_MAX_GAP_MS) return false;
  return withinStationaryRadius(window);
}

export function openStationary(state: StationaryState, nowMs: number): StationaryState {
  return { ...state, openSinceMs: nowMs };
}

/** Dismiss or a picked status: closed, and no repeat for STATIONARY_SNOOZE_MS. */
export function closeStationary(nowMs: number): StationaryState {
  return { openSinceMs: null, snoozeUntilMs: nowMs + STATIONARY_SNOOZE_MS };
}

// --- history ----------------------------------------------------------------------------------------------------

export const HISTORY_LIMIT = 20;

/** Adds or replaces (same room and start) a session; newest first, at most HISTORY_LIMIT kept. */
export function mergeSession(history: PaceSession[], session: PaceSession): PaceSession[] {
  const rest = history.filter((s) => !(s.roomId === session.roomId && s.startedAt === session.startedAt));
  return [session, ...rest].sort((a, b) => b.startedAt - a.startedAt).slice(0, HISTORY_LIMIT);
}

/** Parses stored history, dropping anything malformed. */
export function parseHistory(raw: string | null): PaceSession[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (s): s is PaceSession =>
        !!s &&
        typeof s === 'object' &&
        typeof s.roomId === 'string' &&
        Number.isFinite(s.startedAt) &&
        Number.isFinite(s.durationS) &&
        (s.elapsedS === undefined || Number.isFinite(s.elapsedS)) &&
        Number.isFinite(s.distanceM) &&
        (s.avgSecPerKm === null || Number.isFinite(s.avgSecPerKm)) &&
        Array.isArray(s.splits),
    );
  } catch {
    return [];
  }
}

export type PaceSummary = { distanceM: number; durationS: number; elapsedS: number; avgSecPerKm: number };

/**
 * The recap's pace part: the latest session in this room that has an average pace (100 m or more), or null.
 * durationS is moving time; elapsedS includes stops (a session saved before elapsedS existed uses durationS).
 */
export function summaryFor(history: PaceSession[], roomId: string): PaceSummary | null {
  const s = [...history]
    .sort((a, b) => b.startedAt - a.startedAt)
    .find((x) => x.roomId === roomId && x.avgSecPerKm != null);
  return s && s.avgSecPerKm != null
    ? {
        distanceM: Math.round(s.distanceM),
        durationS: s.durationS,
        elapsedS: Math.max(s.durationS, s.elapsedS ?? s.durationS),
        avgSecPerKm: Math.round(s.avgSecPerKm),
      }
    : null;
}

/**
 * The recap's summary with live runs counted: the recap can be built right after the host ends the activity, while
 * the run is still in memory or its save has not finished. Live sessions replace their saved copy (same room and
 * start), so nothing is counted twice and history is not written.
 */
export function summaryWithLive(history: PaceSession[], live: PaceSession[], roomId: string): PaceSummary | null {
  return summaryFor(live.reduce(mergeSession, history), roomId);
}

/** The recap line's parts for a summary ("12:00" moving, "17:00" total, "5:00" pace), or null with no session. */
export function recapParts(
  summary: PaceSummary | null | undefined,
): { distanceM: number; moving: string; total: string; pace: string } | null {
  const pace = summary ? formatPace(summary.avgSecPerKm) : null;
  if (!summary || !pace) return null;
  return {
    distanceM: summary.distanceM,
    moving: formatDuration(summary.durationS),
    total: formatDuration(Math.max(summary.durationS, summary.elapsedS)),
    pace,
  };
}

// --- target input -----------------------------------------------------------------------------------------------

/** "5:30" -> 330 s per km. Minutes 1-30, seconds 0-59. */
export function parsePace(text: string): number | null {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(text);
  if (!m) return null;
  const s = Number(m[1]) * 60 + Number(m[2]);
  return s >= 60 && s <= 30 * 60 ? s : null;
}

/** "50:00" or "1:45:00" -> seconds; null otherwise. */
export function parseDuration(text: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)\s*$/.exec(text);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  if (m[1] && min > 59) return null;
  const s = h * 3600 + min * 60 + Number(m[3]);
  return s > 0 ? s : null;
}

/** "10" or "21.1" (or "21,1") km -> meters, 0.1-200 km. */
export function parseKm(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0.1 && n <= 200 ? Math.round(n * 1000) : null;
}

/** "12:05" or "1:02:05" for a duration in seconds. */
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// --- spoken cues -------------------------------------------------------------------------------------------------
// Speech gets its own wording: no clock-style m:ss (read as a time of day) and no "km". The banner keeps the
// display copy (strings.ts); only the speech queue uses these.

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "0 seconds", "59 seconds", "1 minute", "5 minutes 2 seconds", "1 hour 5 minutes" (whole seconds). */
export function spokenDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h ? plural(h, 'hour') : null, m ? plural(m, 'minute') : null, s || (!h && !m) ? plural(s, 'second') : null];
  return parts.filter(Boolean).join(' ');
}

/** "150 meters" under 1 km, then kilometers to one decimal: "1 kilometer", "2.4 kilometers", "12 kilometers". */
export function spokenDistance(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  if (m < 1000) return plural(m, 'meter');
  const km = Math.round(m / 100) / 10;
  return `${km} kilometer${km === 1 ? '' : 's'}`;
}

/** Seconds from formatPace's "m:ss" (the cues carry it), or null. */
function paceSeconds(text: string | null): number | null {
  const match = text ? /^(\d+):([0-5]\d)$/.exec(text) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const spokenPace = (text: string | null) => {
  const s = paceSeconds(text);
  return s == null ? null : `${spokenDuration(s)} per kilometer`;
};

/** The words spoken for a cue; same content as the banner (strings.ts cue*), said as words. */
export function spokenCue(cue: ChosenCue): string {
  if (cue.kind === 'gap') {
    if (cue.pace == null)
      return `Lead group ${spokenDistance(cue.gapM)} ahead. Too far to catch in ${spokenDuration(CATCH_UP_S)}: keep your pace.`;
    const run = spokenPace(cue.pace) ?? cue.pace;
    return `Lead group ${spokenDistance(cue.gapM)} ahead. Run ${run} to catch them in ${spokenDuration(CATCH_UP_S)}.`;
  }
  const target = paceSeconds(cue.target);
  const targetPart = target == null ? '' : `, target ${spokenDuration(target)}`;
  switch (cue.kind) {
    case 'km': {
      const split = paceSeconds(cue.pace);
      return `${plural(cue.km, 'kilometer')}${split == null ? '' : `, split ${spokenDuration(split)}`}${targetPart}.`;
    }
    case 'slow':
      return `Pick it up: ${spokenPace(cue.pace) ?? cue.pace}${targetPart}.`;
    case 'fast':
      return `Ease off: ${spokenPace(cue.pace) ?? cue.pace}${targetPart}.`;
  }
}

// --- Qrewing bot `me` snapshot (spec 10.3/10.4) ----------------------------------------------------------------
// Only these four fields leave the phone, for the asker only: never a position.

export type PaceSnapshot = {
  /** Moving seconds (pauses under PAUSE_SPEED_MPS left out), as in the pace card and recap. */
  elapsedSec: number;
  /** Whole metres. */
  distanceM: number;
  /** Average moving pace, s/km; null under MIN_PACE_DISTANCE_M or outside the server's range. */
  paceSecPerKm: number | null;
  /** My own state now: 'moving' when my newest fix added distance and is fresh, otherwise 'stopped'. */
  activity: 'moving' | 'stopped';
};

/** A move older than this (no new fix, or only pauses and GPS noise since) reads as stopped. */
export const SNAPSHOT_MOVING_FRESH_MS = 30_000;
/** The ask action accepts paceSecPerKm in [0, 3600]; slower than 1 km/h is sent as null instead of being rejected. */
export const SNAPSHOT_MAX_PACE_S = 3600;

/**
 * Null when no activity is running in the room or my tracker for it has no fix yet; otherwise my moving time,
 * distance, average moving pace and whether I am moving now.
 */
export function currentPaceSnapshot(input: {
  activityRunning: boolean;
  tracker: Tracker | null | undefined;
  nowMs: number;
}): PaceSnapshot | null {
  const t = input.tracker;
  if (!input.activityRunning || !t || !t.lastFix) return null;
  const elapsedSec = Math.max(0, Math.round(t.movingMs / 1000));
  const distanceM = Math.max(0, Math.round(t.distanceM));
  const raw = t.distanceM >= MIN_PACE_DISTANCE_M && elapsedSec > 0 ? Math.round(elapsedSec / (t.distanceM / 1000)) : null;
  const paceSecPerKm = raw != null && raw <= SNAPSHOT_MAX_PACE_S ? raw : null;
  return { elapsedSec, distanceM, paceSecPerKm, activity: movingNow(t, input.nowMs) ? 'moving' : 'stopped' };
}

/** The newest trail point added moving time over the one before it, and it is at most SNAPSHOT_MOVING_FRESH_MS old. */
function movingNow(t: Tracker, nowMs: number): boolean {
  const n = t.trail.length;
  if (n < 2) return false;
  const last = t.trail[n - 1];
  const prev = t.trail[n - 2];
  return last.movingMs > prev.movingMs && nowMs - last.atMs <= SNAPSHOT_MOVING_FRESH_MS;
}
