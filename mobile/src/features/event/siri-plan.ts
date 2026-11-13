// Spec 10.5: the Keychain mirror the Siri App Intent (Swift, no JS) reads. Contract agreed with developer:
// SecureStore key `qrew.siri.v1`, keychainService `com.qrew.siri` (stored as service "com.qrew.siri:no-auth",
// account Data("qrew.siri.v1")), AFTER_FIRST_UNLOCK. Never the refresh token: Swift never refreshes.

export const SIRI_KEY = 'qrew.siri.v1';
export const SIRI_SERVICE = 'com.qrew.siri';

/** The room fields the active-room choice needs (a `rooms` row has them all). */
export type SiriRoom = { id: string; deleted_at: string | null; expires_at: string; created_at: string };

/** Open: not ended by the host (grace counts as ended) and not past its expiry. */
export function isOpenRoom(room: SiriRoom, nowMs: number): boolean {
  const end = Date.parse(room.expires_at);
  return room.deleted_at === null && Number.isFinite(end) && end > nowMs;
}

/**
 * The room Siri asks about: the room I opened last if it is still open, else the newest open room, else null.
 */
export function activeRoomId(rooms: readonly SiriRoom[], lastOpened: string | null, nowMs: number): string | null {
  const open = rooms.filter((r) => isOpenRoom(r, nowMs));
  if (lastOpened && open.some((r) => r.id === lastOpened)) return lastOpened;
  let best: SiriRoom | null = null;
  for (const r of open) if (!best || Date.parse(r.created_at) > Date.parse(best.created_at)) best = r;
  return best?.id ?? null;
}

/** The earliest expiry among open rooms after `nowMs`, when the active room may change on its own; else null. */
export function nextRoomChangeMs(rooms: readonly SiriRoom[], nowMs: number): number | null {
  let next: number | null = null;
  for (const r of rooms) {
    if (!isOpenRoom(r, nowMs)) continue;
    const end = Date.parse(r.expires_at);
    if (next === null || end < next) next = end;
  }
  return next;
}

/**
 * The JSON stored for Siri, or null when there is nothing to store (signed out, or no usable access token).
 * Only the access token and its expiry (unix seconds) are copied from the session.
 */
export function siriMirrorValue(
  session: { access_token?: string; expires_at?: number } | null | undefined,
  roomId: string | null,
  supabaseUrl: string,
  anonKey: string,
): string | null {
  const token = session?.access_token;
  const exp = session?.expires_at;
  if (typeof token !== 'string' || !token || typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return JSON.stringify({ v: 1, accessToken: token, expiresAt: exp, roomId: roomId ?? null, supabaseUrl, anonKey });
}

/** The room id a stored value names, so a restart keeps it until the Rooms list is read again. */
export function storedRoomId(value: string | null): string | null {
  if (!value) return null;
  try {
    const d = JSON.parse(value) as { roomId?: unknown };
    return typeof d.roomId === 'string' && d.roomId ? d.roomId : null;
  } catch {
    return null;
  }
}
