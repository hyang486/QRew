// Shared client API for Qrewing AI (planning/QREWING_AI_SPEC_EN.md section 3.1). Shapes mirror section 2.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

import {
  classifyQrewingError,
  invokeFailureKind,
  isOfflineError,
  type QrewingRoomState,
  ROOM_READ_FAILED,
  type KeyedRoomState,
  roomStateFor,
  roomStateFrom,
  saveErrorKind,
  sessionUserId,
} from './qrewing-plan';
import {
  type EntryAnswers,
  type EntryQuestion,
  type EntryQuestionsError,
  entryQuestionsErrorKind,
  parseQuestions,
  type QuestionPayload,
} from './entry-questions';
import { askBody, askErrorKind, type AskError, type AskMe, type AskTurn, parseAskAnswer } from './ask-plan';
import type { MatchResult, QrewingError, RecapResult, TriageResult } from './types';

export type { MatchResult, QrewingError, RecapResult, TriageResult } from './types';
export { isQrewingError } from './qrewing-plan';


export type Invoke<T> = { data: T } | { error: QrewingError };

async function invokeQrewing<T>(body: Record<string, unknown>): Promise<Invoke<T>> {
  try {
    const { data, error } = await supabase.functions.invoke('qrewing', { body });
    if (!error) return { data: data as T };
    const kind = error instanceof FunctionsHttpError ? 'http' : invokeFailureKind(error);
    if (kind === 'http') {
      const res = error.context as Response;
      const json = await res.json().catch(() => null);
      return { error: classifyQrewingError(res.status, json?.error) };
    }
    // A relay error or other answer from Supabase is a server failure, not "No connection".
    return { error: kind === 'network' ? 'network' : 'ai_failed' };
  } catch (e) {
    return { error: isOfflineError(e) ? 'network' : 'ai_failed' };
  }
}

/** Spec 10.3 `ask` (private chat). `invoke` is replaceable for the fake API and tests. */
export async function askQrewing(
  roomId: string,
  question: string,
  history: readonly AskTurn[],
  me?: AskMe | null,
  invoke: (body: Record<string, unknown>) => Promise<Invoke<unknown>> = invokeQrewing,
  anchor?: { lat: number; lng: number },
): Promise<{ answer: string } | { error: AskError }> {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    tz = undefined;
  }
  const res = await invoke(askBody(roomId, question, history, me, tz, anchor));
  if ('error' in res) return { error: askErrorKind(res.error) };
  const ok = parseAskAnswer(res.data);
  return ok ? { answer: ok.answer } : { error: 'ai_failed' };
}

export async function probeQrewing(roomId: string): Promise<{ ok: true } | { error: QrewingError }> {
  const res = await invokeQrewing<{ ok: true }>({ action: 'probe', roomId });
  return 'error' in res ? res : { ok: true };
}

export async function triageMessages(roomId: string, messageIds: string[]): Promise<TriageResult[] | { error: QrewingError }> {
  const res = await invokeQrewing<{ results: TriageResult[] }>({ action: 'triage', roomId, messageIds: messageIds.slice(0, 5) });
  if ('error' in res) return res;
  return Array.isArray(res.data?.results) ? res.data.results : { error: 'ai_failed' };
}

/** `refresh` (spec 7.2): one cheap update with newer messages; the server returns the cached row otherwise. */
export async function requestRecap(
  roomId: string,
  opts?: { refresh?: boolean; diary?: boolean },
): Promise<RecapResult | { state: 'pending' } | { error: QrewingError }> {
  const res = await invokeQrewing<RecapResult | { state: 'pending' }>({
    action: 'recap',
    roomId,
    ...(opts?.refresh ? { refresh: true } : {}),
    ...(opts?.diary ? { diary: true } : {}),
  });
  if ('error' in res) return res;
  if (res.data?.state === 'done' || res.data?.state === 'pending') return res.data;
  return { error: 'ai_failed' };
}

/** Qrewing Calendar: natural language → one personal event (dates only). 422 'unclear' when it can't tell. */
export async function calendarAdd(text: string, today: string, tz: string): Promise<{ data: unknown } | { error: QrewingError }> {
  const res = await invokeQrewing<unknown>({ action: 'calendar_add', text: text.trim().slice(0, 300), today, tz });
  return 'error' in res ? res : { data: res.data };
}

/** 200 list (maybe cached/stale), or 202 `{ state: 'pending' }` while another call for my list runs (68132d6). */
export async function requestMatches(roomId: string): Promise<MatchResult | { state: 'pending' } | { error: QrewingError }> {
  const res = await invokeQrewing<MatchResult | { state: 'pending' }>({ action: 'match', roomId });
  if ('error' in res) return res;
  if (res.data && 'state' in res.data && res.data.state === 'pending') return { state: 'pending' };
  return res.data && 'matches' in res.data && Array.isArray(res.data.matches) ? res.data : { error: 'ai_failed' };
}

export async function setQrewingRoom(roomId: string, aiEnabled: boolean, entryRequired: boolean): Promise<{ error?: string; offline?: boolean }> {
  const { error } = await supabase.rpc('set_qrewing_room', {
    p_room_id: roomId,
    p_ai_enabled: aiEnabled,
    p_entry_required: entryRequired,
  });
  return error ? { error: error.message, offline: saveErrorKind(error) === 'network' } : {};
}

export async function setQrewingMember(roomId: string, aiOk: boolean, mute: boolean): Promise<{ error?: string; offline?: boolean }> {
  const { error } = await supabase.rpc('set_qrewing_member', { p_room_id: roomId, p_ai_ok: aiOk, p_mute: mute });
  if (error) return { error: error.message, offline: saveErrorKind(error) === 'network' };
  memberChanged(roomId);
  return {};
}

// Every mounted useQrewingRoom of a room re-reads after my consent/mute row changes anywhere (e.g. the chat's
// disclosure sheet), so another reader such as the Ask Qrewing button never keeps a stale `aiOk`.
const memberListeners = new Set<(roomId: string) => void>();
function memberChanged(roomId: string) {
  for (const l of memberListeners) l(roomId);
}

// --- host-defined entry questions (spec 9.2 contract, migration 0028) -----------------------------------------------
// 0028 is not in database.types.ts yet, so these calls go through an untyped view of the client. Regenerate the
// types after 0028 is applied and drop the cast.
type Untyped = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: string): { order(col: string): PromiseLike<{ data: unknown; error: unknown }> };
    };
  };
};
const untyped = () => supabase as unknown as Untyped;

type EntryWrite = { ok: true } | { error: EntryQuestionsError };

function entryWriteResult(error: { code?: string; message: string } | null): EntryWrite {
  return error ? { error: entryQuestionsErrorKind(error.code, saveErrorKind(error) === 'network') } : { ok: true };
}

/** Replaces the room's whole question list (host only; 55000 once anyone has answered). */
export async function setEntryQuestions(roomId: string, questions: QuestionPayload[]): Promise<EntryWrite> {
  try {
    const { error } = await untyped().rpc('set_entry_questions', { p_room_id: roomId, p_questions: questions });
    return entryWriteResult(error);
  } catch (e) {
    return { error: saveErrorKind(e) === 'network' ? 'network' : 'failed' };
  }
}

/** Writes my answers (question id -> string or links array); the server derives headline and links. */
export async function saveEntryAnswers(roomId: string, answers: EntryAnswers): Promise<EntryWrite> {
  try {
    const { error } = await untyped().rpc('upsert_entry_answers', { p_room_id: roomId, p_answers: answers });
    return entryWriteResult(error);
  } catch (e) {
    return { error: saveErrorKind(e) === 'network' ? 'network' : 'failed' };
  }
}

export async function getEntryQuestions(roomId: string): Promise<EntryQuestion[]> {
  const { data, error } = await untyped()
    .from('entry_questions')
    .select('id, position, kind, prompt, required')
    .eq('room_id', roomId)
    .order('position');
  if (error) throw error;
  return parseQuestions(data);
}

/** The room's questions in position order. `failed` when the read failed; `loaded` false until it answers. */
export function useEntryQuestions(roomId: string): {
  questions: EntryQuestion[];
  loaded: boolean;
  failed: boolean;
  reload(): void;
} {
  const [kept, setKept] = useState<{ roomId: string; questions: EntryQuestion[]; failed: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    if (!roomId) return;
    getEntryQuestions(roomId)
      .then((questions) => alive && setKept({ roomId, questions, failed: false }))
      .catch(() => alive && setKept({ roomId, questions: [], failed: true }));
    return () => {
      alive = false;
    };
  }, [roomId, tick]);
  const mine = kept?.roomId === roomId ? kept : null;
  return { questions: mine?.questions ?? [], loaded: !!mine, failed: mine?.failed ?? false, reload };
}

type RoomState = QrewingRoomState;

/**
 * The room's Qrewing switches and my own consent/mute row (roomStateFrom). Any failed room read is `readFailed`
 * (no AI UI shows, settings screens say they could not load, chat retries); a missing row or missing table is off.
 * `loaded` is false until the first read answers; an empty `roomId` never reads.
 */
export function useQrewingRoom(roomId: string): RoomState & { reload(): void } {
  const [kept, setKept] = useState<KeyedRoomState | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const onChange = (changed: string) => {
      if (changed === roomId) reload();
    };
    memberListeners.add(onChange);
    return () => {
      memberListeners.delete(onChange);
    };
  }, [roomId, reload]);

  useEffect(() => {
    let alive = true;
    if (!roomId) return;
    (async () => {
      const userId = sessionUserId(await supabase.auth.getSession());
      const [room, member] = await Promise.all([
        supabase.from('qrewing_rooms').select('*').eq('room_id', roomId).maybeSingle(),
        userId
          ? supabase.from('qrewing_members').select('*').eq('room_id', roomId).eq('user_id', userId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (alive) setKept({ roomId, state: roomStateFrom(room, member) });
    })().catch(() => {
      if (alive) setKept({ roomId, state: ROOM_READ_FAILED });
    });
    return () => {
      alive = false;
    };
  }, [roomId, tick]);

  return { ...roomStateFor(kept, roomId), reload };
}
