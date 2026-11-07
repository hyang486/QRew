import { Link, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { syncExpiryReminders, takePendingReminderRoom } from '@/lib/expiry-reminders';
import { pruneRoomCaches } from '@/lib/media';
import { takePendingInvite } from '@/lib/pending-invite';
import { formatRemaining, listMyRooms, type Room } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

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
      // Local 24-hour reminders for every open room; cancels those of rooms no longer listed.
      syncExpiryReminders(list, true);
    } catch (e) {
      setError(`${en.home.loadFailed} ${errorMessage(e)}`);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      // An invite opened before sign-in resumes here once the user has a session.
      const token = takePendingInvite();
      if (token) {
        router.push({ pathname: '/preview', params: { token } });
        return;
      }
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
      <Screen>
        <Hint>
          {en.home.signedInAs(profile?.display_name ?? '…', isGuest ? en.profile.guest : en.profile.host)}
        </Hint>

        <View style={styles.actions}>
          <Button title={en.home.join} onPress={() => router.push('/join')} />
          {isGuest ? (
            <Hint>{en.home.guestCreateHint}</Hint>
          ) : (
            <Button title={en.home.create} variant="secondary" onPress={() => router.push('/create-room')} />
          )}
        </View>

        {error ? (
          <View style={styles.actions}>
            <Hint tone="error">{error}</Hint>
            <Button title={en.home.retry} variant="secondary" onPress={load} />
          </View>
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

        {rooms?.map((room) => (
          <Pressable
            key={room.id}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/room/[id]', params: { id: room.id } })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {room.name}
              </Text>
              <Text style={styles.rowSubtitle}>
                {en.rooms.types[room.type as keyof typeof en.rooms.types] ?? room.type} ·{' '}
                {en.home.endsIn(formatRemaining(new Date(room.expires_at).getTime() - now))}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 24 },
  actions: { gap: 12 },
  empty: { paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.label },
  headerLink: { fontSize: 17, color: colors.tint, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 17, fontWeight: '600', color: colors.label },
  rowSubtitle: { fontSize: 14, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 22, color: colors.secondaryLabel },
});
