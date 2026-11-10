import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { QLabel, QLink, QScreen } from '@/components/q-screen';
import { RoomEnded } from '@/components/room-ended';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import {
  enrollFace,
  type FaceEnrollment,
  faceRefUrl,
  loadFaceData,
  pickFaceReference,
  removeFaceEnrollment,
  runFaceMatch,
} from '@/lib/face';
import { createLatestLoader } from '@/lib/latest-load';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, type Room } from '@/lib/rooms';
import { useRoomOver } from '@/lib/use-room-over';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'gone' }
  | { status: 'ready'; room: Room; enrollment: FaceEnrollment | null; refUrl: string | null };

/**
 * Photos of me setup for one room (Qrew unit 5, Q 06.02): review the reference with the full consent points,
 * or (once enrolled) the private reference with Manage (Replace, Stop and remove) at the top right. Nothing is
 * uploaded before "Agree and save".
 */
export default function FaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [replacing, setReplacing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // FG-L1: focus and pull loads can overlap; only the newest one is applied.
  const [runLatest] = useState(createLatestLoader);

  const load = useCallback(async () => {
    if (!userId) return;
    await runLatest(
      `${id}|${userId}`,
      async () => {
        // G-U6-1: the room row comes with the face data, so a room that ended or expired shows Room ended
        // instead of an enrollment form whose save would fail.
        const [room, { enrollment }] = await Promise.all([getRoom(id), loadFaceData(id, userId)]);
        if (!room) return null;
        const refUrl = enrollment ? await faceRefUrl(enrollment.ref_path) : null;
        return { room, enrollment, refUrl };
      },
      (outcome) => {
        if (outcome.ok) {
          setState(outcome.data ? { status: 'ready', ...outcome.data } : { status: 'gone' });
          return;
        }
        // A failed refresh keeps the screen that is already shown and says why.
        const text = errorMessage(outcome.error);
        setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: text }));
        setMessage(text);
      },
    );
  }, [id, userId, runLatest]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const pullRefresh = useCallback(async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);
  // G-U6-1, as Chat: a host's End or a removal arrives as a rooms / room_members notice.
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') load();
  });
  const ended = useRoomOver(state.status === 'ready' ? state.room : null);

  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={pullRefresh} enabled={!busy} />;

  async function pick(source: 'camera' | 'library') {
    setMessage(null);
    try {
      const uri = await pickFaceReference(source);
      if (uri) setPicked(uri);
    } catch (e) {
      const text = errorMessage(e);
      setMessage(text === en.face.cameraDenied || source === 'library' ? text : en.face.cameraUnavailable);
    }
  }

  async function save() {
    if (!picked) {
      setMessage(en.face.chooseFirst);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await enrollFace(id, picked);
      if ('error' in result) {
        setMessage(result.error);
        return;
      }
      // FG-2: one run right after enrolling; the gallery shows its result (disabled while the switch is off).
      await runFaceMatch(id);
      router.back();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmStop() {
    Alert.alert(en.face.stopTitle, en.face.stopBody, [
      { text: en.face.cancel, style: 'cancel' },
      {
        text: en.face.stopConfirm,
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          const result = await removeFaceEnrollment(id);
          setBusy(false);
          if ('error' in result) {
            setMessage(result.error ?? null);
            return;
          }
          router.back();
        },
      },
    ]);
  }

  function openPicker() {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [en.face.takePhoto, en.face.choosePhoto, en.face.cancel], cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) pick('camera');
        if (index === 1) pick('library');
      },
    );
  }

  // Q 06.02 / work list B: Replace and Stop and remove live under Manage (top right); same actions as before.
  function openManage() {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [en.face.replace, en.face.stop, en.face.cancel], cancelButtonIndex: 2, destructiveButtonIndex: 1 },
      (index) => {
        if (index === 0) {
          setPicked(null);
          setMessage(null);
          setReplacing(true);
        }
        if (index === 1) confirmStop();
      },
    );
  }

  if (state.status === 'loading') {
    return (
      <QScreen>
        <Stack.Screen options={{ headerTitle: '' }} />
        <ActivityIndicator style={styles.loading} />
      </QScreen>
    );
  }
  if (state.status === 'gone' || ended.over) {
    return (
      <>
        <Stack.Screen options={{ headerTitle: '', headerRight: () => null }} />
        <RoomEnded room={state.status === 'ready' ? state.room : null} nowMs={ended.nowMs} />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <QScreen title={en.face.title} actions={<Button title={en.home.retry} variant="secondary" busy={refreshing} onPress={pullRefresh} />}>
        <Stack.Screen options={{ headerTitle: '' }} />
        <Hint tone="error">{state.message}</Hint>
      </QScreen>
    );
  }

  if (state.enrollment && !replacing) {
    return (
      <QScreen title={en.face.title} subtitle={en.face.referenceHint} refreshControl={refreshControl}>
        <Stack.Screen
          options={{
            headerTitle: '',
            headerRight: () => (
              <Pressable onPress={openManage} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }} hitSlop={8}>
                <Text style={[styles.headerLink, busy && styles.dimmed]}>{en.face.manage}</Text>
              </Pressable>
            ),
          }}
        />
        <QLabel>{en.face.referenceTitle}</QLabel>
        <View style={styles.photoBox}>
          {state.refUrl ? (
            <Image source={{ uri: state.refUrl }} style={styles.photo} contentFit="cover" accessibilityLabel={en.face.referenceTitle} />
          ) : (
            <SymbolView name="faceid" size={56} tintColor={colors.secondaryLabel} />
          )}
        </View>
        {busy ? <ActivityIndicator /> : null}
        {message ? <Hint tone="error">{message}</Hint> : null}
      </QScreen>
    );
  }

  // Q 06.02: review before saving. All five consent points stay in full here, above the pinned "Agree and save"
  // (the body scrolls); nothing is uploaded before Agree.
  return (
    <QScreen
      title={en.face.reviewTitle}
      subtitle={en.face.reviewSubtitle}
      refreshControl={refreshControl}
      actions={
        <>
          <Button title={en.face.agree} busy={busy} disabled={!picked} onPress={save} />
          <Button title={picked ? en.face.chooseAnother : en.face.pickPhoto} variant="secondary" disabled={busy} onPress={openPicker} />
          {replacing ? <QLink title={en.face.cancel} onPress={() => setReplacing(false)} /> : null}
        </>
      }
    >
      <Stack.Screen options={{ headerTitle: '', headerRight: () => null }} />
      <Pressable
        onPress={openPicker}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={picked ? en.face.chooseAnother : en.face.pickPhoto}
        accessibilityHint={en.face.pickPhotoHint}
        style={styles.photoBox}
      >
        {picked ? (
          <Image source={{ uri: picked }} style={styles.photo} contentFit="cover" />
        ) : (
          <SymbolView name="faceid" size={56} tintColor={colors.secondaryLabel} accessibilityLabel={en.face.noPhotoYet} />
        )}
      </Pressable>
      {message ? <Hint tone="error">{message}</Hint> : null}
      {busy ? <Hint>{en.face.saving}</Hint> : null}
      <Text style={styles.consentTitle} accessibilityRole="header">
        {en.face.consentTitle}
      </Text>
      <View style={styles.points}>
        {en.face.consentPoints.map((p) => (
          <Text key={p} style={styles.point}>
            • {p}
          </Text>
        ))}
      </View>
    </QScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  headerLink: { fontSize: 17, color: colors.tint },
  dimmed: { opacity: 0.4 },
  photoBox: {
    height: 260,
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: '100%', height: '100%' },
  consentTitle: { fontSize: 17, fontWeight: '600', color: colors.label, marginTop: 4 },
  points: { gap: 8 },
  point: { fontSize: 15, lineHeight: 21, color: colors.label },
});
