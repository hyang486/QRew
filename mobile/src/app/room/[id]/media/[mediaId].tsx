import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, Text, View } from 'react-native';

import { SavedCard } from '@/components/media-cards';
import { QScreen } from '@/components/q-screen';
import { RoomEnded } from '@/components/room-ended';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { excludeFaceMatch, myVisibleMatch } from '@/lib/face';
import { authHeaders, discardDownload, downloadOriginal, formatBytes, getMedia, type Media, objectUrl, saveOriginal } from '@/lib/media';
import { mediaTitle, noteSaved, sharedAge } from '@/lib/media-plan';
import { useRoomEvents } from '@/lib/room-channel';
import { getRoom, listMembers, type Room } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';
import { useRoomOver } from '@/lib/use-room-over';

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'gone' }
  | { status: 'error'; message: string }
  | { status: 'ready'; room: Room; media: Media; uploader: string; matchEnrollment: string | null };

export default function MediaScreen() {
  const { id, mediaId } = useLocalSearchParams<{ id: string; mediaId: string }>();
  const { session } = useAuth();
  const userId = session?.user.id;
  const token = session?.access_token;
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      // G-U6-1: with the room row, a room that ended or expired shows Room ended, not "not found" with Retry.
      const [room, media] = await Promise.all([getRoom(id), getMedia(mediaId)]);
      if (!room) {
        setState({ status: 'gone' });
        return;
      }
      if (!media || media.status !== 'ready') {
        setState({ status: 'missing' });
        return;
      }
      let uploader: string = en.chat.formerMember;
      if (media.uploader_id === userId) {
        uploader = en.media.you;
      } else {
        const members = await listMembers(id);
        uploader = members.find((m) => m.user_id === media.uploader_id)?.display_name ?? uploader;
      }
      // "Not me" is offered only for a photo currently in my Photos of me.
      const matchEnrollment =
        media.kind === 'photo' && userId ? await myVisibleMatch(id, userId, media.id).catch(() => null) : null;
      setState({ status: 'ready', room, media, uploader, matchEnrollment });
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e) });
    }
  }, [id, mediaId, userId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // G-U6-1, as Chat: a host's End or a removal arrives as a rooms / room_members notice.
  useRoomEvents(id, (event) => {
    if (event.table === 'rooms' || event.table === 'room_members') load();
  });
  const ended = useRoomOver(state.status === 'ready' ? state.room : null);

  if (state.status === 'loading') {
    return (
      <QScreen>
        <ActivityIndicator style={styles.loading} />
      </QScreen>
    );
  }
  // No Save original or Share once the room is over: the server copy is deleted with it.
  if (state.status === 'gone' || ended.over) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <RoomEnded room={state.status === 'ready' ? state.room : null} nowMs={ended.nowMs} />
      </>
    );
  }
  if (state.status !== 'ready' || !token) {
    return (
      <QScreen actions={<Button title={en.home.retry} variant="secondary" onPress={load} />}>
        <Stack.Screen options={{ title: '' }} />
        <Hint tone="error">{state.status === 'error' ? state.message : en.media.notFound}</Hint>
      </QScreen>
    );
  }

  return (
    <MediaDetail
      media={state.media}
      uploader={state.uploader}
      token={token}
      matchEnrollment={state.matchEnrollment}
      onExcluded={() => setState({ ...state, matchEnrollment: null })}
    />
  );
}

/**
 * Qrew unit 5 (Q 05.03): the title is what the item is (Video, Photo, or a file's own name: the app has no
 * titles), "Shared by <name> · <age>" under it, the media, then pinned "Save original" (download, verify size and
 * SHA-256, save: unchanged) and "Share" (the same verified download, then the share sheet). After a save the
 * "Original saved" card shows here and once on the gallery (Q 05.04).
 */
function MediaDetail({
  media,
  uploader,
  token,
  matchEnrollment,
  onExcluded,
}: {
  media: Media;
  uploader: string;
  token: string;
  matchEnrollment: string | null;
  onExcluded: () => void;
}) {
  const now = useNow(30_000);
  const [download, setDownload] = useState<
    | { status: 'idle' }
    | { status: 'busy'; action: 'save' | 'share'; pct: number }
    | { status: 'done'; message: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [saved, setSaved] = useState(false);

  async function onDownload() {
    setDownload({ status: 'busy', action: 'save', pct: 0 });
    try {
      const result = await downloadOriginal(media, (f) => setDownload({ status: 'busy', action: 'save', pct: Math.round(f * 100) }));
      const savedTo = await saveOriginal(media, result.file);
      const verified = en.media.verified(formatBytes(result.bytes));
      if (savedTo === 'cancelled') {
        setDownload({ status: 'idle' });
        return;
      }
      setSaved(true);
      noteSaved(media.room_id);
      setDownload({ status: 'done', message: `${savedTo === 'library' ? en.media.savedToPhotos : en.media.savedFile} ${verified}` });
    } catch (e) {
      setDownload({ status: 'error', message: errorMessage(e) });
    } finally {
      discardDownload(media);
    }
  }

  // Worklist gap 4: Share sends the verified original (same download as Save) through the system share sheet.
  async function onShare() {
    setDownload({ status: 'busy', action: 'share', pct: 0 });
    try {
      const result = await downloadOriginal(media, (f) => setDownload({ status: 'busy', action: 'share', pct: Math.round(f * 100) }));
      await Share.share({ url: result.file.uri, title: media.file_name });
      setDownload({ status: 'idle' });
    } catch (e) {
      setDownload({ status: 'error', message: errorMessage(e) });
    } finally {
      // Share.share resolves after the sheet closes, when the target has its own copy.
      discardDownload(media);
    }
  }

  const busy = download.status === 'busy';
  const title = mediaTitle(media, { video: en.media.video, photo: en.media.photo });
  const size = formatBytes(media.size_bytes);
  const age = sharedAge(media.created_at, now);

  return (
    <QScreen
      title={title}
      subtitle={age ? en.media.sharedByAge(uploader, en.media.age(age.n, age.unit)) : en.media.sharedBy(uploader)}
      actions={
        <>
          {download.status === 'error' ? <Hint tone="error">{download.message}</Hint> : null}
          <Button
            title={busy && download.action === 'save' ? en.media.downloading(download.pct) : en.media.saveOriginal}
            onPress={onDownload}
            busy={busy && download.action === 'save' && download.pct === 0}
            disabled={busy}
          />
          <Button
            title={busy && download.action === 'share' ? en.media.downloading(download.pct) : en.media.share}
            variant="secondary"
            onPress={onShare}
            busy={busy && download.action === 'share' && download.pct === 0}
            disabled={busy}
          />
        </>
      }
    >
      <Stack.Screen options={{ title, headerTitle: '' }} />
      {media.kind === 'photo' ? (
        <Image
          source={{ uri: objectUrl(media.original_path), headers: authHeaders(token), cacheKey: media.original_path }}
          placeholder={
            media.preview_path
              ? { uri: objectUrl(media.preview_path), headers: authHeaders(token), cacheKey: media.preview_path }
              : undefined
          }
          style={[styles.visual, aspect(media)]}
          contentFit="contain"
          cachePolicy="memory"
          accessibilityLabel={media.file_name}
        />
      ) : media.kind === 'video' ? (
        <Player media={media} token={token} />
      ) : (
        <View style={styles.fileBox}>
          <SymbolView name="doc" size={48} tintColor={colors.secondaryLabel} />
        </View>
      )}

      <Text style={styles.sub} selectable>
        {size ? `${media.file_name} · ${size}` : media.file_name} · {new Date(media.created_at).toLocaleString()}
      </Text>

      {saved ? <SavedCard /> : null}
      {download.status === 'done' ? <Hint>{download.message}</Hint> : null}
      {matchEnrollment ? (
        <Button
          title={en.face.notMe}
          variant="secondary"
          onPress={() =>
            Alert.alert(en.face.notMeTitle, en.face.notMeBody, [
              { text: en.face.cancel, style: 'cancel' },
              {
                text: en.face.notMe,
                onPress: async () => {
                  try {
                    await excludeFaceMatch(matchEnrollment, media.id);
                    onExcluded();
                  } catch (e) {
                    Alert.alert(errorMessage(e));
                  }
                },
              },
            ])
          }
        />
      ) : null}
    </QScreen>
  );
}

function Player({ media, token }: { media: Media; token: string }) {
  const player = useVideoPlayer({ uri: objectUrl(media.original_path), headers: authHeaders(token) });
  return <VideoView player={player} style={[styles.visual, aspect(media)]} nativeControls contentFit="contain" />;
}

function aspect(media: Media) {
  return media.width && media.height ? { aspectRatio: media.width / media.height } : { aspectRatio: 1 };
}

const styles = StyleSheet.create({
  visual: { width: '100%', maxHeight: 520, borderRadius: 12, borderCurve: 'continuous', backgroundColor: 'black' },
  fileBox: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
  },
  loading: { marginTop: 48 },
  sub: { fontSize: 13, color: colors.secondaryLabel },
});
