// Pure planning for the local expiry reminder (24 h before the end; G6b: 1 h for rooms under 24 h) (APP_CONCEPT_KO "방 만료 1일 전 알림").
// No React Native imports, so `npm test` can run it under plain Node.

export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMINDER_ID_PREFIX = 'expiry-';

/** Running-crew #9 (human decision 2026-11-07): rooms shorter than 24 h show the in-room banner only in the last hour. */
export const SHORT_ROOM_BANNER_MS = 60 * 60 * 1000;
// A "1 day" room is created with expires_at = client now + 24 h, and created_at is the later server time, so its
// length can come out a little under 24 h. Rooms within this margin of 24 h still count as 24 h rooms.
const SHORT_ROOM_MARGIN_MS = 10 * 60 * 1000;

/** How long before the end the in-room "Room ends soon" banner shows: 1 h for rooms under 24 h, else 24 h. */
export function endsSoonWindowMs(createdAt: string, expiresAt: string) {
  const length = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
  if (Number.isFinite(length) && length < REMINDER_WINDOW_MS - SHORT_ROOM_MARGIN_MS) return SHORT_ROOM_BANNER_MS;
  return REMINDER_WINDOW_MS;
}

/** Whether the in-room "Room ends soon" banner shows now (the room is still open and inside its window). */
export function showEndsSoon(createdAt: string, expiresAt: string, nowMs: number) {
  const remaining = new Date(expiresAt).getTime() - nowMs;
  return remaining > 0 && remaining < endsSoonWindowMs(createdAt, expiresAt);
}

export type ReminderRoom = { id: string; name: string; created_at: string; expires_at: string; expiry_version: number };

/** What the app stores in a scheduled reminder's `data`. */
export type ReminderData = {
  kind: 'expiry';
  roomId: string;
  expiryVersion: number;
  expiresAt: string;
  /** G6b: when it fires (ms). Reminders scheduled before G6b lack it and are rescheduled once. */
  fireAt?: number;
};

export type ScheduledReminder = { identifier: string; data: Partial<ReminderData> | null | undefined };

export type ReminderPlan = {
  schedule: { identifier: string; room: ReminderRoom; fireAt: number }[];
  cancel: string[];
};

export function reminderId(roomId: string) {
  return `${REMINDER_ID_PREFIX}${roomId}`;
}

export function isReminderData(data: unknown): data is ReminderData {
  const d = data as Partial<ReminderData> | null;
  return !!d && d.kind === 'expiry' && typeof d.roomId === 'string' && typeof d.expiryVersion === 'number';
}

/**
 * Decides which local reminders to (re)schedule or cancel.
 * - One reminder per room, identified by `reminderId(room.id)`, when the in-room banner starts
 *   (G6b: expires_at - endsSoonWindowMs, so 1 h before the end for rooms under 24 h, else 24 h).
 * - A reminder that already matches the room's expiry version and time is left alone.
 * - A changed expiry replaces the old reminder; one whose time has passed is cancelled
 *   (the in-room banner covers that last stretch).
 * - `complete`: `rooms` is every room the user can still open, so reminders for other rooms
 *   (left, ended, expired) are cancelled.
 */
export function planReminders(
  rooms: ReminderRoom[],
  scheduled: ScheduledReminder[],
  nowMs: number,
  complete: boolean,
): ReminderPlan {
  const existing = new Map(
    scheduled.filter((s) => s.identifier.startsWith(REMINDER_ID_PREFIX)).map((s) => [s.identifier, s]),
  );
  const plan: ReminderPlan = { schedule: [], cancel: [] };
  const seen = new Set<string>();

  for (const room of rooms) {
    const identifier = reminderId(room.id);
    seen.add(identifier);
    const expiresMs = new Date(room.expires_at).getTime();
    const fireAt = expiresMs - endsSoonWindowMs(room.created_at, room.expires_at);
    const current = existing.get(identifier);

    if (!Number.isFinite(expiresMs) || fireAt <= nowMs) {
      if (current) plan.cancel.push(identifier);
      continue;
    }
    const same =
      current?.data?.expiryVersion === room.expiry_version &&
      current.data.expiresAt !== undefined &&
      new Date(current.data.expiresAt).getTime() === expiresMs &&
      current.data.fireAt === fireAt;
    if (!same) plan.schedule.push({ identifier, room, fireAt });
  }

  if (complete) {
    for (const identifier of existing.keys()) if (!seen.has(identifier)) plan.cancel.push(identifier);
  }
  return plan;
}

/** Q 06.03: the "Room closes in N min" card on Photos & files shows in the last hour of every room. */
export const CLOSES_SOON_MS = SHORT_ROOM_BANNER_MS;

/**
 * Q 06.03: whole minutes left (rounded up, at least 1) while the room closes within CLOSES_SOON_MS, so the
 * card never says "0 min" while the room is still open; null before that window, after the end, or for a bad date.
 */
export function closesSoonMinutes(expiresAt: string, nowMs: number): number | null {
  const remaining = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > CLOSES_SOON_MS) return null;
  return Math.max(1, Math.ceil(remaining / 60_000));
}
