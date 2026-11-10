import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { QrCode } from '@/components/qr-code';
import { QLink, QScreen } from '@/components/q-screen';
import { RoomEnded } from '@/components/room-ended';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, inviteUrl, rotateInvite, type Room } from '@/lib/rooms';
import { useRoomOver } from '@/lib/use-room-over';

export default function Invite() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  // G-U6-1: the room read came back empty (it ended or expired): Room ended, not a bare error line.
  const [gone, setGone] = useState(false);

  const readRoom = useCallback(
    (isActive: () => boolean = () => true) =>
      getRoom(id)
        .then((r) => {
          if (!isActive()) return;
          setGone(r === null);
          if (r) setRoom(r);
        })
        .catch((e) => isActive() && setError(errorMessage(e))),
    [id],
  );

  useEffect(() => {
    let active = true;
    readRoom(() => active);
    return () => {
      active = false;
    };
  }, [readRoom]);

  // G-U6-1, as Chat: a host's End or an expiry change arrives as a rooms notice; the end time passing is timed.
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') void readRoom();
  });
  const ended = useRoomOver(room);

  // Copy code (Q 02.04): copies the 5-digit code only; the button reads "Copied" for a moment.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  async function copyCode(code: string) {
    try {
      await Clipboard.setStringAsync(code);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    setCopied(true);
    AccessibilityInfo.announceForAccessibility(en.invite.copied);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  function reissue() {
    Alert.alert(en.invite.reissueConfirmTitle, en.invite.reissueConfirmBody, [
      { text: en.room.cancel, style: 'cancel' },
      {
        text: en.invite.reissue,
        style: 'destructive',
        onPress: async () => {
          try {
            const next = await rotateInvite(id);
            setRoom((r) => (r ? { ...r, code: next.code, invite_token: next.invite_token } : r));
            setError(null);
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);
  }

  // Invite is a modal. Native-stack shows later pushes (deep links, reminder taps) inside an open modal,
  // which left the room chat as a sheet with its composer under the keyboard (C-1). Done closes it.
  const header = (
    <Stack.Screen
      options={{
        headerTitle: '',
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel={en.invite.done} hitSlop={8} onPress={() => router.dismiss()}>
            <Text style={styles.done}>{en.invite.done}</Text>
          </Pressable>
        ),
      }}
    />
  );

  // No QR or code to share once the room is over.
  if (gone || ended.over) {
    return (
      <>
        {header}
        <RoomEnded room={gone ? null : room} nowMs={ended.nowMs} />
      </>
    );
  }

  if (!room) {
    return (
      <QScreen title={error ? en.invite.heading : undefined}>
        {header}
        {error ? <Hint tone="error">{error}</Hint> : <ActivityIndicator style={styles.loading} />}
      </QScreen>
    );
  }

  const url = inviteUrl(room.invite_token);

  // Qrew unit 5 (Q 02.04): title and room name, the QR on a pale card, the code, then Share invite and Copy code
  // (expo-clipboard, rebuild unit). The code also stays selectable by long press. Reissue (not in Q) is a text
  // button under Copy code, with its confirmation.
  return (
    <QScreen
      title={en.invite.heading}
      subtitle={room.name}
      actions={
        <>
          <Button
            title={en.invite.share}
            onPress={() => Share.share({ message: en.invite.shareMessage(room.name, room.code, url) })}
          />
          <Button
            title={copied ? en.invite.copied : en.invite.copyCode}
            variant="secondary"
            onPress={() => void copyCode(room.code)}
          />
          <QLink title={en.invite.reissue} onPress={reissue} />
          {error ? <Hint tone="error">{error}</Hint> : null}
        </>
      }
    >
      {header}
      <View style={styles.qrCard}>
        <View style={styles.qr}>
          <QrCode value={url} size={200} accessibilityLabel={en.invite.qrLabel} />
        </View>
      </View>
      <View style={styles.codeBox}>
        <Text style={styles.code} selectable accessibilityLabel={`${en.invite.inviteCode} ${room.code.split('').join(' ')}`}>
          {room.code}
        </Text>
        <Text style={styles.codeLabel}>{en.invite.inviteCode}</Text>
      </View>
      <Text style={styles.hint}>{en.invite.hint}</Text>
    </QScreen>
  );
}

/** How long Copy code reads "Copied" after a tap. */
const COPIED_MS = 2000;

const styles = StyleSheet.create({
  done: { fontSize: 17, fontWeight: '600', color: colors.tint, paddingHorizontal: 6 },
  loading: { marginTop: 48 },
  qrCard: {
    alignSelf: 'center',
    padding: 20,
    backgroundColor: colors.field,
    borderRadius: 20,
    borderCurve: 'continuous',
  },
  // The QR keeps a white quiet zone so it scans in dark mode too.
  qr: { padding: 10, backgroundColor: 'white', borderRadius: 8 },
  codeBox: { alignItems: 'center', gap: 4, marginTop: 8 },
  codeLabel: { fontSize: 13, color: colors.secondaryLabel },
  code: {
    fontSize: 36,
    fontWeight: '400',
    letterSpacing: 10,
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
  hint: { fontSize: 13, color: colors.secondaryLabel, textAlign: 'center' },
});
