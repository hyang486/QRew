import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { QScreen } from '@/components/q-screen';
import { Button, colors } from '@/components/ui';
import { en } from '@/i18n/en';
import { type EndedRoomFields, roomClosedAtMs, sameLocalDay } from '@/lib/room-ended';

/**
 * Qrew unit 5 (Q 06.04): one "This room has ended" screen for every room screen that finds the room closed.
 * "<Room> closed at <time>." only when the time is known (the loaded row's end time; never guessed once the row
 * is gone). `reminder`: opened from the expiry reminder, which also says the server copies were deleted.
 * "Back to rooms" returns to the rooms list as before (dismissTo '/').
 */
export function RoomEnded({
  room,
  nowMs,
  reminder,
}: {
  room?: (EndedRoomFields & { name: string }) | null;
  /** Needed to read a passed expires_at; without it only the host's end time (deleted_at) can show. */
  nowMs?: number;
  reminder?: boolean;
}) {
  const router = useRouter();
  const closedMs = roomClosedAtMs(room, nowMs ?? 0);
  let closedLine: string | undefined;
  if (room && closedMs !== null) {
    const time = new Date(closedMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const when = sameLocalDay(closedMs, nowMs ?? closedMs)
      ? time
      : `${new Date(closedMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
    closedLine = en.room.closedAt(room.name, when);
  }
  return (
    <QScreen
      title={en.room.endedTitle}
      subtitle={closedLine}
      bottom={<InkArt art="ended" width={200} />}
      bottomAlign="center"
      actions={<Button title={en.room.backToRooms} onPress={() => router.dismissTo('/')} />}
    >
      {reminder ? <Text style={styles.line}>{en.room.reminderGoneHint}</Text> : null}
      {!reminder ? <Text style={styles.line}>{en.room.savedStay}</Text> : null}
      {!reminder && closedMs === null ? <Text style={styles.line}>{en.room.goneHint}</Text> : null}
    </QScreen>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: 15, lineHeight: 21, color: colors.secondaryLabel },
});
