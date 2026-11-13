import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HandTitle } from '@/components/hand-title';
import { InkArt } from '@/components/ink-art';
import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { clearMatchRun, type FaceData, lastMatchRun, loadFaceData, runFaceMatch } from '@/lib/face';
import { faceJobCounts, faceViewState, type MatchRun, photosOfMe, shouldRunMatch } from '@/lib/face-plan';
import { errorMessage } from '@/lib/errors';
import { createLatestLoader } from '@/lib/latest-load';
import type { Media } from '@/lib/media';

type Props = {
  roomId: string;
  userId: string;
  media: Media[];
  columns: number;
  gap: number;
  renderTile: (item: Media) => ReactNode;
  onRefreshMedia: () => void | Promise<void>;
  /** Room notices (upload rows, Room closes, Original saved) that scroll with the content. */
  header?: ReactNode;
  /**
   * Spec 7.3 grace (the host ended the room; 30 minutes of read and download): no match run, no Set up or
   * Manage. Matched photos and their downloads stay.
   */
  readOnly?: boolean;
};

/** The gallery's "Me" filter: my matched photos in this room, or setup, disabled and error states. */
export function PhotosOfMe({
  roomId,
  userId,
  media,
  columns,
  gap,
  renderTile,
  onRefreshMedia,
  header,
  readOnly = false,
}: Props) {
  const router = useRouter();
  // loadedAt: when the jobs were read; stale 'running' jobs are judged against it.
  const [data, setData] = useState<(FaceData & { loadedAt: number }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<MatchRun | null>(() => lastMatchRun(roomId));
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  // FG-L1: focus, pull and post-run loads can overlap; only the newest one is applied.
  const [runLatest] = useState(createLatestLoader);

  /** Returns the applied face data, or null when the load failed or a newer load superseded it. */
  const load = useCallback(async () => {
    let applied: FaceData | null = null;
    await runLatest(
      `${roomId}|${userId}`,
      () => loadFaceData(roomId, userId),
      (outcome) => {
        if (outcome.ok) {
          applied = outcome.data;
          setData({ ...outcome.data, loadedAt: Date.now() });
          setLoadError(null);
        } else {
          setLoadError(errorMessage(outcome.error));
        }
      },
    );
    return applied as FaceData | null;
  }, [roomId, userId, runLatest]);

  /** Only while jobs are pending (FG-2), asks the service once to process them, then reloads. */
  const runIfPending = useCallback(async (next: FaceData | null) => {
    // F7-2: pick up a run made elsewhere (the enrollment screen) while this view stayed mounted.
    setRun(lastMatchRun(roomId));
    if (readOnly || !next?.enrollment || runningRef.current) return;
    if (!shouldRunMatch(false, faceJobCounts(next.jobs, Date.now()).pending)) return;
    runningRef.current = true;
    setRunning(true);
    try {
      setRun(await runFaceMatch(roomId));
      await load();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [load, roomId, readOnly]);

  /** Loads my face data, then runs matching if jobs are pending. */
  const refresh = useCallback(async () => {
    await runIfPending(await load());
  }, [load, runIfPending]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  /** Non-grid states scroll too, so the notices above them never squeeze them off screen. */
  const scroll = (children: ReactNode) => (
    <ScrollView contentInsetAdjustmentBehavior="never">
      {header}
      {children}
    </ScrollView>
  );

  if (loadError && !data) {
    return scroll(
      <View style={styles.center}>
        <Hint tone="error">{en.face.loadError}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={refresh} />
      </View>,
    );
  }
  if (!data) return scroll(<ActivityIndicator style={styles.loading} />);

  const counts = faceJobCounts(data.jobs, data.loadedAt);
  const view = faceViewState({ enrolled: !!data.enrollment, run, pending: counts.pending });
  const openSetup = () => router.push({ pathname: '/room/[id]/face', params: { id: roomId } });

  // Q 06.01: handwritten title, two short lines, art, and the black setup button.
  if (view === 'consent') {
    return (
      <ScrollView contentContainerStyle={styles.introScroll} contentInsetAdjustmentBehavior="never">
        {header}
        <View style={styles.intro}>
          <View style={styles.introHead}>
            <HandTitle style={styles.centerText}>{en.face.title}</HandTitle>
            <Text style={styles.introLine}>{en.face.intro}</Text>
            <Text style={styles.introMeta}>{en.face.introMeta}</Text>
          </View>
          <InkArt art="reference" width={180} />
          {readOnly ? <Hint>{en.qrewing.grace.notSetUp}</Hint> : <Button title={en.face.setUp} onPress={openSetup} />}
        </View>
      </ScrollView>
    );
  }

  const manage = readOnly ? null : (
    <Pressable onPress={openSetup} accessibilityRole="button" hitSlop={8}>
      <Text style={styles.link}>{en.face.manage}</Text>
    </Pressable>
  );

  // FG-3: while matching is off, no badges and no counts; only the truthful notice.
  if (view === 'disabled') {
    return scroll(
      <View style={styles.center}>
        <Hint>{en.face.disabled}</Hint>
        {manage}
      </View>,
    );
  }
  if (view === 'error' && run?.kind === 'error') {
    return scroll(
      <View style={styles.center}>
        <Hint tone="error">{en.face.runError(run.message)}</Hint>
        <Button
          title={en.home.retry}
          variant="secondary"
          busy={running}
          onPress={() => {
            clearMatchRun(roomId);
            setRun(null);
            refresh();
          }}
        />
        {manage}
      </View>,
    );
  }

  const items = photosOfMe(media, data.matches);
  return (
    <FlatList
      data={items}
      keyExtractor={(m) => m.id}
      numColumns={columns}
      columnWrapperStyle={{ gap }}
      contentContainerStyle={{ gap }}
      contentInsetAdjustmentBehavior="automatic"
      onRefresh={async () => {
        // The spinner covers the media and face reloads; a match run it starts shows as "Checking".
        setRefreshing(true);
        let next: FaceData | null = null;
        try {
          [, next] = await Promise.all([onRefreshMedia(), load()]);
        } finally {
          setRefreshing(false);
        }
        runIfPending(next);
      }}
      refreshing={refreshing}
      ListHeaderComponent={
        <>
          {header}
          <View style={styles.header}>
          <View style={styles.headerText}>
            {view === 'checking' ? <Hint>{en.face.checking(counts.pending)}</Hint> : null}
            {counts.failed > 0 ? <Hint tone="error">{en.face.failed(counts.failed)}</Hint> : null}
          </View>
            {manage}
          </View>
        </>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.title}>{en.face.empty}</Text>
          <Hint>{en.face.emptyHint}</Hint>
        </View>
      }
      renderItem={({ item }) => (
        <View>
          {renderTile(item)}
          <View style={styles.badge} pointerEvents="none">
            <Text style={styles.badgeText}>{en.face.likelyYou}</Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 40 },
  center: { padding: 24, gap: 12, alignItems: 'center' },
  introScroll: { flexGrow: 1 },
  intro: { flexGrow: 1, paddingHorizontal: 24, paddingVertical: 28, gap: 28, justifyContent: 'space-between' },
  introHead: { alignItems: 'center', gap: 6 },
  centerText: { textAlign: 'center' },
  introLine: { fontSize: 15, color: colors.secondaryLabel, textAlign: 'center' },
  introMeta: { fontSize: 13, color: colors.secondaryLabel, textAlign: 'center' },
  title: { fontSize: 17, fontWeight: '600', color: colors.label, textAlign: 'center' },
  link: { fontSize: 15, fontWeight: '500', color: colors.tint },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingBottom: 8 },
  headerText: { flex: 1, gap: 4 },
  badge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  badgeText: { fontSize: 11, fontWeight: '600', color: 'white' },
});
