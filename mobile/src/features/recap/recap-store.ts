// Recap fetch and on-device save (spec 3.3): `{ server recap, per-user part, savedAt }` under
// `qrewing.recap.v1.<roomId>`, so the Room ended screen can show it after the server deleted the room.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { requestRecap } from '@/features/event/qrewing-api';
import { isOfflineError } from '@/features/event/qrewing-plan';
import { getActivitySummary, paceRecapLine } from '@/features/pace/summary';
import { roomPhase } from '@/features/recap/grace-plan';
import type { RoomRecapRow } from '@/features/event/types';
import { loadFaceData } from '@/lib/face';
import { supabase } from '@/lib/supabase';

import {
  EMPTY_MARK,
  END_RECAP_TIMEOUT_MS,
  bumpMessages,
  EMPTY_MY_PART,
  mergeMyPart,
  myPartAfterRoomCheck,
  myPartForSave,
  type MyPart,
  parseMark,
  parseMyPart,
  parseSavedRecap,
  type RecapMark,
  recapKey,
  recapMarkKey,
  recapMeKey,
  isStalePending,
  type RecapMiss,
  recapMissForError,
  type SavedRecap,
  type ServerRecap,
  withTimeout,
} from './recap-plan';


export async function loadSavedRecap(roomId: string): Promise<SavedRecap | null> {
  try {
    return parseSavedRecap(await AsyncStorage.getItem(recapKey(roomId)));
  } catch {
    return null;
  }
}

export async function loadMark(roomId: string): Promise<RecapMark | null> {
  try {
    return parseMark(await AsyncStorage.getItem(recapMarkKey(roomId)));
  } catch {
    return null;
  }
}

/** Remembers that this room had Qrewing AI on (so Room ended can say "No recap was saved") and which calls ran. */
export async function saveMark(roomId: string, patch: Partial<Omit<RecapMark, 'ai'>>): Promise<RecapMark> {
  const next: RecapMark = { ...((await loadMark(roomId)) ?? EMPTY_MARK), ...patch, ai: true };
  try {
    await AsyncStorage.setItem(recapMarkKey(roomId), JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the calls may repeat once, which the server answers from its cache.
  }
  return next;
}

async function countOrNull(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await q;
    return error ? null : count;
  } catch {
    return null;
  }
}

/** The per-user part (no AI). Each field is read on its own; one that fails (or is closed in grace) is null. */
export async function readMyPart(roomId: string, userId: string): Promise<MyPart> {
  const [messages, mediaShared, photosOfMe, arrivedAt] = await Promise.all([
    countOrNull(
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .eq('sender_id', userId)
        .eq('kind', 'text'),
    ),
    countOrNull(
      supabase.from('media').select('id', { count: 'exact', head: true }).eq('room_id', roomId).eq('uploader_id', userId),
    ),
    loadFaceData(roomId, userId)
      .then((d) => (d.enrollment ? d.matches.filter((m) => m.matched && !m.excluded).length : null))
      .catch(() => null),
    Promise.resolve(
      supabase
        .from('arrivals')
        .select('arrived_at')
        .eq('room_id', roomId)
        .eq('user_id', userId)
        .order('arrived_at', { ascending: true })
        .limit(1),
    )
      .then(({ data }) => data?.[0]?.arrived_at ?? null)
      .catch(() => null),
  ]);
  // Pace summary (spec 3.3): counts the in-memory run too (pace 2ba6451) and never rejects.
  const pace = paceRecapLine(await getActivitySummary(roomId));
  return myPartAfterRoomCheck({ messages, mediaShared, photosOfMe, arrivedAt, pace }, await isRoomOpen(roomId));
}

/** Read after the counts: open now means open when they were read. Any failure reads as not open. */
async function isRoomOpen(roomId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('rooms').select('deleted_at, expires_at, grace_until').eq('id', roomId).maybeSingle();
    return !error && roomPhase(data, Date.now()) === 'open';
  } catch {
    return false;
  }
}

async function loadOpenMyPart(roomId: string): Promise<MyPart | null> {
  try {
    return parseMyPart(await AsyncStorage.getItem(recapMeKey(roomId)));
  } catch {
    return null;
  }
}

// Every read-modify-write of the open part runs in order, so quick sends do not lose increments.
let openPartQueue: Promise<void> = Promise.resolve();

function updateOpenMyPart(roomId: string, change: (prev: MyPart | null) => MyPart | null): Promise<void> {
  const run = openPartQueue.then(async () => {
    const next = change(await loadOpenMyPart(roomId));
    if (!next) return;
    try {
      await AsyncStorage.setItem(recapMeKey(roomId), JSON.stringify(next));
    } catch {
      // Not saved; the end-time read is the fallback.
    }
  });
  openPartQueue = run.catch(() => {});
  return openPartQueue;
}

function storeOpenMyPart(roomId: string, part: MyPart): Promise<void> {
  return updateOpenMyPart(roomId, (prev) => mergeMyPart(prev, part));
}

/** Right after a successful send: one more message in the saved open count, if known. Never rejects. */
export function bumpOpenMessages(roomId: string): Promise<void> {
  return updateOpenMyPart(roomId, bumpMessages);
}

/** While the room is open (room screen open): saves the per-user part, no AI call. Never rejects. */
export async function saveMyPartWhileOpen(roomId: string, userId: string): Promise<void> {
  try {
    await storeOpenMyPart(roomId, await readMyPart(roomId, userId));
  } catch {
    // Silent: the next save or the end-time read covers it.
  }
}

/** After a send: one head count of my text messages, kept only if the room is still open after it. Never rejects. */
export async function saveMessageCountWhileOpen(roomId: string, userId: string): Promise<void> {
  try {
    const messages = await countOrNull(
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .eq('sender_id', userId)
        .eq('kind', 'text'),
    );
    const part = myPartAfterRoomCheck({ ...EMPTY_MY_PART, messages }, await isRoomOpen(roomId));
    if (part.messages !== null) await storeOpenMyPart(roomId, part);
  } catch {
    // Silent.
  }
}

async function save(roomId: string, userId: string, server: ServerRecap): Promise<SavedRecap> {
  const prev = await loadSavedRecap(roomId);
  const me = myPartForSave(prev?.me, await loadOpenMyPart(roomId), await readMyPart(roomId, userId));
  const saved: SavedRecap = { server, me, savedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(recapKey(roomId), JSON.stringify(saved));
  } catch {
    // Not saved on this device; the Room ended screen then says no recap was saved.
  }
  return saved;
}

/**
 * Asks the server for the recap and saves it when done. A pending answer (another member's call is writing it)
 * is left to the broadcast or the next read. Returns the saved recap, or null.
 */
export async function fetchAndSaveRecap(roomId: string, userId: string, opts?: { refresh?: boolean }): Promise<SavedRecap | null> {
  const res = await requestRecap(roomId, opts);
  if ('error' in res || res.state !== 'done') return null;
  return save(roomId, userId, {
    title: res.title,
    summary: res.summary,
    highlights: res.highlights,
    generatedAt: res.generatedAt,
  });
}

/** Trigger C: after a `room_recaps` notice, read the row through RLS and save it when done. */
export async function readAndSaveRecap(roomId: string, userId: string): Promise<SavedRecap | null> {
  try {
    const { data } = await supabase.from('room_recaps').select('*').eq('room_id', roomId).maybeSingle<RoomRecapRow>();
    if (!data || data.state !== 'done' || !data.title || !data.summary) return null;
    return save(roomId, userId, {
      title: data.title,
      summary: data.summary,
      highlights: data.highlights ?? [],
      generatedAt: data.updated_at,
    });
  } catch {
    return null;
  }
}

/**
 * Spec 7.3 early end: called by the host's End flow right after `end_room` succeeded (the room is in grace, so the
 * recap is allowed). Only for rooms this device knows had Qrewing on. Runs in the background with a 15 s limit;
 * it never blocks or delays leaving the End screen.
 */
export function recapAfterEnd(roomId: string, userId: string | undefined): void {
  if (!userId) return;
  loadMark(roomId)
    .then((mark) => {
      if (!mark?.ai) return null;
      return withTimeout(fetchAndSaveRecap(roomId, userId), END_RECAP_TIMEOUT_MS, null);
    })
    .catch(() => {});
}

/**
 * Room ended without a copy on this phone (spec 7.3 grace): read the shared row (RLS allows it in grace), then,
 * only when `ask` (this phone knows the room had Qrewing on), ask once. Says why there is no recap, so the card can
 * tell "still writing" and "offline" apart from "no recap was saved". Without `ask`, a missing row (AI off, or no
 * recap yet) is `gone`; the room_recaps notice re-runs this when the row arrives.
 */
export async function recapForEndedRoom(
  roomId: string,
  userId: string,
  opts: { ask: boolean },
): Promise<{ saved: SavedRecap } | { miss: RecapMiss }> {
  try {
    const { data, error } = await supabase.from('room_recaps').select('*').eq('room_id', roomId).maybeSingle<RoomRecapRow>();
    if (error) return { miss: isOfflineError(error) ? 'offline' : 'gone' };
    if (data?.state === 'done' && data.title && data.summary) {
      return {
        saved: await save(roomId, userId, {
          title: data.title,
          summary: data.summary,
          highlights: data.highlights ?? [],
          generatedAt: data.updated_at,
        }),
      };
    }
    // A stale pending row (writer gone) falls through to one recap call, which the server retakes (R3); the
    // answer is 200 done, 202 pending or 502 (gone, no Try again).
    if (data?.state === 'pending' && !isStalePending(data.updated_at, Date.now())) return { miss: 'pending' };
    if (data?.state === 'pending') return askRecap(roomId, userId);
  } catch (e) {
    return { miss: isOfflineError(e) ? 'offline' : 'gone' };
  }
  if (!opts.ask) return { miss: 'gone' };
  return askRecap(roomId, userId);
}

async function askRecap(roomId: string, userId: string): Promise<{ saved: SavedRecap } | { miss: RecapMiss }> {
  const res = await requestRecap(roomId);
  if ('error' in res) return { miss: recapMissForError(res.error) };
  if (res.state !== 'done') return { miss: 'pending' };
  return {
    saved: await save(roomId, userId, {
      title: res.title,
      summary: res.summary,
      highlights: res.highlights,
      generatedAt: res.generatedAt,
    }),
  };
}
