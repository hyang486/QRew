import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoomActivityBar } from '@/components/room-activity';
import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { type ChatItem, MAX_MESSAGE_LENGTH, useChat } from '@/lib/chat';
import { canSendDraft, composerAutoFocus, composerReducer, initialComposer } from '@/lib/composer';
import { errorMessage } from '@/lib/errors';
import { presentServerReminder, syncExpiryReminders } from '@/lib/expiry-reminders';
import { clearRoomCache, useRoomUploadSummary } from '@/lib/media';
import { useRoomEvents } from '@/lib/room-channel';
import { formatRemaining, getRoom, listMembers, REMINDER_WINDOW_MS, type Room } from '@/lib/rooms';
import { useHeaderOverlap } from '@/lib/use-header-overlap';
import { useNow } from '@/lib/use-now';

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; names: Map<string, string> };

export default function RoomScreen() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const now = useNow(15_000);
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const room = await getRoom(id);
      if (!room) {
        setState({ status: 'gone' });
        return;
      }
      const members = await listMembers(id);
      setState({ status: 'ready', room, names: new Map(members.map((m) => [m.user_id, m.display_name])) });
      // Reschedules the local reminder when the host changed the expiry (rooms notice -> reload).
      syncExpiryReminders([room], false);
    } catch (e) {
      setState((s) => (s.status === 'ready' ? s : { status: 'error', message: errorMessage(e) }));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Room settings (expiry, activity_seq) and membership changes: reload the room and member names.
  // expiry_reminders: the server recorded the 24-hour reminder for this room (migration 0019).
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') load();
    if (event.table === 'expiry_reminders' && state.status === 'ready') {
      presentServerReminder(state.room, event.expiry_version);
    }
  });

  // A new member's first message, or a join/leave notice: refresh names (and notice an ended room).
  const names = state.status === 'ready' ? state.names : undefined;
  const onNewSender = useCallback(
    (senderId: string) => {
      if (!senderId || !names?.has(senderId)) load();
    },
    [names, load],
  );

  // Ended, expired or left: drop this app's cached originals for the room.
  const isGone =
    state.status === 'gone' || (state.status === 'ready' && new Date(state.room.expires_at).getTime() <= now);
  useEffect(() => {
    if (isGone) clearRoomCache(id);
  }, [isGone, id]);

  if (state.status === 'loading') {
    return (
      <Screen>
        <ActivityIndicator style={styles.loading} />
      </Screen>
    );
  }

  const remainingMs = state.status === 'ready' ? new Date(state.room.expires_at).getTime() - now : 0;

  // RLS hides the room once it expires, ends or the user leaves; the clock covers the gap until a reload.
  if (state.status === 'gone' || (state.status === 'ready' && remainingMs <= 0)) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <View style={styles.gone}>
          <Text style={styles.goneTitle}>{en.room.gone}</Text>
          <Hint>{from === 'reminder' ? en.room.reminderGoneHint : en.room.goneHint}</Hint>
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

  return (
    <ChatRoom
      room={state.room}
      names={state.names}
      userId={userId}
      remainingMs={remainingMs}
      onNewSender={onNewSender}
      onSendFailed={load}
    />
  );
}

function ChatRoom({
  room,
  names,
  userId,
  remainingMs,
  onNewSender,
  onSendFailed,
}: {
  room: Room;
  names: Map<string, string>;
  userId: string | undefined;
  remainingMs: number;
  onNewSender: (senderId: string) => void;
  onSendFailed: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { rootRef, onLayout: measureRoot, top, overlap: headerOverlap } = useHeaderOverlap();
  const chat = useChat(room.id, userId, onNewSender);
  const uploadSummary = useRoomUploadSummary(room.id);
  const [composer, dispatchComposer] = useReducer(composerReducer, initialComposer);
  const draft = composer.draft;
  const remaining = formatRemaining(remainingMs);
  const canSend = canSendDraft(draft);

  function submit() {
    if (!canSend) return;
    chat.send(draft);
    // Remount the input instead of clearing it in place (C-2, see lib/composer.ts).
    dispatchComposer({ type: 'sent' });
  }

  const failedCount = chat.messages.filter((m) => m.pending === 'failed').length;
  // A failed send may mean the room ended or the user was removed; re-check the room when a send fails.
  useEffect(() => {
    if (failedCount > 0) onSendFailed();
  }, [failedCount, onSendFailed]);

  function onFailedPress(item: ChatItem) {
    Alert.alert(en.chat.failed, undefined, [
      { text: en.room.cancel, style: 'cancel' },
      { text: en.chat.discard, style: 'destructive', onPress: () => chat.discard(item.id) },
      { text: en.chat.retry, onPress: () => chat.retry(item.id) },
    ]);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: room.name,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Link
                href={{ pathname: '/room/[id]/gallery', params: { id: room.id } }}
                style={[styles.headerLink, uploadSummary.failed > 0 && { color: colors.danger }]}
                accessibilityRole="button"
                accessibilityLabel={en.media.headerLinkA11y(uploadSummary.pending, uploadSummary.failed)}
              >
                {uploadSummary.failed > 0
                  ? en.media.headerLinkFailed
                  : uploadSummary.pending > 0
                    ? en.media.headerLinkUploading(uploadSummary.pending)
                    : en.media.headerLink}
              </Link>
              {room.location_allowed || room.host_id === userId ? (
                <Link
                  href={{ pathname: '/room/[id]/map', params: { id: room.id } }}
                  style={styles.headerLink}
                  accessibilityRole="button"
                >
                  {en.map.headerLink}
                </Link>
              ) : null}
              <Link
                href={{ pathname: '/room/[id]/invite', params: { id: room.id } }}
                style={styles.headerLink}
                accessibilityRole="button"
              >
                {en.room.invite}
              </Link>
              <Link
                href={{ pathname: '/room/[id]/info', params: { id: room.id } }}
                style={styles.headerLink}
                accessibilityRole="button"
              >
                {en.room.info}
              </Link>
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={top}>
        <View
          ref={rootRef}
          onLayout={measureRoot}
          style={[styles.flex, { backgroundColor: colors.background, paddingTop: headerOverlap }]}
        >
          <View style={styles.strip}>
            <Text style={styles.remaining} accessibilityRole="header">
              {en.room.endsIn(remaining)}
            </Text>
            {!chat.live && !chat.loading ? <Text style={styles.offline}>{en.chat.reconnecting}</Text> : null}
          </View>
          {remainingMs < REMINDER_WINDOW_MS ? (
            <View style={styles.banner} accessibilityRole="alert">
              <Text style={styles.bannerTitle}>{en.room.reminderTitle}</Text>
              <Text style={styles.bannerBody}>{en.room.reminderBody(room.name, remaining)}</Text>
            </View>
          ) : null}
          <RoomActivityBar roomId={room.id} activitySeq={room.activity_seq} userId={userId} names={names} />

          {chat.loading ? (
            <ActivityIndicator style={styles.loading} />
          ) : chat.error && chat.messages.length === 0 ? (
            <View style={styles.center}>
              <Hint tone="error">{en.chat.loadError}</Hint>
              <Button title={en.home.retry} variant="secondary" onPress={chat.reload} />
            </View>
          ) : (
            <FlatList
              style={styles.flex}
              inverted
              data={chat.messages}
              keyExtractor={(m) => m.id}
              contentContainerStyle={styles.list}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onEndReached={chat.hasMore ? chat.loadOlder : undefined}
              onEndReachedThreshold={0.5}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <Hint>{en.chat.empty}</Hint>
                </View>
              }
              renderItem={({ item, index }) => (
                <MessageRow
                  item={item}
                  older={chat.messages[index + 1]}
                  mine={item.sender_id === userId}
                  name={item.sender_id ? (names.get(item.sender_id) ?? en.chat.formerMember) : ''}
                  onFailedPress={onFailedPress}
                />
              )}
            />
          )}

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <TextInput
              key={composer.key}
              autoFocus={composerAutoFocus(composer)}
              style={styles.input}
              value={draft}
              onChange={(e) => dispatchComposer({ type: 'change', key: composer.key, text: e.nativeEvent.text })}
              placeholder={en.chat.placeholder}
              placeholderTextColor={colors.secondaryLabel}
              accessibilityLabel={en.chat.placeholder}
              multiline
              maxLength={MAX_MESSAGE_LENGTH}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={en.chat.send}
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={submit}
              style={({ pressed }) => [styles.sendButton, (!canSend || pressed) && { opacity: 0.4 }]}
            >
              <Text style={styles.sendText}>{en.chat.send}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const NOTICE_KINDS = new Set(['system', 'arrival', 'status', 'emergency']);

function MessageRow({
  item,
  older,
  mine,
  name,
  onFailedPress,
}: {
  item: ChatItem;
  older: ChatItem | undefined;
  mine: boolean;
  name: string;
  onFailedPress: (item: ChatItem) => void;
}) {
  const time = useMemo(
    () => new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    [item.created_at],
  );

  if (NOTICE_KINDS.has(item.kind)) {
    const emergency = item.kind === 'emergency';
    return (
      <View style={styles.noticeRow} accessibilityRole={emergency ? 'alert' : 'text'}>
        <Text style={[styles.notice, emergency && styles.emergency]}>
          {item.body} · {time}
        </Text>
      </View>
    );
  }

  // Media messages render in checkpoint 5; until then show a plain placeholder text.
  const body = item.kind === 'media' ? '📎' : item.body;
  const showName = !mine && (older?.sender_id !== item.sender_id || NOTICE_KINDS.has(older?.kind ?? ''));

  const bubble = (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs, item.pending === 'failed' && styles.failedBubble]}>
      <Text selectable style={[styles.body, mine && styles.mineText]}>
        {body}
      </Text>
    </View>
  );

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
      {showName ? <Text style={styles.sender}>{name}</Text> : null}
      {item.pending === 'failed' ? (
        <Pressable accessibilityRole="button" accessibilityHint={en.chat.failed} onPress={() => onFailedPress(item)}>
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
      <Text style={[styles.meta, item.pending === 'failed' && styles.failedMeta]}>
        {item.pending === 'sending' ? en.chat.sending : item.pending === 'failed' ? en.chat.failed : time}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 48 },
  center: { padding: 20, gap: 12 },
  headerActions: { flexDirection: 'row', gap: 4 },
  headerLink: { fontSize: 17, color: colors.tint, paddingHorizontal: 6 },
  strip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  remaining: { fontSize: 15, fontWeight: '600', color: colors.label, fontVariant: ['tabular-nums'] },
  offline: { fontSize: 13, color: colors.warning },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.field,
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    borderRadius: 12,
    borderCurve: 'continuous',
    padding: 12,
    gap: 4,
  },
  bannerTitle: { fontSize: 15, fontWeight: '600', color: colors.label },
  bannerBody: { fontSize: 14, color: colors.label },
  list: { paddingHorizontal: 12, paddingVertical: 8, gap: 2, flexGrow: 1 },
  // The list is inverted, so the empty state is flipped back.
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', transform: [{ scaleY: -1 }] },
  row: { marginVertical: 2, maxWidth: '80%' },
  rowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  sender: { fontSize: 12, color: colors.secondaryLabel, marginTop: 6, marginBottom: 2, marginLeft: 12 },
  bubble: { borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 14, paddingVertical: 8 },
  mine: { backgroundColor: colors.tint },
  theirs: { backgroundColor: colors.field },
  failedBubble: { opacity: 0.6 },
  body: { fontSize: 17, color: colors.label },
  mineText: { color: 'white' },
  meta: { fontSize: 11, color: colors.secondaryLabel, marginTop: 2, marginHorizontal: 8 },
  failedMeta: { color: colors.danger },
  noticeRow: { alignSelf: 'center', marginVertical: 6, paddingHorizontal: 16 },
  notice: { fontSize: 13, color: colors.secondaryLabel, textAlign: 'center' },
  emergency: { color: colors.danger, fontWeight: '700' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 36,
    backgroundColor: colors.field,
    color: colors.label,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 17,
  },
  sendButton: { height: 36, justifyContent: 'center', paddingHorizontal: 8 },
  sendText: { fontSize: 17, fontWeight: '600', color: colors.tint },
  gone: { paddingVertical: 48, alignItems: 'center', gap: 8 },
  goneTitle: { fontSize: 20, fontWeight: '600', color: colors.label },
});
