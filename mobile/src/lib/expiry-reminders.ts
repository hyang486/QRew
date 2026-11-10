// Local and in-app 24-hour expiry reminder (APP_CONCEPT_KO "방 만료 1일 전 알림").
//
// This milestone has no remote push (no paid Apple account; USER_DECISIONS notifications), so:
// - each device schedules a LOCAL notification when the in-room banner starts (expires_at - 24 h, or
//   G6b: - 1 h for rooms under 24 h; expiry-plan endsSoonWindowMs) for the rooms it can open, and
//   reschedules when the host changes the expiry (rooms change notice -> room reload -> sync);
// - while the room is open, the server's reminder broadcast (migration 0019) is shown in the app.
// A device that never opens the app after the room is created or the expiry changes cannot get a
// reminder this way; that needs real push and is not claimed here.
import * as Notifications from 'expo-notifications';

import { en } from '@/i18n/en';

import {
  isReminderData,
  showEndsSoon,
  planReminders,
  type ReminderData,
  type ReminderRoom,
  reminderId,
  REMINDER_ID_PREFIX,
  REMINDER_WINDOW_MS,
} from './expiry-plan';
import { formatRemaining } from './rooms';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** G6b: the reminder fires in the room's last hour (a room under 24 h), not 24 h before. */
function lastHour(room: ReminderRoom, fireAt: number) {
  return new Date(room.expires_at).getTime() - fireAt < REMINDER_WINDOW_MS;
}

function dataFor(room: ReminderRoom, fireAt?: number): ReminderData {
  return { kind: 'expiry', roomId: room.id, expiryVersion: room.expiry_version, expiresAt: room.expires_at, fireAt };
}

/** Asks once (iOS shows its own prompt). Returns whether local notifications may be shown. */
async function ensurePermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Brings the scheduled local reminders in line with `rooms`. `complete` means `rooms` is every room
 * the user can still open (home list); a single room screen passes false.
 */
export async function syncExpiryReminders(rooms: ReminderRoom[], complete: boolean) {
  try {
    const scheduled = (await Notifications.getAllScheduledNotificationsAsync()).map((n) => ({
      identifier: n.identifier,
      data: n.content.data as Partial<ReminderData> | null,
    }));
    const plan = planReminders(rooms, scheduled, Date.now(), complete);
    await Promise.all(plan.cancel.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
    if (plan.schedule.length === 0 || !(await ensurePermission())) return;
    await Promise.all(
      plan.schedule.map(({ identifier, room, fireAt }) =>
        Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: lastHour(room, fireAt) ? en.reminder.titleLastHour : en.reminder.title,
            body: lastHour(room, fireAt) ? en.reminder.bodyLastHour(room.name) : en.reminder.body(room.name),
            data: dataFor(room, fireAt),
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
        }),
      ),
    );
  } catch (e) {
    // A reminder is best effort; it must never break loading a room.
    console.warn('[expiry-reminder] sync failed', e);
  }
}

export async function cancelExpiryReminder(roomId: string) {
  try {
    await Notifications.cancelScheduledNotificationAsync(reminderId(roomId));
  } catch (e) {
    console.warn('[expiry-reminder] cancel failed', e);
  }
}

/** On sign-out: another account may use this device next. */
export async function cancelAllExpiryReminders() {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      all
        .filter((n) => n.identifier.startsWith(REMINDER_ID_PREFIX))
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
    );
  } catch (e) {
    console.warn('[expiry-reminder] cancel all failed', e);
  }
}

const shown = new Set<string>();

/**
 * The server recorded reminders for this room (broadcast {table: 'expiry_reminders', expiry_version}).
 * Shows it once if this user has a reminder row for that version and the device has not already
 * shown one for it. The copy uses the real remaining time, since a room created with less than
 * 24 hours left gets its reminder on the first server run.
 */
export async function presentServerReminder(room: ReminderRoom, expiryVersion: number | undefined) {
  if (expiryVersion !== room.expiry_version) return;
  // G6b: only inside the banner window. Rows written by 0019 before 0025 (a short room reminded at creation)
  // would otherwise still alert while the banner is hidden.
  if (!showEndsSoon(room.created_at, room.expires_at, Date.now())) return;
  const key = `${room.id}:${expiryVersion}`;
  if (shown.has(key)) return;
  try {
    const { data, error } = await supabase
      .from('expiry_reminders')
      .select('room_id')
      .eq('room_id', room.id)
      .eq('expiry_version', expiryVersion)
      .maybeSingle();
    if (error || !data) return;

    const presented = await Notifications.getPresentedNotificationsAsync();
    const already = presented.some((n) => {
      const d = n.request.content.data;
      return isReminderData(d) && d.roomId === room.id && d.expiryVersion === expiryVersion;
    });
    shown.add(key);
    if (already || !(await ensurePermission())) return;

    const remaining = formatRemaining(new Date(room.expires_at).getTime() - Date.now());
    await Notifications.scheduleNotificationAsync({
      identifier: reminderId(room.id),
      content: {
        title: en.room.reminderTitle,
        body: en.room.reminderBody(room.name, remaining),
        data: dataFor(room),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[expiry-reminder] present failed', e);
  }
}

// A reminder tapped before the user had a session: held in memory and opened once signed in,
// like pending-invite.
let pendingRoomId: string | null = null;

/** The room id from a tapped expiry reminder, or null for anything else. */
export function reminderRoomFromResponse(response: Notifications.NotificationResponse | null | undefined) {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const data = response.notification.request.content.data;
  return isReminderData(data) ? data.roomId : null;
}

export function setPendingReminderRoom(roomId: string) {
  pendingRoomId = roomId;
}

export function takePendingReminderRoom() {
  const id = pendingRoomId;
  pendingRoomId = null;
  return id;
}
