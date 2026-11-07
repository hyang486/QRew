import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { QrCode } from '@/components/qr-code';
import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import { getRoom, inviteUrl, rotateInvite, type Room } from '@/lib/rooms';

export default function Invite() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getRoom(id)
      .then((r) => {
        if (!active) return;
        if (r) setRoom(r);
        else setError(en.room.gone);
      })
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [id]);

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
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel={en.invite.done} hitSlop={8} onPress={() => router.dismiss()}>
            <Text style={styles.done}>{en.invite.done}</Text>
          </Pressable>
        ),
      }}
    />
  );

  if (!room) {
    return (
      <Screen>
        {header}
        {error ? <Hint tone="error">{error}</Hint> : <ActivityIndicator style={styles.loading} />}
      </Screen>
    );
  }

  const url = inviteUrl(room.invite_token);

  return (
    <Screen>
      {header}
      <Text style={styles.name}>{room.name}</Text>
      <Hint>{en.invite.hint}</Hint>
      <View style={styles.qr}>
        <QrCode value={url} size={240} accessibilityLabel={en.invite.qrLabel} />
      </View>
      <View style={styles.codeBox}>
        <Text style={styles.codeLabel}>{en.invite.code}</Text>
        <Text style={styles.code} selectable accessibilityLabel={`${en.invite.code} ${room.code.split('').join(' ')}`}>
          {room.code}
        </Text>
      </View>
      <Button
        title={en.invite.share}
        variant="secondary"
        onPress={() => Share.share({ message: en.invite.shareMessage(room.name, room.code, url) })}
      />
      <Button title={en.invite.reissue} variant="secondary" onPress={reissue} />
      {error ? <Hint tone="error">{error}</Hint> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  done: { fontSize: 17, fontWeight: '600', color: colors.tint, paddingHorizontal: 6 },
  loading: { marginTop: 48 },
  name: { fontSize: 22, fontWeight: '700', color: colors.label, textAlign: 'center' },
  qr: {
    alignSelf: 'center',
    padding: 12,
    backgroundColor: 'white',
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  codeBox: { alignItems: 'center', gap: 4 },
  codeLabel: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  code: {
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 8,
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
});
