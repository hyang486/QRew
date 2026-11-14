// Pure logic for the Qrewing AI client (no React Native imports, so node --test can load it).
import type { MatchResult, QrewingError, QrewingMemberRow, QrewingRoomRow } from './types';

const KNOWN: readonly QrewingError[] = [
  'ai_not_configured',
  'ai_off',
  'not_member',
  'not_muted',
  'no_entry',
  'too_early',
  'not_consented',
  'ask_limit',
  'unclear',
  'rate_limited',
  'ai_failed',
  'network',
];

/**
 * Maps a failed `qrewing` call to a contract error. `status` 0 means the request never got an HTTP answer.
 * A known `error` code in the body wins; otherwise the status decides (spec section 2, common order).
 */
export function classifyQrewingError(status: number, bodyError?: unknown): QrewingError {
  if (typeof bodyError === 'string' && (KNOWN as readonly string[]).includes(bodyError)) return bodyError as QrewingError;
  if (status === 0) return 'network';
  // The function always names ai_not_configured in its 503 body, so a bare 503 is a gateway failure.
  if (status === 401 || status === 403) return 'not_member';
  return 'ai_failed';
}

export function isQrewingError<T extends object>(value: T | { error: QrewingError }): value is { error: QrewingError } {
  return 'error' in value && typeof (value as { error?: unknown }).error === 'string';
}

const OFFLINE_NAMES = new Set(['TypeError', 'AbortError', 'TimeoutError', 'FetchError', 'FunctionsFetchError']);
const OFFLINE_MESSAGE = /^(TypeError|AbortError|TimeoutError|FetchError): |network request failed|failed to fetch|network connection was lost|internet connection appears to be offline/i;

/**
 * True only when the request itself never got an answer (offline, timeout, aborted): a thrown fetch error
 * (`TypeError: Network request failed`, `AbortError`, `FunctionsFetchError`) or a supabase-js error built from
 * one (its message starts with the fetch error's name). Anything that came back from a server, including a
 * gateway 5xx or a non-JSON body (supabase-js also leaves `code` empty for those) and a FunctionsRelayError, is a
 * server failure, not offline.
 */
export function isOfflineError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (typeof name === 'string' && OFFLINE_NAMES.has(name)) return true;
  return typeof message === 'string' && OFFLINE_MESSAGE.test(message);
}

/** Short text for a failed save or read in a Qrewing screen; never the raw server message. */
export function saveErrorKind(error: unknown): 'network' | 'failed' {
  return isOfflineError(error) ? 'network' : 'failed';
}

/**
 * A failed `functions.invoke('qrewing')`: `http` (FunctionsHttpError: read the status and body), `network` (the
 * request never got an answer) or `server` (FunctionsRelayError or anything else that did reach Supabase).
 */
export function invokeFailureKind(error: unknown): 'http' | 'network' | 'server' {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  if (name === 'FunctionsHttpError') return 'http';
  if (name === 'FunctionsRelayError') return 'server';
  return isOfflineError(error) ? 'network' : 'server';
}

/** Wait before the one re-ask after a 202 pending match answer (backend 68132d6). */
export const MATCH_RETRY_MS = 10_000;

export type MatchAnswer = MatchResult | { state: 'pending' } | { error: QrewingError };
export type MatchStep =
  | { show: 'list'; result: MatchResult; pending: boolean; error: QrewingError | null; retryInMs: number | null }
  | { show: 'pending'; retryInMs: number | null }
  | { show: 'error'; error: QrewingError };

/**
 * People to meet after one `match` answer. 202 pending (another call for my list is running): keep the last list
 * if there is one, else a pending line, and re-ask once after MATCH_RETRY_MS when this answer was not itself the
 * re-ask; never in a loop. 200 with stale:true is a normal list (the screen shows the stale hint, no error).
 */
export function matchStep(answer: MatchAnswer, last: MatchResult | null, isRetry: boolean): MatchStep {
  if ('error' in answer) {
    // A failed re-ask keeps the list it was updating, with a small error line (review R4).
    if (isRetry && last) return { show: 'list', result: last, pending: false, error: answer.error, retryInMs: null };
    return { show: 'error', error: answer.error };
  }
  if ('matches' in answer) return { show: 'list', result: answer, pending: false, error: null, retryInMs: null };
  const retryInMs = isRetry ? null : MATCH_RETRY_MS;
  return last ? { show: 'list', result: last, pending: true, error: null, retryInMs } : { show: 'pending', retryInMs };
}

export type QrewingRoomState = {
  aiEnabled: boolean;
  entryRequired: boolean;
  me: { aiOk: boolean; mute: boolean } | null;
  /** The last read failed (offline, gateway 5xx, RLS error...). The state then reads as AI off but is not known. */
  readFailed: boolean;
  /** A read has answered (false until the first read returns). */
  loaded: boolean;
};
export const ROOM_UNKNOWN: QrewingRoomState = { aiEnabled: false, entryRequired: false, me: null, readFailed: false, loaded: false };
const ROOM_OFF: QrewingRoomState = { ...ROOM_UNKNOWN, loaded: true };
export const ROOM_READ_FAILED: QrewingRoomState = { ...ROOM_OFF, readFailed: true };

/** A read kept with the room it answered for, so a different room never shows it (useQrewingRoom). */
export type KeyedRoomState = { roomId: string; state: QrewingRoomState };

/** The state to show for `roomId`: ROOM_UNKNOWN until a read for this room answers. */
export function roomStateFor(kept: KeyedRoomState | null, roomId: string): QrewingRoomState {
  return kept && kept.roomId === roomId ? kept.state : ROOM_UNKNOWN;
}

/** My user id from the locally stored session (auth.getSession() reads storage, so it also works offline). */
export function sessionUserId(res: { data: { session: { user: { id: string } } | null } } | null | undefined): string | undefined {
  return res?.data?.session?.user?.id;
}

// Table missing (0027 not applied yet): a known "Qrewing is not here", not a failed read, so rooms without the
// tables do not show "Could not load" or retry every 30 s.
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

/**
 * The room's Qrewing state from the qrewing_rooms and qrewing_members reads (review R1). Any error on the room
 * read is `readFailed` (not "off"), except a missing table; no row (no error) is off.
 */
export function roomStateFrom(
  room: { data: QrewingRoomRow | null; error: unknown },
  member: { data: QrewingMemberRow | null },
): QrewingRoomState {
  if (room.error) {
    const code = (room.error as { code?: unknown }).code;
    return typeof code === 'string' && MISSING_TABLE.has(code) ? ROOM_OFF : ROOM_READ_FAILED;
  }
  if (!room.data?.ai_enabled) return ROOM_OFF;
  const me = member.data ? { aiOk: member.data.ai_ok_at != null, mute: member.data.mute_small_talk } : null;
  return { aiEnabled: true, entryRequired: room.data.entry_required, me, readFailed: false, loaded: true };
}

/**
 * End-room copy (review R6): name the recap unless a read actually answered that Qrewing AI is off. Still loading
 * or a failed read keeps the recap wording.
 */
export function endCopyHasRecap(state: Pick<QrewingRoomState, 'aiEnabled' | 'readFailed' | 'loaded'>): boolean {
  return state.aiEnabled || !state.loaded || state.readFailed;
}

/**
 * Which Qrewing function calls a room state allows. An AI-off room, a room still loading, or a failed read makes
 * none: no probe, no triage, no recap. Triage also needs a passing probe, an event room, and my Agree plus Mute.
 */
export function allowedQrewingCalls(
  state: Pick<QrewingRoomState, 'aiEnabled' | 'me'>,
  probeOk: boolean,
  isEvent: boolean,
): { probe: boolean; triage: boolean; recap: boolean } {
  const on = state.aiEnabled;
  return { probe: on, triage: on && probeOk && isEvent && !!state.me?.aiOk && !!state.me?.mute, recap: on };
}
