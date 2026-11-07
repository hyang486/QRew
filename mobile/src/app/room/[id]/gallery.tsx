import { Image } from 'expo-image';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { PhotosOfMe } from '@/components/photos-of-me';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import {
  authHeaders,
  formatBytes,
  MAX_MEDIA_BYTES,
  type Media,
  type MediaFilter,
  objectUrl,
  pickFile,
  pickPhotosAndVideos,
  enqueueUploads,
  type PickedItem,
  splitBySize,
  type UploadJob,
  useRoomMedia,
  useUploads,
} from '@/lib/media';
import { useHeaderOverlap } from '@/lib/use-header-overlap';

/** 'me' = Photos of me (face matching); it lists from the 'all' media query. */
type GalleryFilter = MediaFilter | 'me';
const FILTERS: { key: GalleryFilter; label: string }[] = [
  { key: 'all', label: en.media.all },
  { key: 'mine', label: en.media.mine },
  { key: 'others', label: en.media.others },
  { key: 'me', label: en.face.filter },
];
const COLUMNS = 3;
const GAP = 2;

export default function GalleryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const userId = session?.user.id;
  const token = session?.access_token;
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const { rootRef, onLayout: measureRoot, overlap: headerOverlap } = useHeaderOverlap();
  const media = useRoomMedia(id, filter === 'me' ? 'all' : filter, userId);
  const { reload } = media;
  const uploads = useUploads(id, reload);
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - GAP * (COLUMNS - 1)) / COLUMNS);

  const choose = useCallback(
    async (pick: () => Promise<PickedItem[]>) => {
      try {
        const { ok, tooLarge } = splitBySize(await pick());
        if (tooLarge.length > 0) {
          const list = tooLarge.map(({ item, size }) => `${item.fileName} (${formatBytes(size)})`).join(', ');
          Alert.alert(en.media.tooLargeTitle, en.media.tooLargeSkipped(formatBytes(MAX_MEDIA_BYTES), list));
        }
        if (ok.length > 0 && userId) enqueueUploads(id, userId, ok);
      } catch (e) {
        Alert.alert(en.media.uploadFailed, errorMessage(e));
      }
    },
    [id, userId],
  );

  function openAddMenu() {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [en.media.addPhotos, en.media.addFile, en.media.cancel], cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) choose(pickPhotosAndVideos);
        if (index === 1) choose(pickFile);
      },
    );
  }

  function confirmCancel(job: UploadJob) {
    Alert.alert(en.media.cancelUploadTitle, en.media.cancelUploadBody(job.item.fileName), [
      { text: en.media.keepUploading, style: 'cancel' },
      { text: en.media.cancelUpload, style: 'destructive', onPress: () => uploads.cancel(job.id) },
    ]);
  }

  const emptyText = filter === 'mine' ? en.media.emptyMine : filter === 'others' ? en.media.emptyOthers : en.media.empty;

  return (
    <View ref={rootRef} onLayout={measureRoot} style={[styles.flex, { paddingTop: headerOverlap }]}>
      <Stack.Screen
        options={{
          title: en.media.title,
          headerRight: () => (
            <Pressable onPress={openAddMenu} accessibilityRole="button" accessibilityLabel={en.media.add} hitSlop={8}>
              <SymbolView name="plus" size={22} tintColor={colors.tint} />
            </Pressable>
          ),
        }}
      />
      <View style={styles.segment} accessibilityRole="tablist">
        {FILTERS.map((f) => {
          const selected = f.key === filter;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              style={[styles.segmentItem, selected && styles.segmentSelected]}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {uploads.jobs.length > 0 ? (
        <View style={styles.jobs}>
          {uploads.jobs.map((job) => (
            <UploadRow
              key={job.id}
              job={job}
              onRetry={() => uploads.retry(job.id)}
              onDismiss={() => uploads.dismiss(job.id)}
              onCancel={() => confirmCancel(job)}
            />
          ))}
        </View>
      ) : null}

      {filter === 'me' && userId ? (
        media.loading ? (
          <ActivityIndicator style={styles.loading} />
        ) : (
          <PhotosOfMe
            roomId={id}
            userId={userId}
            media={media.items}
            columns={COLUMNS}
            gap={GAP}
            renderTile={(item) => <Tile media={item} size={tile} token={token} />}
            onRefreshMedia={media.reload}
          />
        )
      ) : media.loading ? (
        <ActivityIndicator style={styles.loading} />
      ) : media.error && media.items.length === 0 ? (
        <View style={styles.center}>
          <Hint tone="error">{en.media.loadError}</Hint>
          <Button title={en.home.retry} variant="secondary" onPress={media.reload} />
        </View>
      ) : (
        <FlatList
          data={media.items}
          keyExtractor={(m) => m.id}
          numColumns={COLUMNS}
          columnWrapperStyle={{ gap: GAP }}
          contentContainerStyle={{ gap: GAP }}
          contentInsetAdjustmentBehavior="automatic"
          onRefresh={media.reload}
          refreshing={false}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>{emptyText}</Text>
              <Hint>{en.media.emptyHint}</Hint>
            </View>
          }
          renderItem={({ item }) => <Tile media={item} size={tile} token={token} />}
        />
      )}
    </View>
  );
}

function Tile({ media, size, token }: { media: Media; size: number; token: string | undefined }) {
  const label = media.kind === 'video' ? en.media.video : media.kind === 'file' ? en.media.file : media.file_name;
  return (
    <Link href={{ pathname: '/room/[id]/media/[mediaId]', params: { id: media.room_id, mediaId: media.id } }} asChild>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={label} style={{ width: size, height: size }}>
        {media.preview_path && token ? (
          <Image
            source={{ uri: objectUrl(media.preview_path), headers: authHeaders(token), cacheKey: media.preview_path }}
            style={styles.fill}
            contentFit="cover"
            transition={100}
            cachePolicy="memory"
          />
        ) : (
          <View style={[styles.fill, styles.fileTile]}>
            <SymbolView name="doc" size={28} tintColor={colors.secondaryLabel} />
            <Text numberOfLines={2} style={styles.fileName}>
              {media.file_name}
            </Text>
          </View>
        )}
        {media.kind === 'video' ? (
          <View style={styles.badge}>
            <SymbolView name="play.fill" size={12} tintColor="white" />
          </View>
        ) : null}
      </Pressable>
    </Link>
  );
}

function UploadRow({
  job,
  onRetry,
  onDismiss,
  onCancel,
}: {
  job: UploadJob;
  onRetry: () => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const failed = job.state === 'failed';
  const pct = Math.round(job.progress * 100);
  const size = formatBytes(job.item.size);
  const status = failed
    ? `${en.media.uploadFailed}: ${job.error ?? ''}`
    : job.state === 'queued'
      ? en.media.waiting
      : en.media.uploading(pct);
  return (
    <View style={styles.job} accessibilityLiveRegion="polite">
      <SymbolView
        name={failed ? 'exclamationmark.triangle.fill' : job.item.kind === 'video' ? 'video' : job.item.kind === 'file' ? 'doc' : 'photo'}
        size={20}
        tintColor={failed ? colors.danger : colors.secondaryLabel}
      />
      <View style={styles.jobText}>
        <Text numberOfLines={1} style={styles.jobName}>
          {size ? `${job.item.fileName} · ${size}` : job.item.fileName}
        </Text>
        <Text numberOfLines={3} style={[styles.jobStatus, failed && { color: colors.danger }]} selectable={failed}>
          {status}
        </Text>
        {!failed ? (
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: job.state === 'queued' ? 0 : pct }}
          >
            <View style={[styles.bar, { width: `${job.state === 'queued' ? 0 : Math.max(2, pct)}%` }]} />
          </View>
        ) : null}
      </View>
      {failed ? (
        <View style={styles.jobActions}>
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={6}>
            <Text style={styles.action}>{en.media.retry}</Text>
          </Pressable>
          <Pressable onPress={onDismiss} accessibilityRole="button" hitSlop={6}>
            <Text style={[styles.action, { color: colors.secondaryLabel }]}>{en.media.dismiss}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={`${en.media.cancelUpload}: ${job.item.fileName}`}
          hitSlop={8}
        >
          <SymbolView name="xmark.circle.fill" size={22} tintColor={colors.secondaryLabel} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  loading: { marginTop: 40 },
  center: { padding: 24, gap: 12, alignItems: 'center' },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.label, textAlign: 'center' },
  segment: {
    flexDirection: 'row',
    margin: 12,
    padding: 2,
    borderRadius: 9,
    backgroundColor: colors.field,
  },
  segmentItem: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.tint },
  segmentText: { fontSize: 14, fontWeight: '500', color: colors.label },
  segmentTextSelected: { color: 'white' },
  jobs: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  job: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
  },
  jobText: { flex: 1, gap: 4 },
  jobName: { fontSize: 15, color: colors.label },
  jobStatus: { fontSize: 13, color: colors.secondaryLabel },
  jobActions: { gap: 8, alignItems: 'flex-end' },
  action: { fontSize: 15, color: colors.tint, fontWeight: '500' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.separator, overflow: 'hidden' },
  bar: { height: 4, backgroundColor: colors.tint },
  fill: { width: '100%', height: '100%' },
  fileTile: { alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8, backgroundColor: colors.field },
  fileName: { fontSize: 12, color: colors.secondaryLabel, textAlign: 'center' },
  badge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    padding: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
});
