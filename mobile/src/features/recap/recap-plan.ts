// Pure logic for the end-of-room recap (spec 3.3 and 7.3). No React Native imports, so `npm test` can load it.

export const RECAP_KEY_PREFIX = 'qrewing.recap.v1.';
/** Which recap calls this device already made for a room, and that the room had Qrewing AI on. */
export const RECAP_MARK_PREFIX = 'qrewing.recap-mark.v1.';

export const FIRST_CALL_MS = 60 * 60_000;
export const REFRESH_CALL_MS = 10 * 60_000;
/** The host's End flow waits at most this long for the recap, in the background (spec 3.3 trigger B). */
export const END_RECAP_TIMEOUT_MS = 15_000;

export function recapKey(roomId: string) {
  return `${RECAP_KEY_PREFIX}${roomId}`;
}
export function recapMarkKey(roomId: string) {
  return `${RECAP_MARK_PREFIX}${roomId}`;
}

export type ServerRecap = { title: string; summary: string; highlights: string[]; generatedAt: string };

/** The per-user part, computed on this device without AI. A null field could not be read. */
export type MyPart = {
  messages: number | null;
  mediaShared: number | null;
  photosOfMe: number | null;
  arrivedAt: string | null;
  pace: string | null;
};

export type SavedRecap = { server: ServerRecap; me: MyPart; savedAt: string };

export type RecapMark = { ai: true; first: boolean; refresh: boolean };

export type RecapStep = 'first' | 'refresh' | 'late';

/** What to mark and whether to send `refresh` for a step. */
export function stepCall(step: RecapStep): { mark: Partial<Pick<RecapMark, 'first' | 'refresh'>>; refresh: boolean } {
  if (step === 'first') return { mark: { first: true }, refresh: false };
  if (step === 'refresh') return { mark: { refresh: true }, refresh: true };
  return { mark: { first: true, refresh: true }, refresh: true };
}

export const EMPTY_MARK: RecapMark = { ai: true, first: false, refresh: false };

/**
 * Spec 7.3 scheduled end: the first time the app sees 60 minutes or less left, ask once; within the last
 * 10 minutes, ask once more with `refresh` (the server decides whether anything changed). Null: nothing to do.
 * First seen with 10 minutes or less left: 'late', one call with `refresh` that counts as both (the server treats a
 * refresh with no done row as a normal recap), so two calls never go out seconds apart.
 * After the end (remaining <= 0) the scheduled path stops; the host's early end has its own call.
 */
export function recapStep(remainingMs: number, mark: RecapMark): RecapStep | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  if (remainingMs <= REFRESH_CALL_MS && !mark.first && !mark.refresh) return 'late';
  if (remainingMs <= FIRST_CALL_MS && !mark.first) return 'first';
  if (remainingMs <= REFRESH_CALL_MS && !mark.refresh) return 'refresh';
  return null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Reads a stored recap; anything malformed reads as no recap. */
export function parseSavedRecap(raw: string | null | undefined): SavedRecap | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = o.server as Record<string, unknown> | undefined;
  if (!s || typeof s.title !== 'string' || typeof s.summary !== 'string' || !isStringArray(s.highlights)) return null;
  if (typeof o.savedAt !== 'string') return null;
  const m = (o.me ?? {}) as Record<string, unknown>;
  return {
    server: { title: s.title, summary: s.summary, highlights: s.highlights, generatedAt: strOrNull(s.generatedAt) ?? o.savedAt },
    me: {
      messages: numOrNull(m.messages),
      mediaShared: numOrNull(m.mediaShared),
      photosOfMe: numOrNull(m.photosOfMe),
      arrivedAt: strOrNull(m.arrivedAt),
      pace: strOrNull(m.pace),
    },
    savedAt: o.savedAt,
  };
}

export function parseMark(raw: string | null | undefined): RecapMark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v?.ai !== true) return null;
    return { ai: true, first: v.first === true, refresh: v.refresh === true };
  } catch {
    return null;
  }
}

/**
 * Keeps the better per-user part when a newer server recap arrives in grace: counts that can no longer be read
 * (messages are closed in grace) keep the earlier value.
 */
export function mergeMyPart(prev: MyPart | null | undefined, next: MyPart): MyPart {
  if (!prev) return next;
  return {
    messages: next.messages ?? prev.messages,
    mediaShared: next.mediaShared ?? prev.mediaShared,
    photosOfMe: next.photosOfMe ?? prev.photosOfMe,
    arrivedAt: next.arrivedAt ?? prev.arrivedAt,
    pace: next.pace ?? prev.pace,
  };
}

/**
 * Messages have no grace read policy (0027), so after the end the head count reads 0 with no error. The count is
 * kept only when the room was still open when read after it (rooms never reopen); otherwise it is unknown (null),
 * and mergeMyPart keeps the earlier value.
 */
export function myPartAfterRoomCheck(part: MyPart, openAfterCount: boolean): MyPart {
  return openAfterCount ? part : { ...part, messages: null };
}

/**
 * Qrewing Calendar (Plus preview): a recap saved through a path that did not send diary:true (room_recaps notice,
 * a done shared row read in grace, the ended-room ask) asks once for this member's emoji and diary. Background
 * only: never throws, one call per room at a time; the server caps it and answers 403 once the room is gone.
 */
export async function askDiaryOnce(
  roomId: string,
  deps: {
    wants: () => Promise<boolean>;
    request: () => Promise<{ state?: string; emoji?: unknown; diary?: unknown } | { error: unknown }>;
    save: (recap: { emoji: unknown; diary: unknown }) => Promise<unknown>;
  },
  inFlight: Set<string>,
): Promise<void> {
  if (inFlight.has(roomId)) return;
  inFlight.add(roomId);
  try {
    if (!(await deps.wants())) return;
    const res = await deps.request();
    if ('error' in res || res.state !== 'done' || !res.emoji) return;
    await deps.save({ emoji: res.emoji, diary: res.diary });
  } catch {
    // The recap is already shown; a missing diary leaves the calendar's no-diary line.
  } finally {
    inFlight.delete(roomId);
  }
}

/** Resolves with the promise's value, or `fallback` after `ms`. Never rejects. */
export function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F, setTimer = setTimeout): Promise<T | F> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimer(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(t as ReturnType<typeof setTimeout>);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(t as ReturnType<typeof setTimeout>);
        resolve(fallback);
      },
    );
  });
}

/**
 * What the Room ended recap card shows (spec 3.3, 7.3). `miss` is why the server read gave no recap: `pending`
 * (another member's call is writing it), `offline` (the request never got an answer) or `gone` (any other answer,
 * including the room deleted after grace). Rooms this phone does not know had Qrewing on show only a recap or
 * "still writing" (read in grace).
 */
export type RecapMiss = 'pending' | 'offline' | 'gone';
export type RecapCardView = 'recap' | 'hidden' | 'none' | 'pending' | 'offline';

export function recapCardView(hasSaved: boolean, markAi: boolean, miss: RecapMiss | null): RecapCardView {
  if (hasSaved) return 'recap';
  // Without the mark (the chat was never opened on this phone), only a row read in grace can say anything:
  // a recap being written shows "still writing"; no row (AI off) or a failed read shows nothing.
  if (!markAi) return miss === 'pending' ? 'pending' : 'hidden';
  if (miss === 'pending') return 'pending';
  if (miss === 'offline') return 'offline';
  return 'none';
}

/**
 * Why a recap request gave no recap. Only "no connection" can be retried; any server failure, including the 502
 * the server returns without a model call after its one retry per room (68132d6), is `gone` ("No recap was saved",
 * no Try again).
 */
export function recapMissForError(error: string): RecapMiss {
  return error === 'network' ? 'offline' : 'gone';
}

/** On SUBSCRIBED in grace: read again unless a recap is already saved, including while the first read runs (R2). */
export function rereadOnSubscribe(loaded: { saved: unknown } | null): boolean {
  return !loaded?.saved;
}

/** Server's pending TTL (supabase/functions/qrewing/core.ts RECAP_PENDING_TTL_MS on qrewing-backend 23e1423). */
export const RECAP_PENDING_TTL_MS = 5 * 60_000;

/**
 * A pending room_recaps row older than the server's TTL is stale: the writer died, and the server retakes it once,
 * but only when someone calls recap (review R3). Unparseable times count as not stale.
 */
export function isStalePending(updatedAt: string, nowMs: number): boolean {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && nowMs - t > RECAP_PENDING_TTL_MS;
}

/** The per-user part saved while the room is open (counts only, no AI), so grace can show the last open count. */
export const RECAP_ME_PREFIX = 'qrewing.recap-me.v1.';
export function recapMeKey(roomId: string) {
  return `${RECAP_ME_PREFIX}${roomId}`;
}
/** After a successful send, the message count is saved once this long after the last send. */
export const SEND_SAVE_DEBOUNCE_MS = 10_000;

export const EMPTY_MY_PART: MyPart = { messages: null, mediaShared: null, photosOfMe: null, arrivedAt: null, pace: null };

/** Reads a stored open-room part; anything malformed reads as none. */
export function parseMyPart(raw: string | null | undefined): MyPart | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (!m || typeof m !== 'object') return null;
    return {
      messages: numOrNull(m.messages),
      mediaShared: numOrNull(m.mediaShared),
      photosOfMe: numOrNull(m.photosOfMe),
      arrivedAt: strOrNull(m.arrivedAt),
      pace: strOrNull(m.pace),
    };
  } catch {
    return null;
  }
}

/** A successful send while open: one more message when the count is known (null stays null until a head count). */
export function bumpMessages(part: MyPart | null): MyPart | null {
  if (!part || part.messages === null) return part;
  return { ...part, messages: part.messages + 1 };
}

/**
 * The part saved with a server recap: fresh reads win, and a field that can no longer be read (messages in grace)
 * keeps the part saved while the room was open, then the one saved with an earlier recap. Works with no earlier
 * recap saved.
 */
export function myPartForSave(savedMe: MyPart | null | undefined, openMe: MyPart | null | undefined, fresh: MyPart): MyPart {
  return mergeMyPart(openMe ? mergeMyPart(savedMe, openMe) : savedMe, fresh);
}

const UNREAD_PART: MyPart = { messages: null, mediaShared: null, photosOfMe: null, arrivedAt: null, pace: null };

/**
 * UI v2 bug 6 (qa, 2026-11-13): the calendar diary was written at once, but the recap only after the network reads
 * of my part, so a read that hung or failed (app closed, room deleted) left a diary with "No recap was saved". The
 * recap is now written first with the part already on this phone, then again with the fresh reads. Never rejects
 * after the first write.
 */
export async function saveRecapInTwoSteps(
  server: ServerRecap,
  d: {
    savedMe: () => Promise<MyPart | null | undefined>;
    openMe: () => Promise<MyPart | null>;
    fresh: () => Promise<MyPart>;
    write: (saved: SavedRecap) => Promise<void>;
    now?: () => string;
  },
): Promise<SavedRecap> {
  const now = d.now ?? (() => new Date().toISOString());
  const savedMe = await d.savedMe().catch(() => null);
  const openMe = await d.openMe().catch(() => null);
  const first: SavedRecap = { server, me: myPartForSave(savedMe, openMe, UNREAD_PART), savedAt: now() };
  await d.write(first).catch(() => {});
  let fresh: MyPart;
  try {
    fresh = await d.fresh();
  } catch {
    return first;
  }
  const saved: SavedRecap = { server, me: myPartForSave(savedMe, openMe, fresh), savedAt: now() };
  await d.write(saved).catch(() => {});
  return saved;
}
