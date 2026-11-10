// Pure helpers for the Qrew unit 4 confirm screens (Q 03.04 End activity; End room). No React Native imports,
// so `npm test` can load them.

/** The room fields the confirm screens decide on. */
export type EndRoomFields = {
  host_id: string;
  deleted_at: string | null;
  expires_at: string;
  activity_state: string;
};

/**
 * What a confirm screen shows. 'gone': the room is closed (ended, expired or not readable). 'not-host': only the
 * host may end (the RPCs check the same, private.is_room_host). 'not-running': End activity when no activity runs
 * (it was ended elsewhere meanwhile). 'ready': show the End button.
 */
export type EndGate = 'gone' | 'not-host' | 'not-running' | 'ready';

export function endGate(
  kind: 'activity' | 'room',
  room: EndRoomFields | null,
  userId: string | undefined,
  nowMs: number,
): EndGate {
  if (!room || room.deleted_at !== null || new Date(room.expires_at).getTime() <= nowMs) return 'gone';
  if (!userId || room.host_id !== userId) return 'not-host';
  if (kind === 'activity' && room.activity_state !== 'active') return 'not-running';
  return 'ready';
}

/** Single-flight state for an End action: a second tap while running or after success does nothing. */
export type RunState = { current: 'idle' | 'running' | 'done' };

/**
 * Runs `action` only from 'idle'. Returns true when this call ran it and it succeeded; false when it was skipped.
 * On failure the state returns to 'idle' (so the user can retry) and the error is rethrown for the screen to show.
 */
export async function runOnce(state: RunState, action: () => Promise<void>): Promise<boolean> {
  if (state.current !== 'idle') return false;
  state.current = 'running';
  try {
    await action();
    state.current = 'done';
    return true;
  } catch (e) {
    state.current = 'idle';
    throw e;
  }
}
