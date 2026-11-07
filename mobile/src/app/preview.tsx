import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import {
  joinRoom,
  previewRoom,
  REMINDER_WINDOW_MS,
  type Invite,
  type RoomPreview,
} from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

export default function Preview() {
  const router = useRouter();
  const { code, token } = useLocalSearchParams<{ code?: string; token?: string }>();
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const invite: Invite = token ? { token } : { code: code ?? '' };

  useEffect(() => {
    let active = true;
    const target: Invite = token ? { token } : { code: code ?? '' };
    // No invite given: show the invalid-invite copy without recording a failed attempt.
    const request = !token && !code ? Promise.reject(new Error(en.rooms.errors.invalid)) : previewRoom(target);
    request
      .then((p) => active && setPreview(p))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [code, token]);

  function openRoom(id: string) {
    router.dismissTo('/');
    router.push({ pathname: '/room/[id]', params: { id } });
  }

  async function join() {
    setBusy(true);
    setError(null);
    try {
      openRoom(await joinRoom(invite));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <Screen>
        {error ? (
          <>
            <Hint tone="error">{error}</Hint>
            <Button title={en.room.backToRooms} variant="secondary" onPress={() => router.dismissTo('/')} />
          </>
        ) : (
          <ActivityIndicator style={styles.loading} />
        )}
      </Screen>
    );
  }

  const expiresAt = new Date(preview.expires_at);
  const endsSoon = expiresAt.getTime() - now < REMINDER_WINDOW_MS;

  return (
    <Screen>
      <View style={styles.card}>
        <Text style={styles.name}>{preview.name}</Text>
        <Text style={styles.meta}>
          {en.rooms.types[preview.type as keyof typeof en.rooms.types] ?? preview.type}
        </Text>
        <Text style={styles.meta}>{en.preview.members(preview.member_count, preview.max_members)}</Text>
        <Text style={styles.meta}>{en.preview.endsAt(expiresAt.toLocaleString())}</Text>
      </View>
      {endsSoon ? <Hint>{en.preview.endsSoon}</Hint> : null}
      {error ? <Hint tone="error">{error}</Hint> : null}
      {preview.already_member ? (
        <>
          <Hint>{en.preview.alreadyMember}</Hint>
          <Button title={en.preview.open} onPress={() => openRoom(preview.room_id)} />
        </>
      ) : (
        <Button title={en.preview.join} onPress={join} busy={busy} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  card: {
    backgroundColor: colors.field,
    borderRadius: 14,
    borderCurve: 'continuous',
    padding: 20,
    gap: 6,
  },
  name: { fontSize: 24, fontWeight: '700', color: colors.label },
  meta: { fontSize: 16, color: colors.secondaryLabel, fontVariant: ['tabular-nums'] },
});
