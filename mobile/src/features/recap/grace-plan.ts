// Pure logic for the early-end grace period (spec 7, human decision 2026-11-12 (b)). No React Native imports, so
// `npm test` can load it.
//
// When the host ends a room with end_room, the server sets deleted_at = now() and grace_until = now() + 30 min.
// During grace only the recap, Photos of me and Photos & files (view and download) work; then the janitor deletes
// the room. A room that reaches expires_at has no grace (grace_until stays null).

import type { Tables } from '@/lib/database.types';

/** The room fields grace reads (generated types, 0027 applied). */
export type GraceRoomFields = Pick<Tables<'rooms'>, 'deleted_at' | 'expires_at' | 'grace_until'>;

export type RoomPhase = 'open' | 'grace' | 'ended';

function ms(v: string | null | undefined): number | null {
  if (typeof v !== 'string') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** When grace ends, only while the room is in grace at `nowMs`; otherwise null. */
export function graceUntilMs(room: GraceRoomFields | null | undefined, nowMs: number): number | null {
  if (!room || room.deleted_at === null) return null;
  const until = ms(room.grace_until);
  return until !== null && until > nowMs ? until : null;
}

/**
 * open: not ended and the end time has not passed. grace: the host ended it and grace_until is still ahead.
 * ended: everything else (expired, grace over, no row). An unreadable grace_until reads as ended, never as grace.
 */
export function roomPhase(room: GraceRoomFields | null | undefined, nowMs: number): RoomPhase {
  if (!room) return 'ended';
  if (room.deleted_at !== null) return graceUntilMs(room, nowMs) !== null ? 'grace' : 'ended';
  const expires = ms(room.expires_at);
  return expires !== null && expires > nowMs ? 'open' : 'ended';
}

/** True only while the host-ended room is inside its grace window. */
export function isGrace(room: GraceRoomFields | null | undefined, nowMs: number): boolean {
  return roomPhase(room, nowMs) === 'grace';
}

/** setTimeout's largest delay; a longer wait fires early and is armed again. */
const MAX_TIMER_MS = 2_147_483_647;

/** How long until grace ends, so an open Room ended screen can switch to the plain ended state on time. */
export function graceTimerDelay(room: GraceRoomFields | null | undefined, nowMs: number): number | null {
  const until = graceUntilMs(room, nowMs);
  if (until === null) return null;
  return Math.min(until - nowMs, MAX_TIMER_MS);
}

/** What a room screen may do in each phase. Grace is read-only: view and download, nothing else. */
export function graceAllows(phase: RoomPhase): { read: boolean; write: boolean } {
  if (phase === 'open') return { read: true, write: true };
  if (phase === 'grace') return { read: true, write: false };
  return { read: false, write: false };
}

/** The room list row: grace rooms open the Room ended screen instead of chat, with their end-of-grace time. */
export function roomListEntry(
  room: GraceRoomFields | null | undefined,
  nowMs: number,
): { kind: 'open' } | { kind: 'grace'; untilMs: number } | { kind: 'hidden' } {
  const phase = roomPhase(room, nowMs);
  if (phase === 'open') return { kind: 'open' };
  if (phase === 'grace') return { kind: 'grace', untilMs: graceUntilMs(room, nowMs) as number };
  return { kind: 'hidden' };
}

/** What each grace-aware screen shows. Writes are hidden in grace; the server also refuses them (spec 7.1). */
export type ScreenActions = {
  /** Gallery: the grid of photos and files, and opening an item. */
  view: boolean;
  /** Media detail: Save original and Share (a checked download). */
  download: boolean;
  /** Gallery: "+" and "Add photos or files". */
  upload: boolean;
  /** Media detail: "Not me" on a photo in my Photos of me. */
  notMe: boolean;
  /** Photos of me: ask the service to run matching for pending jobs. */
  matchRun: boolean;
  /** Photos of me: Set up and Manage (enroll, replace, stop), and the face.tsx form. */
  setup: boolean;
  /** Show the Room ended screen instead of this one. */
  endedScreen: boolean;
};

export function screenActions(screen: 'gallery' | 'media' | 'photos-of-me' | 'face', phase: RoomPhase): ScreenActions {
  const { read, write } = graceAllows(phase);
  // face.tsx is only setup (all writes), so in grace it shows the grace Room ended screen with its links.
  const endedScreen = !read || (screen === 'face' && !write);
  const shown = read && !endedScreen;
  return {
    view: shown,
    download: shown,
    upload: shown && write && screen === 'gallery',
    notMe: shown && write && screen === 'media',
    matchRun: shown && write && screen === 'photos-of-me',
    setup: shown && write && (screen === 'photos-of-me' || screen === 'face'),
    endedScreen,
  };
}
