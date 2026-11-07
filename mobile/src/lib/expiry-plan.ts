// Pure planning for the local 24-hour expiry reminder (APP_CONCEPT_KO "방 만료 1일 전 알림").
// No React Native imports, so `npm test` can run it under plain Node.

export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMINDER_ID_PREFIX = 'expiry-';

export type ReminderRoom = { id: string; name: string; expires_at: string; expiry_version: number };

/** What the app stores in a scheduled reminder's `data`. */
export type ReminderData = { kind: 'expiry'; roomId: string; expiryVersion: number; expiresAt: string };

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
 * - One reminder per room, at expires_at - 24h, identified by `reminderId(room.id)`.
 * - A reminder that already matches the room's expiry version and time is left alone.
 * - A changed expiry replaces the old reminder; one whose time has passed is cancelled
 *   (the in-room banner covers the last 24 hours).
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
    const fireAt = expiresMs - REMINDER_WINDOW_MS;
    const current = existing.get(identifier);

    if (!Number.isFinite(expiresMs) || fireAt <= nowMs) {
      if (current) plan.cancel.push(identifier);
      continue;
    }
    const same =
      current?.data?.expiryVersion === room.expiry_version &&
      current.data.expiresAt !== undefined &&
      new Date(current.data.expiresAt).getTime() === expiresMs;
    if (!same) plan.schedule.push({ identifier, room, fireAt });
  }

  if (complete) {
    for (const identifier of existing.keys()) if (!seen.has(identifier)) plan.cancel.push(identifier);
  }
  return plan;
}
