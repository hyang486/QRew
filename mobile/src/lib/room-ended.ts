// Pure helpers for the Qrew "This room has ended" screen (Q 06.04). No React Native imports, so `npm test`
// can load them.

/** The room fields the ended screen reads. */
export type EndedRoomFields = { deleted_at: string | null; expires_at: string };

/**
 * When the room closed, only when the client actually knows it: the host's end time (deleted_at) or an end
 * time that has passed (expires_at <= now). Null when the room row is gone (RLS hides it once it closes, or the
 * user left) or it has not closed yet. Never a guess.
 */
export function roomClosedAtMs(room: EndedRoomFields | null | undefined, nowMs: number): number | null {
  if (!room) return null;
  if (room.deleted_at !== null) {
    const ended = new Date(room.deleted_at).getTime();
    return Number.isFinite(ended) ? ended : null;
  }
  const expires = new Date(room.expires_at).getTime();
  return Number.isFinite(expires) && expires <= nowMs ? expires : null;
}

/** True when both times fall on the same local calendar day (the line then shows the time only). */
export function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** setTimeout's largest delay (about 24.8 days). A longer wait fires early and is armed again. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * G-U6-1: how long to wait before a loaded room's end time (expires_at) passes, so an open room screen can switch
 * to the ended screen right at the end instead of on its next clock tick. 0 once it has passed; capped at
 * MAX_TIMER_MS; null when the time cannot be read.
 */
export function endTimerDelay(expiresAt: string, nowMs: number): number | null {
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  return Math.min(Math.max(0, expires - nowMs), MAX_TIMER_MS);
}

/** When an open room screen saw its room's end time pass (set by useRoomOver's timer). */
export type EndSeen = { expiresAt: string; atMs: number };

/**
 * G-U6-1: whether a loaded room is over: the host ended it (deleted_at), or the timer saw this end time pass.
 * A seen end for an older expires_at (the host then extended the room) does not count. `nowMs` is when the end
 * was seen, for the ended screen's "closed at" line.
 */
export function roomOverState(
  room: EndedRoomFields | null | undefined,
  seen: EndSeen | null,
): { over: boolean; nowMs?: number } {
  if (!room) return { over: false };
  if (room.deleted_at !== null) return { over: true };
  if (seen && seen.expiresAt === room.expires_at) return { over: true, nowMs: seen.atMs };
  return { over: false };
}
