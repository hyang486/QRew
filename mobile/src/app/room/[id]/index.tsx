import { type Href, Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { RoomActivityBar } from '@/components/room-activity';
import { RoomEnded } from '@/components/room-ended';
import { QREWING_FAB_CLEARANCE, QrewingFab } from '@/features/event/qrewing-fab';
import { Button, colors, Hint, radius, Screen } from '@/components/ui';
import { EntryGate, HiddenRow, ImportantBannerView, MuteBar, useQrewingChat } from '@/features/event/chat-layer';
import { DisclosureSheet } from '@/features/event/disclosure-sheet';
import { noteSiriRoomOpened } from '@/features/event/siri-mirror';
import { collapseSmallTalk, type MutedRow } from '@/features/event/event-plan';
import { useSmallTalk } from '@/features/event/use-small-talk';
import { useRecapTriggers } from '@/features/recap/use-recap-triggers';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { type ChatItem, MAX_MESSAGE_LENGTH, useChat } from '@/lib/chat';
import { endsDay } from '@/lib/chat-plan';
import { canSendDraft, composerAutoFocus, composerReducer, initialComposer } from '@/lib/composer';
import { errorMessage } from '@/lib/errors';
import { presentServerReminder, syncExpiryReminders } from '@/lib/expiry-reminders';
import { clearRoomCache, useRoomUploadSummary } from '@/lib/media';
import { useRoomEvents } from '@/lib/room-channel';
import { showEndsSoon } from '@/lib/expiry-plan';
import { getRoom, listMembers, type Room } from '@/lib/rooms';
import { useHeaderOverlap } from '@/lib/use-header-overlap';
import { useKeyboardOpen } from '@/lib/use-keyboard-open';
import { memberName } from '@/lib/member-name';
import { useNow } from '@/lib/use-now';

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; names: Map<string, string> };

export default function RoomScreen() {
  const { id, from, aiNote } = useLocalSearchParams<{ id: string; from?: string; aiNote?: string }>();
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
      // Spec 7.1: in the early-end grace window the room row is readable again but the room is closed; no
      // members list and no reminder, only the Room ended screen below.
      if (room.deleted_at !== null) {
        setState({ status: 'ready', room, names: new Map() });
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
  // Q 06.04: the shared ended screen; the closed-at time only when this row shows it (expires_at passed).
  // Spec 7.3: a host-ended room (deleted_at; readable only in grace) shows Room ended, whose grace state offers
  // the recap, Photos of me and Photos & files.
  if (state.status === 'gone' || (state.status === 'ready' && (remainingMs <= 0 || state.room.deleted_at !== null))) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerTitle: '' }} />
        <RoomEnded room={state.status === 'ready' ? state.room : null} nowMs={now} reminder={from === 'reminder'} />
      </>
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
      aiNote={aiNote === '1'}
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
  aiNote,
}: {
  room: Room;
  names: Map<string, string>;
  userId: string | undefined;
  remainingMs: number;
  onNewSender: (senderId: string) => void;
  onSendFailed: () => void;
  /** Qrewing AI could not be turned on at create time (non-blocking note). */
  aiNote?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { rootRef, onLayout: measureRoot, top, overlap: headerOverlap } = useHeaderOverlap();
  const router = useRouter();
  const chat = useChat(room.id, userId, onNewSender);
  // Spec 10.5: the room I opened last is the one Siri asks about.
  useEffect(() => noteSiriRoomOpened(room.id), [room.id]);
  const uploadSummary = useRoomUploadSummary(room.id);
  const [composer, dispatchComposer] = useReducer(composerReducer, initialComposer);
  // Qrewing AI (spec 3.2): disclosure, entry gate, Mute small talk with important-message alerts.
  const qrewing = useQrewingChat(room.id, room.type, userId);
  useRecapTriggers(room.id, userId, qrewing.aiEnabled, remainingMs);
  const [disclosureClosed, setDisclosureClosed] = useState(false);
  const [askConsent, setAskConsent] = useState(false);
  const showDisclosure = (qrewing.gates.disclosure && !disclosureClosed) || askConsent;
  const isEvent = room.type === 'event';
  const smallTalk = useSmallTalk({
    roomId: room.id,
    userId,
    myName: userId ? names.get(userId) : undefined,
    muted: qrewing.available && isEvent && !!qrewing.me?.aiOk && !!qrewing.me?.mute,
    ready: !chat.loading,
    loadError: chat.error,
    messages: chat.messages,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows: MutedRow<ChatItem>[] = useMemo(
    () =>
      smallTalk.active
        ? collapseSmallTalk(chat.messages, smallTalk.visible, expanded)
        : chat.messages.map((item) => ({ type: 'message' as const, item })),
    [smallTalk.active, smallTalk.visible, chat.messages, expanded],
  );
  const hiddenCount = rows.reduce((n, r) => n + (r.type === 'hidden' ? r.ids.length : 0), 0);
  const listRef = useRef<FlatList<MutedRow<ChatItem>>>(null);
  const [aiNoteShown, setAiNoteShown] = useState(!!aiNote);

  function showImportant(messageId: string) {
    let index = rows.findIndex((r) => (r.type === 'message' ? r.item.id === messageId : r.ids.includes(messageId)));
    if (index >= 0 && rows[index].type === 'hidden') {
      const key = (rows[index] as { key: string }).key;
      setExpanded((cur) => new Set(cur).add(key));
    }
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    smallTalk.dismissBanner();
  }
  const draft = composer.draft;
  const canSend = canSendDraft(draft);
  // Q 03.01 head (title, Ends line, tabs) and #9 ends-soon line hide while the keyboard is open, so typing
  // keeps the message space (work list: "Title must not cost message space with keyboard open").
  const keyboardOpen = useKeyboardOpen();
  const expiresMs = new Date(room.expires_at).getTime();
  const nowMs = expiresMs - remainingMs;
  const endsSoon = showEndsSoon(room.created_at, room.expires_at, nowMs);
  const endsLine = en.room.endsOn(
    endsDay(expiresMs, nowMs),
    new Date(expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    new Date(expiresMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  );

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

  // #8: a "shared 3 photos" line opens Photos.
  function openPhotos() {
    router.push({ pathname: '/room/[id]/gallery', params: { id: room.id } });
  }

  function onFailedPress(item: ChatItem) {
    Alert.alert(en.chat.failed, undefined, [
      { text: en.room.cancel, style: 'cancel' },
      { text: en.chat.discard, style: 'destructive', onPress: () => chat.discard(item.id) },
      { text: en.chat.retry, onPress: () => chat.retry(item.id) },
    ]);
  }

  const offline = !chat.live && !chat.loading ? <Text style={styles.offline}>{en.chat.reconnecting}</Text> : null;

  return (
    <>
      {/* Q 03.01: the nav bar keeps the back button and "Chat"; the room name is the handwritten title below. */}
      <Stack.Screen options={{ title: en.chat.title }} />
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={top}>
        <View
          ref={rootRef}
          onLayout={measureRoot}
          style={[styles.flex, { backgroundColor: colors.background, paddingTop: headerOverlap }]}
        >
          {keyboardOpen ? (
            offline ? <View style={styles.compactStrip}>{offline}</View> : null
          ) : (
            <View style={styles.head}>
              <HandTitle style={styles.title}>{room.name}</HandTitle>
              <View style={styles.endsRow}>
                <Text style={styles.ends}>{endsLine}</Text>
                {offline}
              </View>
              {endsSoon ? (
                <Link href={{ pathname: '/room/[id]/info', params: { id: room.id } }} asChild>
                  <Pressable style={styles.banner} accessibilityRole="link" accessibilityHint={en.room.info}>
                    <Text style={styles.bannerText} numberOfLines={1}>
                      {en.room.endsSoonLine}
                    </Text>
                  </Pressable>
                </Link>
              ) : null}
              <View style={styles.tabs} accessibilityRole="tablist" accessibilityLabel={en.chat.tabs}>
                <Tab label={en.chat.tabChat} selected />
                <Tab
                  href={{ pathname: '/room/[id]/gallery', params: { id: room.id } }}
                  label={
                    uploadSummary.failed > 0
                      ? en.media.headerLinkFailed
                      : uploadSummary.pending > 0
                        ? en.media.headerLinkUploading(uploadSummary.pending)
                        : en.media.headerLink
                  }
                  danger={uploadSummary.failed > 0}
                  a11y={en.media.headerLinkA11y(uploadSummary.pending, uploadSummary.failed)}
                />
                {room.location_allowed || room.host_id === userId ? (
                  <Tab href={{ pathname: '/room/[id]/map', params: { id: room.id } }} label={en.map.headerLink} />
                ) : null}
                <Tab href={{ pathname: '/room/[id]/invite', params: { id: room.id } }} label={en.room.invite} />
                <Tab href={{ pathname: '/room/[id]/info', params: { id: room.id } }} label={en.room.info} />
              </View>
            </View>
          )}
          {aiNoteShown && !keyboardOpen ? (
            <Pressable style={styles.aiNote} onPress={() => setAiNoteShown(false)} accessibilityRole="button">
              <Hint>{en.qrewing.create.aiSaveFailed}</Hint>
            </Pressable>
          ) : null}
          {qrewing.available && isEvent && !qrewing.gates.disclosure && !qrewing.gates.entry && !keyboardOpen ? (
            <MuteBar
              roomId={room.id}
              me={qrewing.me}
              hiddenCount={hiddenCount}
              unavailable={smallTalk.unavailable !== null}
              onChanged={qrewing.reload}
              onNeedConsent={() => setAskConsent(true)}
            />
          ) : null}
          {smallTalk.banner ? (
            <ImportantBannerView
              banner={smallTalk.banner}
              onPress={() => showImportant(smallTalk.banner!.messageId)}
              onClose={smallTalk.dismissBanner}
            />
          ) : null}
          <RoomActivityBar
            roomId={room.id}
            activitySeq={room.activity_seq}
            userId={userId}
            names={names}
            hideControls={keyboardOpen}
          />

          {/* Spec 10.1: the list area ends at the composer, so Ask Qrewing floats over the list and never covers it. */}
          <View style={styles.flex}>
          {qrewing.gates.entry ? (
            <EntryGate roomId={room.id} />
          ) : chat.loading ? (
            <ActivityIndicator style={styles.loading} />
          ) : chat.error && chat.messages.length === 0 ? (
            <View style={styles.center}>
              <Hint tone="error">{en.chat.loadError}</Hint>
              <Button title={en.home.retry} variant="secondary" onPress={chat.reload} />
            </View>
          ) : (
            <FlatList
              ref={listRef}
              style={styles.flex}
              inverted
              data={rows}
              keyExtractor={(r) => (r.type === 'hidden' ? r.key : r.item.id)}
              onScrollToIndexFailed={({ averageItemLength, index }) =>
                listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true })
              }
              // Inverted: paddingTop is the visual bottom, so the newest message clears Ask Qrewing.
              contentContainerStyle={[styles.list, { paddingTop: QREWING_FAB_CLEARANCE }]}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onEndReached={chat.hasMore ? chat.loadOlder : undefined}
              onEndReachedThreshold={0.5}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <Hint>{en.chat.empty}</Hint>
                </View>
              }
              renderItem={({ item: row }) => {
                if (row.type === 'hidden') {
                  return (
                    <HiddenRow
                      count={row.ids.length}
                      onPress={() => setExpanded((cur) => new Set(cur).add(row.key))}
                    />
                  );
                }
                const item = row.item;
                return (
                  <MessageRow
                    item={item}
                    mine={item.sender_id === userId}
                    name={item.sender_id ? memberName(names, item.sender_id, room.host_id, en.chat) : ''}
                    onFailedPress={onFailedPress}
                    onMediaPress={openPhotos}
                  />
                );
              }}
            />
          )}
          <QrewingFab roomId={room.id} />
          </View>

          {/* Q 03.01: one rounded field with the arrow Send inside. Q's left chat icon has no action: omitted. */}
          {qrewing.gates.entry ? null : (
            <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
              <View style={styles.inputWrap}>
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
                  hitSlop={6}
                  style={({ pressed }) => [styles.sendButton, (!canSend || pressed) && { opacity: 0.3 }]}
                >
                  <SymbolView name="arrow.right" size={20} tintColor={colors.label} />
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      <DisclosureSheet
        roomId={room.id}
        visible={showDisclosure}
        onDone={() => {
          setAskConsent(false);
          qrewing.reload();
        }}
        onClose={() => {
          setAskConsent(false);
          setDisclosureClosed(true);
        }}
      />
    </>
  );
}

// Centered lines rather than bubbles. #8: 'media' is the uploader's "shared 3 photos" line.
const NOTICE_KINDS = new Set(['system', 'arrival', 'status', 'emergency', 'media']);

/** Q 03.01 tab pill: the current section black, the others pale links. */
function Tab({
  href,
  label,
  selected,
  danger,
  a11y,
}: {
  href?: Href;
  label: string;
  selected?: boolean;
  danger?: boolean;
  a11y?: string;
}) {
  const router = useRouter();
  // Larger text sizes shrink the label to fit its pill instead of wrapping or clipping it.
  const text = (
    <Text
      style={[styles.tabText, selected && styles.tabTextSelected, danger && styles.tabTextDanger]}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.5}
      maxFontSizeMultiplier={1.6}
    >
      {label}
    </Text>
  );
  if (!href) {
    return (
      <View
        style={[styles.tab, styles.tabSelected]}
        accessibilityRole="tab"
        accessibilityLabel={a11y ?? label}
        accessibilityState={{ selected: !!selected }}
      >
        {text}
      </View>
    );
  }
  // Not <Link asChild>: its Slot merges styles as objects, so a function style ({ pressed }) => …
  // was dropped and the pill (background, flex: 1) never applied (U3 F1).
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ selected: false }}
      onPress={() => router.push(href)}
      style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
    >
      {text}
    </Pressable>
  );
}

function MessageRow({
  item,
  mine,
  name,
  onFailedPress,
  onMediaPress,
}: {
  item: ChatItem;
  mine: boolean;
  name: string;
  onFailedPress: (item: ChatItem) => void;
  onMediaPress: () => void;
}) {
  const time = useMemo(
    () => new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    [item.created_at],
  );

  if (item.kind === 'media') {
    const text = en.chat.shared(mine ? en.chat.you : name, item.body || en.chat.sharedFallback);
    return (
      <Pressable
        style={styles.noticeRow}
        accessibilityRole="button"
        accessibilityHint={en.chat.openPhotosHint}
        onPress={onMediaPress}
      >
        <Text style={[styles.notice, styles.mediaNotice]}>
          {text} · {time}
        </Text>
      </Pressable>
    );
  }

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

  // Q 03.01: "Jay · 8:48 AM" / "You · 8:53 AM" above each bubble; sending and failed states replace the time.
  const failed = item.pending === 'failed';
  const when = item.pending === 'sending' ? en.chat.sending : failed ? en.chat.failed : time;
  const bubble = (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs, failed && styles.failedBubble]}>
      <Text selectable style={styles.body}>
        {item.body}
      </Text>
    </View>
  );

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
      <Text style={[styles.meta, failed && styles.failedMeta]}>
        {mine ? en.chat.you : name} · {when}
      </Text>
      {failed ? (
        <Pressable accessibilityRole="button" accessibilityHint={en.chat.failed} onPress={() => onFailedPress(item)}>
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 48 },
  center: { padding: 20, gap: 12 },
  head: { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 10, gap: 6 },
  title: { fontSize: 30, lineHeight: 38 },
  endsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  ends: { flexShrink: 1, fontSize: 14, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
  compactStrip: { paddingHorizontal: 24, paddingVertical: 6, alignItems: 'flex-end' },
  offline: { fontSize: 13, color: colors.warning },
  banner: {
    backgroundColor: colors.field,
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bannerText: { fontSize: 14, color: colors.label },
  aiNote: { paddingHorizontal: 24, paddingBottom: 6 },
  tabs: { flexDirection: 'row', gap: 6, marginTop: 8 },
  tab: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
  },
  tabSelected: { backgroundColor: colors.tint },
  tabPressed: { opacity: 0.5 },
  tabText: { fontSize: 13, color: colors.label },
  tabTextSelected: { color: colors.onTint },
  tabTextDanger: { color: colors.danger },
  list: { paddingHorizontal: 24, paddingVertical: 8, gap: 2, flexGrow: 1 },
  // The list is inverted, so the empty state is flipped back.
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', transform: [{ scaleY: -1 }] },
  row: { marginVertical: 6, maxWidth: '80%', gap: 4 },
  rowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: { borderRadius: 10, borderCurve: 'continuous', paddingHorizontal: 12, paddingVertical: 9 },
  mine: { backgroundColor: colors.fieldStrong },
  theirs: { backgroundColor: colors.field },
  failedBubble: { opacity: 0.6 },
  body: { fontSize: 16, color: colors.label },
  meta: { fontSize: 12, color: colors.secondaryLabel },
  failedMeta: { color: colors.danger },
  noticeRow: { alignSelf: 'center', marginVertical: 8, paddingHorizontal: 16 },
  notice: { fontSize: 13, color: colors.secondaryLabel, textAlign: 'center' },
  emergency: { color: colors.danger, fontWeight: '600' },
  mediaNotice: { color: colors.label, textDecorationLine: 'underline' },
  composer: { paddingHorizontal: 24, paddingTop: 8, backgroundColor: colors.background },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.separator,
    borderRadius: 22,
    borderCurve: 'continuous',
    paddingLeft: 16,
    paddingRight: 6,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 42,
    color: colors.label,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 16,
  },
  sendButton: { width: 36, height: 42, alignItems: 'center', justifyContent: 'center' },
});
