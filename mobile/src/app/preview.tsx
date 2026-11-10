import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { InkArt } from '@/components/ink-art';
import { PlaceTimeCards } from '@/components/place-time-cards';
import { QCaption, QScreen } from '@/components/q-screen';
import { Button, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { formatDeletedAt } from '@/lib/create-defaults';
import { errorMessage } from '@/lib/errors';
import { placeTimeOf } from '@/lib/place-time';
import {
  joinRoom,
  previewRoom,
  REMINDER_WINDOW_MS,
  type Invite,
  type RoomPreview,
} from '@/lib/rooms';
import { useNow } from '@/lib/use-now';
import { useRoomOver } from '@/lib/use-room-over';

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

  // G-U6-1: the room's end time passing while the preview is open makes the invite unavailable (Join would fail).
  const ended = useRoomOver(preview ? { deleted_at: null, expires_at: preview.expires_at } : null);
  const unavailable = ended.over ? en.rooms.errors.invalid : preview ? null : error;

  // Qrew Q 07.03: an invite that can't be previewed (invalid, ended, rotated, full, throttled) gets its own
  // screen: "Invite unavailable", the same cause message as before, the paper art, then Enter a room code /
  // Back to rooms. While loading, only a spinner.
  if (!preview || ended.over) {
    if (!unavailable) {
      return (
        <QScreen>
          <ActivityIndicator style={styles.loading} />
        </QScreen>
      );
    }
    return (
      <QScreen
        title={en.preview.unavailableTitle}
        subtitle={unavailable}
        bottom={<InkArt art="paper" width={190} />}
        bottomAlign="center"
        actions={
          <>
            {/* N1: back to the code screen already in the stack (no join → join), or replace this with it. */}
            <Button title={en.preview.enterCode} onPress={() => router.dismissTo('/join')} />
            <Button title={en.room.backToRooms} variant="secondary" onPress={() => router.dismissTo('/')} />
          </>
        }
      />
    );
  }

  const expiresAt = new Date(preview.expires_at);
  const endsSoon = expiresAt.getTime() - now < REMINDER_WINDOW_MS;
  const facts = `${en.preview.members(preview.member_count, preview.max_members)} · ${en.preview.endsAt(
    formatDeletedAt(expiresAt.getTime()),
  )}`;

  const placeTime = placeTimeOf(preview);

  // Q 01.04 (rule USER_DECISIONS:168, R6): title → map → place + Open in Maps → date and time → art, with Join
  // pinned at the bottom and one caption under it. The art and note sit at the bottom of the body, directly
  // above Join (qa b-run: under the title they left a large gap above Join). Map, place and time (0026) render
  // only when the host set them: no pin → no map; no place and no time → nothing between title and art. Q's
  // caption is "Guest name comes next."; here it carries the member count and end time so they stay reachable.
  return (
    <QScreen
      title={preview.name}
      actions={
        <>
          {error ? <Hint tone="error">{error}</Hint> : null}
          {preview.already_member ? (
            <>
              <Hint>{en.preview.alreadyMember}</Hint>
              <Button title={en.preview.open} onPress={() => openRoom(preview.room_id)} />
            </>
          ) : (
            <Button title={en.preview.join} onPress={join} busy={busy} />
          )}
          <QCaption>{facts}</QCaption>
        </>
      }
      bottom={
        <>
          <View style={styles.art}>
            <InkArt roomName={preview.name} />
          </View>
          {endsSoon ? <Hint>{en.preview.endsSoon}</Hint> : null}
        </>
      }
    >
      {placeTime ? <PlaceTimeCards placeTime={placeTime} /> : null}
    </QScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  art: { paddingVertical: 12 },
});
