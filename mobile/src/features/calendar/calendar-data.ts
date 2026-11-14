/**
 * Qrewing Calendar data on the phone only (human: "폰에만 저장"). One versioned AsyncStorage key per user holds
 * room snapshots and personal events; the Plus preview flag has its own key. Pure: storage is passed in.
 */
import { type CalItem, type DateKey, daysBetween, isDateKey, roomRange } from './calendar-plan';

export const CALENDAR_VERSION = 1;
export const calendarKey = (uid: string) => `qrew.calendar.v${CALENDAR_VERSION}.${uid}`;
export const plusPreviewKey = (uid: string) => `qrew.plusPreview.v1.${uid}`;

export const EVENT_TITLE_MAX = 60;
export const EVENT_SPAN_MAX = 366;
export const DIARY_LINES = 3;

export type RoomSnapshot = {
  roomId: string;
  name: string;
  type: string;
  start: DateKey;
  end: DateKey;
  /** The end instant (ISO); past rooms open the diary card. */
  endAt: string;
  emoji: string;
  /** First-person recap lines, saved once the recap arrives; null when generation failed. */
  diary?: string[] | null;
};

export type PersonalEvent = { id: string; title: string; start: DateKey; end: DateKey; emoji: string };

export type CalendarDoc = { version: 1; rooms: Record<string, RoomSnapshot>; events: PersonalEvent[] };

export const emptyDoc = (): CalendarDoc => ({ version: 1, rooms: {}, events: [] });

/** Emoji before the AI picks one (recap), by room type. */
export function defaultEmoji(type: string): string {
  return ({ sports: '🏃', event: '🎉', waiting: '⏳', general: '💬' } as Record<string, string>)[type] ?? '📌';
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function parseRoom(v: unknown): RoomSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const roomId = str(r.roomId, 64);
  const name = str(r.name, 120);
  const emoji = str(r.emoji, 16);
  if (!roomId || !name || !emoji || !isDateKey(r.start) || !isDateKey(r.end) || typeof r.endAt !== 'string') return null;
  const diary = Array.isArray(r.diary) ? cleanDiary(r.diary) : r.diary === null ? null : undefined;
  return { roomId, name, type: typeof r.type === 'string' ? r.type : 'general', start: r.start, end: r.end, endAt: r.endAt, emoji, diary };
}

function parseEvent(v: unknown): PersonalEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  const id = str(e.id, 64);
  const title = str(e.title, EVENT_TITLE_MAX);
  const emoji = str(e.emoji, 16);
  if (!id || !title || !emoji || !isDateKey(e.start) || !isDateKey(e.end) || e.end < e.start) return null;
  return { id, title, start: e.start, end: e.end, emoji };
}

/** A stored value back into a doc; anything unreadable or of another version starts empty. */
export function parseDoc(raw: string | null): CalendarDoc {
  if (!raw) return emptyDoc();
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v?.version !== CALENDAR_VERSION) return emptyDoc();
    const doc = emptyDoc();
    for (const r of Object.values((v.rooms as Record<string, unknown>) ?? {})) {
      const p = parseRoom(r);
      if (p) doc.rooms[p.roomId] = p;
    }
    for (const e of Array.isArray(v.events) ? v.events : []) {
      const p = parseEvent(e);
      if (p) doc.events.push(p);
    }
    return doc;
  } catch {
    return emptyDoc();
  }
}

export function cleanDiary(lines: unknown[]): string[] {
  return lines
    .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    .slice(0, DIARY_LINES)
    .map((l) => l.trim().slice(0, 90));
}

type RoomLike = {
  id: string;
  name: string;
  type: string;
  starts_at: string | null;
  created_at: string;
  expires_at: string;
  deleted_at?: string | null;
};

/** Snapshot every listed room (current and future, plus grace); keeps an emoji and diary already saved. */
export function mergeRooms(doc: CalendarDoc, rooms: readonly RoomLike[], timeZone?: string): CalendarDoc {
  const next: CalendarDoc = { ...doc, rooms: { ...doc.rooms } };
  for (const room of rooms) {
    const { start, end } = roomRange(room, timeZone);
    const prev = doc.rooms[room.id];
    const endAt =
      room.deleted_at && Date.parse(room.deleted_at) < Date.parse(room.expires_at) ? room.deleted_at : room.expires_at;
    next.rooms[room.id] = {
      roomId: room.id,
      name: room.name,
      type: room.type,
      start,
      end,
      endAt,
      emoji: prev?.emoji ?? defaultEmoji(room.type),
      diary: prev?.diary,
    };
  }
  return next;
}

/** The recap's emoji and diary (developer's diary:true extension). A room never snapshotted gets one from `room`. */
export function applyRecap(
  doc: CalendarDoc,
  roomId: string,
  recap: { emoji?: unknown; diary?: unknown },
  room?: RoomLike,
  timeZone?: string,
): CalendarDoc {
  const base = doc.rooms[roomId] ? doc : room ? mergeRooms(doc, [room], timeZone) : null;
  if (!base) return doc;
  const prev = base.rooms[roomId];
  const good = Array.isArray(recap.diary) && cleanDiary(recap.diary).length > 0;
  // Past the server's diary cap (or a failed diary) the body has diary null and the type's fallback emoji, so a
  // saved good diary and its emoji are kept; null only marks "no diary yet" and is asked again next time.
  if (!good && Array.isArray(prev.diary) && prev.diary.length > 0) return base;
  const emoji = str(recap.emoji, 16) ?? prev.emoji;
  const diary = good ? cleanDiary(recap.diary as unknown[]) : null;
  return { ...base, rooms: { ...base.rooms, [roomId]: { ...prev, emoji, diary } } };
}

export type EventInput = { title: string; start: DateKey; end: DateKey; emoji: string };
export type EventProblem = 'title' | 'dates' | 'order' | 'span' | 'emoji';

export function checkEvent(e: EventInput): EventProblem | null {
  if (!e.title.trim()) return 'title';
  if (!isDateKey(e.start) || !isDateKey(e.end)) return 'dates';
  if (e.end < e.start) return 'order';
  if (daysBetween(e.start, e.end) > EVENT_SPAN_MAX) return 'span';
  if (!e.emoji.trim()) return 'emoji';
  return null;
}

export function upsertEvent(doc: CalendarDoc, id: string, e: EventInput): CalendarDoc {
  const ev: PersonalEvent = { id, title: e.title.trim().slice(0, EVENT_TITLE_MAX), start: e.start, end: e.end, emoji: e.emoji.trim() };
  const exists = doc.events.some((x) => x.id === id);
  return { ...doc, events: exists ? doc.events.map((x) => (x.id === id ? ev : x)) : [...doc.events, ev] };
}

export function deleteEvent(doc: CalendarDoc, id: string): CalendarDoc {
  return { ...doc, events: doc.events.filter((x) => x.id !== id) };
}

/** Everything the grid draws. Room ids and event ids live in separate namespaces. */
export function calendarItems(doc: CalendarDoc): CalItem[] {
  return [
    ...Object.values(doc.rooms).map((r) => ({ id: `room:${r.roomId}`, kind: 'room' as const, title: r.name, start: r.start, end: r.end, emoji: r.emoji })),
    ...doc.events.map((e) => ({ id: `event:${e.id}`, kind: 'event' as const, title: e.title, start: e.start, end: e.end, emoji: e.emoji })),
  ];
}

/**
 * A queued write for `uid` runs only while that user is signed in: after SIGNED_OUT cleared the keys, a late
 * recap or rooms sync must not write them back. Before the first auth event (`authKnown` false) writes pass.
 */
export function mayWrite(uid: string, currentUid: string | null, authKnown: boolean): boolean {
  return !authKnown || uid === currentUid;
}

/** Sign-out and account deletion: both of the user's keys go. */
export async function clearUserCalendar(storage: { multiRemove(keys: string[]): Promise<void> }, uid: string) {
  await storage.multiRemove([calendarKey(uid), plusPreviewKey(uid)]);
}

/** qrewing calendar_add 200 body → an event input, or null when the shape is off. */
export function parseCalendarAdd(data: unknown): EventInput | null {
  const ev = (data as { event?: Record<string, unknown> } | null)?.event;
  if (!ev) return null;
  const input = {
    title: typeof ev.title === 'string' ? ev.title.trim().slice(0, EVENT_TITLE_MAX) : '',
    start: ev.start as string,
    end: ev.end as string,
    emoji: typeof ev.emoji === 'string' ? ev.emoji : '',
  };
  return checkEvent(input) ? null : input;
}

/** Calendar tiers (human FINAL 2026-11-13 PM): Free and Plus both get the calendar; only signing in is required. */
export function calendarGate(signedIn: boolean): 'signedOut' | 'calendar' {
  return signedIn ? 'calendar' : 'signedOut';
}
