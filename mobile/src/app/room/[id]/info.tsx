import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { StatusEditor } from '@/components/status-editor';
import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { clearRoomCache } from '@/lib/media';
import { useRoomEvents } from '@/lib/room-channel';
import { cancelExpiryReminder } from '@/lib/expiry-reminders';
import { endRoom, getRoom, leaveRoom, listMembers, type Room, type RoomMember } from '@/lib/rooms';

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; members: RoomMember[] };

/** Members, room details and Leave/End. Reached from the room chat header. */
export default function RoomInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const room = await getRoom(id);
      if (!room) {
        setState({ status: 'gone' });
        return;
      }
      setState({ status: 'ready', room, members: await listMembers(id) });
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e) });
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Live refresh while open: membership and room changes arrive as broadcast notices (0017).
  // Debounced so a burst of notices costs one reload.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);
  useRoomEvents(id, (event) => {
    if (event.table !== 'rooms' && event.table !== 'room_members') return;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, 300);
  });

  if (state.status === 'loading') {
    return (
      <Screen>
        <ActivityIndicator style={styles.loading} />
      </Screen>
    );
  }

  if (state.status === 'gone') {
    return (
      <Screen>
        <View style={styles.gone}>
          <Text style={styles.goneTitle}>{en.room.gone}</Text>
          <Hint>{en.room.goneHint}</Hint>
        </View>
        <Button title={en.room.backToRooms} onPress={() => router.dismissTo('/')} />
      </Screen>
    );
  }

  if (state.status === 'error') {
    return (
      <Screen>
        <Hint tone="error">{state.message}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </Screen>
    );
  }

  const { room, members } = state;
  const isHost = room.host_id === userId;

  function confirmLeave() {
    Alert.alert(
      isHost ? en.room.endConfirmTitle : en.room.leaveConfirmTitle,
      isHost ? en.room.endConfirmBody : en.room.leaveConfirmBody,
      [
        { text: en.room.cancel, style: 'cancel' },
        {
          text: isHost ? en.room.end : en.room.leave,
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await (isHost ? endRoom(room.id) : leaveRoom(room.id));
              cancelExpiryReminder(room.id);
              clearRoomCache(room.id);
              router.dismissTo('/');
            } catch (e) {
              setBusy(false);
              Alert.alert(errorMessage(e));
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.name} accessibilityRole="header">
          {room.name}
        </Text>
        <Hint>{en.room.endsAt(new Date(room.expires_at).toLocaleString())}</Hint>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{en.room.membersCount(members.length)}</Text>
        {members.map((m) => (
          <View key={m.user_id} style={styles.member}>
            <Avatar path={m.avatar_path} name={m.display_name} />
            <Text style={styles.memberName} numberOfLines={1}>
              {m.display_name}
            </Text>
            <Text style={styles.memberTag}>
              {[m.role === 'host' ? en.room.host : null, m.user_id === userId ? en.room.you : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        ))}
      </View>

      <StatusEditor roomId={room.id} isHost={isHost} />

      <Button
        title={isHost ? en.room.end : en.room.leave}
        variant="destructive"
        busy={busy}
        onPress={confirmLeave}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  header: { gap: 4 },
  name: { fontSize: 22, fontWeight: '700', color: colors.label },
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  member: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  memberName: { flex: 1, fontSize: 17, color: colors.label },
  memberTag: { fontSize: 14, color: colors.secondaryLabel },
  gone: { paddingVertical: 48, alignItems: 'center', gap: 8 },
  goneTitle: { fontSize: 20, fontWeight: '600', color: colors.label },
});
