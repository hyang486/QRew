import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { excludeFaceMatch, myVisibleMatch } from '@/lib/face';
import { authHeaders, downloadOriginal, formatBytes, getMedia, type Media, objectUrl, saveOriginal } from '@/lib/media';
import { listMembers } from '@/lib/rooms';

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; media: Media; uploader: string; matchEnrollment: string | null };

export default function MediaScreen() {
  const { id, mediaId } = useLocalSearchParams<{ id: string; mediaId: string }>();
  const { session } = useAuth();
  const userId = session?.user.id;
  const token = session?.access_token;
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const media = await getMedia(mediaId);
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
      setState({ status: 'ready', media, uploader, matchEnrollment });
    } catch (e) {
      setState({ status: 'error', message: errorMessage(e) });
    }
  }, [id, mediaId, userId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (state.status === 'loading') {
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  }
  if (state.status !== 'ready' || !token) {
    return (
      <Screen>
        <Stack.Screen options={{ title: '' }} />
        <Hint tone="error">{state.status === 'error' ? state.message : en.media.notFound}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </Screen>
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
  const [download, setDownload] = useState<
    { status: 'idle' } | { status: 'busy'; pct: number } | { status: 'done'; message: string } | { status: 'error'; message: string }
  >({ status: 'idle' });

  async function onDownload() {
    setDownload({ status: 'busy', pct: 0 });
    try {
      const result = await downloadOriginal(media, (f) => setDownload({ status: 'busy', pct: Math.round(f * 100) }));
      const saved = await saveOriginal(media, result.file);
      const verified = en.media.verified(formatBytes(result.bytes));
      setDownload(
        saved === 'cancelled'
          ? { status: 'idle' }
          : { status: 'done', message: `${saved === 'library' ? en.media.savedToPhotos : en.media.savedFile} ${verified}` },
      );
    } catch (e) {
      setDownload({ status: 'error', message: errorMessage(e) });
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: media.kind === 'video' ? en.media.video : media.kind === 'file' ? en.media.file : '' }} />
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

      <View style={styles.meta}>
        <Text style={styles.name} selectable>
          {media.file_name}
        </Text>
        <Text style={styles.sub}>
          {en.media.sharedBy(uploader)} · {formatBytes(media.size_bytes)} · {new Date(media.created_at).toLocaleString()}
        </Text>
      </View>

      <Button
        title={download.status === 'busy' ? en.media.downloading(download.pct) : en.media.download}
        onPress={onDownload}
        busy={download.status === 'busy' && download.pct === 0}
        disabled={download.status === 'busy'}
      />
      {download.status === 'done' ? <Hint>{download.message}</Hint> : null}
      {download.status === 'error' ? <Hint tone="error">{download.message}</Hint> : null}
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
    </Screen>
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
  meta: { gap: 4 },
  name: { fontSize: 17, fontWeight: '600', color: colors.label },
  sub: { fontSize: 13, color: colors.secondaryLabel },
});
