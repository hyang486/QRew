import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { QScreen } from '@/components/q-screen';
import { Button, colors } from '@/components/ui';
import type { GraceRoomFields } from '@/features/recap/grace-plan';
import { SavedRecapCard } from '@/features/recap/recap-card';
import { graceTime, useGrace } from '@/features/recap/use-grace';
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
  room?: (EndedRoomFields & Pick<GraceRoomFields, 'grace_until'> & { name: string }) | null;
  /** Needed to read a passed expires_at; without it only the host's end time (deleted_at) can show. */
  nowMs?: number;
  reminder?: boolean;
}) {
  const router = useRouter();
  // Every room screen is under room/[id]; the saved recap (spec 3.3) is read from this phone by that id.
  const { id } = useLocalSearchParams<{ id?: string }>();
  const hasId = typeof id === 'string' && id.length > 0;
  // Spec 7.3: after the host's early end, the recap and photos stay for 30 minutes; the timer drops back to the
  // plain ended state when grace ends.
  const grace = useGrace(room);
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
      actions={
        <>
          {grace.grace && hasId ? (
            <>
              <Button
                title={g.photosOfMe}
                variant="secondary"
                onPress={() => router.push({ pathname: '/room/[id]/gallery', params: { id, filter: 'me' } })}
              />
              <Button
                title={g.photosAndFiles}
                variant="secondary"
                onPress={() => router.push({ pathname: '/room/[id]/gallery', params: { id } })}
              />
            </>
          ) : null}
          <Button title={en.room.backToRooms} onPress={() => router.dismissTo('/')} />
        </>
      }
    >
      {grace.grace && grace.untilMs !== null ? (
        <>
          <Text style={styles.until}>{g.availableUntil(graceTime(grace.untilMs))}</Text>
          <Text style={styles.line}>{g.closedNote}</Text>
        </>
      ) : null}
      {/* E4: a stale reminder can open a room still in grace, where nothing is deleted yet. */}
      {reminder && !grace.grace ? <Text style={styles.line}>{en.room.reminderGoneHint}</Text> : null}
      {!reminder && !grace.grace ? <Text style={styles.line}>{en.room.savedStay}</Text> : null}
      {!reminder && closedMs === null ? <Text style={styles.line}>{en.room.goneHint}</Text> : null}
      {hasId ? <SavedRecapCard roomId={id} grace={grace.grace} /> : null}
    </QScreen>
  );
}

const g = en.qrewing.grace;

const styles = StyleSheet.create({
  until: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.label },
  line: { fontSize: 15, lineHeight: 21, color: colors.secondaryLabel },
});
