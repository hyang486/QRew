/**
 * Qrewing Calendar storage (phone only): the per-user calendar doc and the Plus preview flag in AsyncStorage,
 * with an in-memory copy and listeners so every screen sees one state. Writes are serialized per key.
 * Both keys are removed when the user signs out or the account is deleted (both end in SIGNED_OUT).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { supabase } from '@/lib/supabase';

import {
  applyRecap,
  type CalendarDoc,
  calendarKey,
  clearUserCalendar,
  deleteEvent,
  emptyDoc,
  mayWrite,
  type EventInput,
  mergeRooms,
  parseDoc,
  plusPreviewKey,
  upsertEvent,
} from './calendar-data';

// Who is signed in, from auth events (update() and setPlusPreview() skip writes for anyone else).
let currentUid: string | null = null;
let authKnown = false;
const docs = new Map<string, CalendarDoc>();
const plus = new Map<string, boolean>();
const listeners = new Set<() => void>();
let chain: Promise<unknown> = Promise.resolve();

function emit() {
  for (const l of listeners) l();
}

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

async function loadDoc(uid: string): Promise<CalendarDoc> {
  const hit = docs.get(uid);
  if (hit) return hit;
  let doc = emptyDoc();
  try {
    doc = parseDoc(await AsyncStorage.getItem(calendarKey(uid)));
  } catch {}
  if (!docs.has(uid)) docs.set(uid, doc);
  return docs.get(uid)!;
}

/** Read, change and write the user's doc in order; failures keep the in-memory copy (never block the app). */
function update(uid: string, change: (doc: CalendarDoc) => CalendarDoc): Promise<void> {
  return serial(async () => {
    if (!mayWrite(uid, currentUid, authKnown)) return;
    const next = change(await loadDoc(uid));
    docs.set(uid, next);
    emit();
    try {
      await AsyncStorage.setItem(calendarKey(uid), JSON.stringify(next));
    } catch {}
  });
}

export function syncCalendarRooms(uid: string | null | undefined, rooms: Parameters<typeof mergeRooms>[1]) {
  if (!uid || rooms.length === 0) return;
  void update(uid, (doc) => mergeRooms(doc, rooms));
}

export function saveRecapToCalendar(uid: string, roomId: string, recap: { emoji?: unknown; diary?: unknown }) {
  return update(uid, (doc) => applyRecap(doc, roomId, recap));
}

/** True while this room has no good diary saved, so the recap call asks for one (Plus preview only; capped server-side). */
export async function wantsDiary(uid: string, roomId: string): Promise<boolean> {
  if (!(await loadPlus(uid))) return false;
  const room = (await loadDoc(uid)).rooms[roomId];
  return !room || !Array.isArray(room.diary) || room.diary.length === 0;
}

export const saveEvent = (uid: string, id: string, e: EventInput) => update(uid, (doc) => upsertEvent(doc, id, e));
export const removeEvent = (uid: string, id: string) => update(uid, (doc) => deleteEvent(doc, id));

/**
 * Store reads go through useSyncExternalStore: the React Compiler caches plain render reads of module state on
 * the hook's inputs (uid), which kept a stale null after the first load (2026-11-13 stuck spinner).
 */
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCalendar(uid: string | null | undefined): CalendarDoc | null {
  useEffect(() => {
    if (uid && !docs.has(uid)) void loadDoc(uid).then(emit);
  }, [uid]);
  return useSyncExternalStore(subscribe, () => (uid ? (docs.get(uid) ?? null) : null));
}

async function loadPlus(uid: string): Promise<boolean> {
  if (plus.has(uid)) return plus.get(uid)!;
  let on = false;
  try {
    on = (await AsyncStorage.getItem(plusPreviewKey(uid))) === '1';
  } catch {}
  if (!plus.has(uid)) plus.set(uid, on);
  return plus.get(uid)!;
}

export async function setPlusPreview(uid: string, on: boolean) {
  if (!mayWrite(uid, currentUid, authKnown)) return;
  plus.set(uid, on);
  emit();
  try {
    if (on) await AsyncStorage.setItem(plusPreviewKey(uid), '1');
    else await AsyncStorage.removeItem(plusPreviewKey(uid));
  } catch {}
}

/** The Plus preview flag (null while loading). */
export function usePlusPreview(uid: string | null | undefined): boolean | null {
  useEffect(() => {
    if (uid && !plus.has(uid)) void loadPlus(uid).then(emit);
  }, [uid]);
  return useSyncExternalStore(subscribe, () => (uid ? (plus.get(uid) ?? null) : null));
}

// Sign-out and account deletion (deleteAccount and the account-gone check both end in signOut) emit SIGNED_OUT:
// remove that user's calendar and Plus preview keys. INITIAL_SESSION on subscribe tells us who is signed in.
supabase.auth.onAuthStateChange((event, session) => {
  authKnown = true;
  if (session?.user.id) currentUid = session.user.id;
  if (event !== 'SIGNED_OUT' || !currentUid) return;
  const uid = currentUid;
  currentUid = null;
  docs.delete(uid);
  plus.delete(uid);
  emit();
  void serial(() => clearUserCalendar(AsyncStorage, uid)).catch(() => {});
});
