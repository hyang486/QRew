import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { RoomEmergencyBanner } from '@/components/room-activity';
import { PlaceTimeCards } from '@/components/place-time-cards';
import { RoomEnded } from '@/components/room-ended';
import { StatusEditor } from '@/components/status-editor';
import { QLink, QScreen } from '@/components/q-screen';
import { QRowCard } from '@/components/q-row-card';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { endsDay } from '@/lib/chat-plan';
import { errorMessage } from '@/lib/errors';
import { clearRoomCache } from '@/lib/media';
import { useRoomEvents } from '@/lib/room-channel';
import { cancelExpiryReminder } from '@/lib/expiry-reminders';
import { arrivedMemberCount } from '@/lib/info-plan';
import { placeTimeOf } from '@/lib/place-time';
import { getRoom, leaveRoom, listArrivedIds, listMembers, type Room, type RoomMember } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';
import { useRoomOver } from '@/lib/use-room-over';

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; members: RoomMember[]; arrived: string[] | null };

/**
 * Members, room details and Leave/End. Reached from the room chat header. Qrew unit 5 (Q 03.03): title and cards;
 * members under View participants, status editing under Edit status options (host), and the red End room (host)
 * or Leave room (guest) text button at the bottom.
 */
export default function RoomInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [editingStatus, setEditingStatus] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    try {
      const room = await getRoom(id);
      if (!room) {
        setState({ status: 'gone' });
        return;
      }
      // Arrivals are extra: when they cannot be read, Info shows only the people count.
      const [members, arrived] = await Promise.all([
        listMembers(id),
        listArrivedIds(id, room.activity_seq).catch(() => null),
      ]);
      setState({ status: 'ready', room, members, arrived });
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
    if (event.table !== 'rooms' && event.table !== 'room_members' && event.table !== 'arrivals') return;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, 300);
  });

  // G-U6-1: the room's end time passing while Info is open (the host's End arrives as a rooms notice above).
  const ended = useRoomOver(state.status === 'ready' ? state.room : null);

  if (state.status === 'loading') {
    return (
      <QScreen>
        <ActivityIndicator style={styles.loading} />
      </QScreen>
    );
  }

  if (state.status === 'gone') {
    return <RoomEnded />;
  }
  // No stale member list, status editing or Leave/End once the room is over.
  if (state.status === 'ready' && ended.over) {
    return <RoomEnded room={state.room} nowMs={ended.nowMs ?? now} />;
  }

  if (state.status === 'error') {
    return (
      <QScreen actions={<Button title={en.home.retry} variant="secondary" onPress={load} />}>
        <Hint tone="error">{state.message}</Hint>
      </QScreen>
    );
  }

  const { room, members, arrived } = state;
  const isHost = room.host_id === userId;
  const placeTime = placeTimeOf(room);

  function confirmLeave() {
    // Qrew unit 4: the host's End room is a confirm screen that states the effects; guests keep the Leave alert.
    if (isHost) {
      router.push({ pathname: '/room/[id]/end-room', params: { id: room.id } });
      return;
    }
    Alert.alert(en.room.leaveConfirmTitle, en.room.leaveConfirmBody, [
      { text: en.room.cancel, style: 'cancel' },
      {
        text: en.room.leave,
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await leaveRoom(room.id);
            cancelExpiryReminder(room.id);
            clearRoomCache(room.id);
            router.dismissTo('/');
          } catch (e) {
            setBusy(false);
            Alert.alert(errorMessage(e));
          }
        },
      },
    ]);
  }

  const expiresMs = new Date(room.expires_at).getTime();
  const endsLine = en.room.endsOn(
    endsDay(expiresMs, now),
    new Date(expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    new Date(expiresMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  );
  // Q 03.03 "12 people · 8 arrived · View participants": arrivals of the current activity, current members only.
  const arrivedCount = arrived === null ? null : arrivedMemberCount(members.map((m) => m.user_id), arrived);
  const peopleSub = [
    arrivedCount === null ? null : en.room.arrived(arrivedCount),
    showMembers ? en.room.hideParticipants : en.room.viewParticipants,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <QScreen
      title={room.name}
      subtitle={en.room.infoSubtitle(isHost)}
      actions={
        <>
          {isHost ? (
            <Button
              title={editingStatus ? en.room.doneEditingStatus : en.room.editStatusOptions}
              variant="secondary"
              onPress={() => setEditingStatus((v) => !v)}
            />
          ) : null}
          {busy ? (
            <ActivityIndicator style={styles.leaveBusy} accessibilityLabel={en.room.leave} />
          ) : (
            <QLink title={isHost ? en.room.end : en.room.leave} tone="danger" onPress={confirmLeave} />
          )}
        </>
      }
    >
      <RoomEmergencyBanner roomId={room.id} />
      <QRowCard
        icon="person.2"
        title={en.room.people(members.length)}
        subtitle={peopleSub}
        onPress={() => setShowMembers((v) => !v)}
        expanded={showMembers}
      />
      {showMembers ? (
        <View style={styles.members}>
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
      ) : null}
      <QRowCard icon="clock" title={endsLine} subtitle={en.room.endsSoonInfo} />
      {/* Place and time (0026), only when the host set them: map, place + Open in Maps, start time. */}
      {placeTime ? <PlaceTimeCards placeTime={placeTime} /> : null}

      <View style={styles.statuses}>
        <StatusEditor roomId={room.id} isHost={isHost} editing={editingStatus} />
      </View>
    </QScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  leaveBusy: { minHeight: 40 },
  members: { gap: 6 },
  member: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  memberName: { flex: 1, fontSize: 17, color: colors.label },
  memberTag: { fontSize: 14, color: colors.secondaryLabel },
  statuses: { marginTop: 12 },
});
