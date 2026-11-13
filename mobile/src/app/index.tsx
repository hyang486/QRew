import { Link, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { placeTimeLine } from '@/components/place-time-cards';
import { QLabel, QScreen } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { syncExpiryReminders, takePendingReminderRoom } from '@/lib/expiry-reminders';
import { pruneRoomCaches } from '@/lib/media';
import { placeTimeOf } from '@/lib/place-time';
import { resumePendingInvite } from '@/lib/invite';
import { formatRemaining, listMyRooms, type Room } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';
import { purgeStaleAskHistories } from '@/features/event/ask-store';
import { syncSiriRooms } from '@/features/event/siri-mirror';
import { roomListEntry } from '@/features/recap/grace-plan';
import { graceTime } from '@/features/recap/use-grace';

export default function Rooms() {
  const router = useRouter();
  const { profile, isGuest } = useAuth();
  const now = useNow();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listMyRooms();
      setRooms(list);
      setError(null);
      // Drop cached originals of rooms that ended, expired or were left since the last visit.
      pruneRoomCaches(list.map((r) => r.id));
      // Spec 10.4: Ask Qrewing history goes once a room ended (grace counts as ended), expired or was left.
      void purgeStaleAskHistories(list.filter((r) => r.deleted_at === null).map((r) => r.id));
      syncSiriRooms(list);
      // Local 24-hour reminders for every open room; cancels those of rooms no longer listed. Rooms the host
      // ended (listed only during their grace window, spec 7) get no reminder.
      syncExpiryReminders(
        list.filter((r) => r.deleted_at === null),
        true,
      );
    } catch (e) {
      setError(`${en.home.loadFailed} ${errorMessage(e)}`);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // An invite chosen before sign-in (code, QR or link; item 10) opens here once, right after sign-in.
      if (resumePendingInvite((invite) => router.push({ pathname: '/preview', params: invite }))) return;
      // An expiry reminder tapped before sign-in: open its room (access is checked there).
      const reminderRoom = takePendingReminderRoom();
      if (reminderRoom) {
        router.push({ pathname: '/room/[id]', params: { id: reminderRoom, from: 'reminder' } });
        return;
      }
      load();
    }, [load, router]),
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/profile" style={styles.headerLink} accessibilityRole="button">
              {en.home.profile}
            </Link>
          ),
        }}
      />
      <QScreen
        title={en.home.title}
        subtitle={en.home.signedInAs(profile?.display_name ?? '…', isGuest ? en.profile.guest : en.profile.host)}
      >
        <Button title={en.home.join} onPress={() => router.push('/join')} />
        {isGuest ? (
          <Hint>{en.home.guestCreateHint}</Hint>
        ) : (
          <Button title={en.home.create} variant="secondary" onPress={() => router.push('/create-room')} />
        )}

        {error ? (
          <>
            <Hint tone="error">{error}</Hint>
            <Button title={en.home.retry} variant="secondary" onPress={load} />
          </>
        ) : null}

        {rooms === null && !error ? (
          <ActivityIndicator style={styles.loading} accessibilityLabel={en.home.loading} />
        ) : null}

        {rooms?.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{en.home.empty}</Text>
            <Hint>{isGuest ? en.home.emptyHintGuest : en.home.emptyHintHost}</Hint>
          </View>
        ) : null}

        {/* The label counts only rows that show: a grace row dropping out may leave none. */}
        {rooms && rooms.some((r) => roomListEntry(r, now).kind !== 'hidden') ? <QLabel>{en.home.yourRooms}</QLabel> : null}
        {rooms?.map((room) => {
          // Spec 7.3: a room the host ended stays listed during its grace window and opens Room ended (the
          // chat route shows it for a host-ended room); once grace ends the row drops out before the next read.
          const entry = roomListEntry(room, now);
          if (entry.kind === 'hidden') return null;
          return (
          <Pressable
            key={room.id}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/room/[id]', params: { id: room.id } })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          >
            {/* Theme mark: the room's ink art, small (Q 01.03). */}
            <View style={styles.mark}>
              <InkArt roomName={room.name} width={40} ground={colors.field} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {room.name}
              </Text>
              {entry.kind === 'grace' ? (
                <Text style={styles.rowSubtitle}>{en.qrewing.grace.listRow(graceTime(entry.untilMs))}</Text>
              ) : (
                <>
                  <Text style={styles.rowSubtitle}>
                    {en.rooms.types[room.type as keyof typeof en.rooms.types] ?? room.type} ·{' '}
                    {en.home.endsIn(formatRemaining(new Date(room.expires_at).getTime() - now))}
                  </Text>
                  {/* Place and time (0026), when set: one extra line; rooms without them look as before. */}
                  <PlaceTimeLine room={room} />
                </>
              )}
            </View>
          </Pressable>
          );
        })}
      </QScreen>
    </>
  );
}

function PlaceTimeLine({ room }: { room: Room }) {
  const placeTime = placeTimeOf(room);
  if (!placeTime) return null;
  return (
    <Text style={styles.rowSubtitle} numberOfLines={1}>
      {placeTimeLine(placeTime)}
    </Text>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 24 },
  empty: { paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.label },
  headerLink: { fontSize: 17, color: colors.tint, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  mark: { width: 44, alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '500', color: colors.label },
  rowSubtitle: { fontSize: 13, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
});
