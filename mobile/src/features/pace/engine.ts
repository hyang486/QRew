import { useSyncExternalStore } from 'react';

import {
  breakTracker,
  type ChosenCue,
  chooseCue,
  closeStationary,
  currentPaceSnapshot,
  type CueSchedule,
  gapCue,
  newCueSchedule,
  newStationaryState,
  newTracker,
  openStationary,
  type PaceFix,
  type PaceSession,
  type Point,
  progressOf,
  spokenCue,
  standingStill,
  recentPace,
  type Runner,
  type StationaryState,
  stationaryDue,
  stepFixes,
  summarize,
  type Tracker,
} from './pace-core';
import { saveSession } from './storage';
import { en } from '@/i18n/en';
import { speak } from './voice';
const t = en.pace;

/**
 * One pace session per room and activity (activity_seq), kept for the app run so leaving and reopening the Map
 * keeps the same session. Screens read it with usePaceSession; PaceLayer feeds it.
 */
export type PaceRun = {
  key: string;
  tracker: Tracker;
  /** My fixes of the last few minutes (stationary check, recent pace). */
  fixes: PaceFix[];
  cues: CueSchedule;
  stationary: StationaryState;
  lastSavedAtMs: number;
  /** My pace over the last minute, s/km. */
  recent: number | null;
};

const FIX_KEEP_MS = 6 * 60_000;
const SAVE_EVERY_MS = 30_000;

const runs = new Map<string, PaceRun>();
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const runKey = (roomId: string, activitySeq: number) => `${roomId}:${activitySeq}`;

export function usePaceRun(key: string | null): PaceRun | null {
  return useSyncExternalStore(subscribe, () => (key ? (runs.get(key) ?? null) : null));
}

function getRun(key: string, roomId: string, nowMs: number): PaceRun {
  let run = runs.get(key);
  if (!run) {
    run = {
      key,
      tracker: newTracker(roomId, nowMs),
      fixes: [],
      cues: newCueSchedule(),
      stationary: newStationaryState(),
      lastSavedAtMs: 0,
      recent: null,
    };
    runs.set(key, run);
  }
  return run;
}

function put(run: PaceRun) {
  runs.set(run.key, run);
  emit();
}

/**
 * The switch or sharing went off while the screen is open: the next fix re-anchors the session (the off period adds
 * no distance or moving time), and the stationary check starts over from the fixes after it.
 */
export function breakRun(key: string) {
  const run = runs.get(key);
  if (!run || !run.tracker.lastFix || run.tracker.broken) return;
  put({ ...run, tracker: breakTracker(run.tracker), fixes: [] });
}

/** Saves the session to history now (End activity, switch off, leaving the screen). */
export function flushRun(key: string) {
  const run = runs.get(key);
  if (!run || !run.tracker.lastFix) return;
  put({ ...run, lastSavedAtMs: Date.now() });
  saveSession(summarize(run.tracker)).catch(() => {});
}

/** The Qrewing bot's `me` for this room's running activity (spec 10.4); null when none is running or unmeasured. */
export function paceSnapshot(room: { id: string; activity_state: string; activity_seq: number }, nowMs = Date.now()) {
  const tracker = runs.get(runKey(room.id, room.activity_seq))?.tracker;
  return currentPaceSnapshot({ activityRunning: room.activity_state === 'active', tracker, nowMs });
}

/** My own start point in this room's current activity (engine anchor when there is no place pin); null when unmeasured. */
export function paceStartPoint(room: { id: string; activity_seq: number }): Point | null {
  return runs.get(runKey(room.id, room.activity_seq))?.tracker.firstPoint ?? null;
}

/** My in-memory sessions in this room (any activity), for a recap built before or while they are saved. */
export function liveSessions(roomId: string): PaceSession[] {
  const out: PaceSession[] = [];
  for (const run of runs.values()) {
    if (run.tracker.roomId === roomId && run.tracker.lastFix) out.push(summarize(run.tracker));
  }
  return out;
}

export type FeedContext = {
  roomId: string;
  userId: string;
  nowMs: number;
  targetSecPerKm: number | null;
  route: Point[];
  /** The room's place pin, if set. */
  place: Point | null;
  /** Other members' fresh positions and speeds (stale rows already removed); mine included. */
  others: { userId: string; point: Point; speedMps: number | null }[];
};

function cueText(cue: ChosenCue): string {
  switch (cue.kind) {
    case 'km':
      return t.cueKm(cue.km, cue.pace, cue.target);
    case 'gap':
      if (cue.mode === 'pickUp') return t.cueGapPickUp(cue.gapM);
      return cue.pace == null ? t.cueGapKeep(cue.gapM) : t.cueGap(cue.gapM, cue.pace);
    case 'slow':
      return t.cueSlow(cue.pace, cue.target);
    case 'fast':
      return t.cueFast(cue.pace, cue.target);
  }
}

/** One new fix of mine: stats, then at most one cue (km first, then the lead-group gap, then off-target). */
export function feedFix(key: string, fix: PaceFix, ctx: FeedContext) {
  feedFixes(key, [fix], ctx);
}

/** Fixes of mine, possibly several delayed ones at once: taken in time order, repeats once, then at most one cue. */
export function feedFixes(key: string, batch: PaceFix[], ctx: FeedContext) {
  let run = getRun(key, ctx.roomId, ctx.nowMs);
  const stepped = stepFixes(run.tracker, batch);
  // Repeats, older fixes or GPS jumps only: nothing to update (the tracker keeps its count of dropped jumps).
  if (!stepped.kept.length) {
    if (stepped.tracker !== run.tracker) put({ ...run, tracker: stepped.tracker });
    return;
  }
  const tracker = stepped.tracker;
  const fixes = [...run.fixes, ...stepped.kept].filter((f) => f.atMs >= ctx.nowMs - FIX_KEEP_MS);
  const recent = recentPace(tracker, tracker.seenAtMs);
  run = { ...run, tracker, fixes, recent };

  // The activity start point: where my session's first fix was (run.fixes keeps only the last few minutes).
  const anchor = ctx.place ?? tracker.firstPoint;
  const runners: Runner[] = ctx.others.flatMap((o) => {
    const progressM = progressOf(o.point, ctx.route, anchor);
    return progressM == null ? [] : [{ userId: o.userId, progressM, speedMps: o.speedMps }];
  });
  const chosen = chooseCue(run.cues, {
    nowMs: ctx.nowMs,
    km: Math.floor(tracker.distanceM / 1000),
    lastSplitS: tracker.splits.length ? tracker.splits[tracker.splits.length - 1] : null,
    recentSecPerKm: recent,
    targetSecPerKm: ctx.targetSecPerKm,
    gap: gapCue(ctx.userId, runners, ctx.targetSecPerKm, recent),
    stopped: run.stationary.openSinceMs != null || standingStill(fixes, tracker.seenAtMs),
  });
  run = { ...run, cues: chosen.schedule };
  const text = chosen.cue ? cueText(chosen.cue) : null;

  const save = ctx.nowMs - run.lastSavedAtMs >= SAVE_EVERY_MS;
  if (save) run = { ...run, lastSavedAtMs: ctx.nowMs };
  put(run);
  if (save) saveSession(summarize(run.tracker)).catch(() => {});
  if (text && chosen.cue) speak(text, spokenCue(chosen.cue));
}

/** Every few seconds: whether to open the "Everything okay?" status sheet. Returns true when it opened. */
export function checkStationary(key: string, nowMs: number, activityStartMs: number): boolean {
  const run = runs.get(key);
  if (!run) return false;
  const since = Math.max(activityStartMs, run.tracker.startedAt);
  if (!stationaryDue(run.fixes, nowMs, since, run.stationary)) return false;
  put({
    ...run,
    stationary: openStationary(run.stationary, nowMs),
    cues: { ...run.cues, lastCueAtMs: nowMs },
  });
  speak(t.stationaryTitle);
  return true;
}

/** Dismiss, a picked status or Cancel: closed, no repeat for 10 minutes. */
export function closeStationaryPrompt(key: string, nowMs: number) {
  const run = runs.get(key);
  if (run) put({ ...run, stationary: closeStationary(nowMs) });
}
