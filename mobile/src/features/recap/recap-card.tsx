import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { QCard, QLabel } from '@/components/q-screen';
import { Button, colors } from '@/components/ui';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { useRoomEvents } from '@/lib/room-channel';

import { type RecapMark, type RecapMiss, recapCardView, rereadOnSubscribe, type SavedRecap } from './recap-plan';
import { loadMark, loadSavedRecap, readAndSaveRecap, recapForEndedRoom } from './recap-store';

const s = en.qrewing.recap;

type Loaded = { roomId: string; saved: SavedRecap | null; mark: RecapMark | null; miss: RecapMiss | null };

/**
 * Room notices during grace: room_recaps is the only one members still receive (spec 7.1). Mounted only in grace,
 * since the channel refuses ended rooms otherwise.
 */
function GraceRecapNotices({ roomId, onRecap, onSubscribed }: { roomId: string; onRecap: () => void; onSubscribed: () => void }) {
  useRoomEvents(
    roomId,
    (e) => {
      if (e.table === 'room_recaps') onRecap();
    },
    (status) => {
      if (status === 'SUBSCRIBED') onSubscribed();
    },
  );
  return null;
}

/**
 * The saved recap on the Room ended screen (spec 3.3), read from this phone. "No recap was saved" only for rooms
 * this phone knows had Qrewing AI on. In grace (spec 7.3) the shared row is also read for rooms without the mark
 * (the chat was never opened here), and a room_recaps notice reads it again, so "still writing" resolves by
 * itself and a refreshed recap replaces the saved one. After the server deleted the room the reads fail quietly,
 * so only the phone's copy remains.
 */
export function SavedRecapCard({ roomId, grace }: { roomId: string; grace: boolean }) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // Set by a room_recaps notice: read the row even when a copy is saved (the recap may have been refreshed).
  const fromNotice = useRef(false);
  const loadedRef = useRef<Loaded | null>(null);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);
  useEffect(() => {
    let alive = true;
    const notice = fromNotice.current;
    fromNotice.current = false;
    (async () => {
      const [stored, mark] = await Promise.all([loadSavedRecap(roomId), loadMark(roomId)]);
      let saved = stored;
      let miss: RecapMiss | null = null;
      if (notice && userId) saved = (await readAndSaveRecap(roomId, userId)) ?? saved;
      // Early end (spec 7): the room is readable for 30 minutes, but room notices other than room_recaps stop at
      // the end, so a member who missed the recap reads the row (grace read policy), and a phone that knows the
      // room had Qrewing on asks once if there is none yet.
      if (!saved && userId && (mark?.ai || grace)) {
        const res = await recapForEndedRoom(roomId, userId, { ask: mark?.ai === true });
        if ('saved' in res) saved = res.saved;
        else miss = res.miss;
      }
      if (alive) setLoaded({ roomId, saved, mark, miss });
    })()
      .catch(() => {})
      .finally(() => alive && setRetrying(false));
    return () => {
      alive = false;
    };
  }, [roomId, userId, grace, tick]);

  const notices = grace ? (
    <GraceRecapNotices
      roomId={roomId}
      onRecap={() => {
        fromNotice.current = true;
        setTick((n) => n + 1);
      }}
      onSubscribed={() => {
        // A notice may have gone out before this screen subscribed, even while the first read is in flight: read
        // again unless a recap is already here (review R2). A re-run cancels the in-flight read.
        if (rereadOnSubscribe(loadedRef.current)) setTick((n) => n + 1);
      }}
    />
  ) : null;

  return (
    <>
      {notices}
      <RecapCardBody loaded={loaded} roomId={roomId} retrying={retrying} onRetry={() => {
        setRetrying(true);
        setTick((n) => n + 1);
      }} />
    </>
  );
}

function RecapCardBody({
  loaded,
  roomId,
  retrying,
  onRetry,
}: {
  loaded: Loaded | null;
  roomId: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!loaded || loaded.roomId !== roomId) return null;
  const { saved, mark, miss } = loaded;
  const view = recapCardView(saved !== null, mark?.ai === true, miss);
  if (view === 'hidden') return null;
  if (view === 'none') return <Text style={styles.line}>{s.none}</Text>;
  if (view === 'pending' || view === 'offline' || !saved) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.line} accessibilityLiveRegion="polite">{view === 'pending' ? s.pending : s.offline}</Text>
        <Button title={s.retry} variant="secondary" busy={retrying} onPress={onRetry} />
      </View>
    );
  }
  const me = saved.me;
  const mine = [
    me.messages !== null ? s.messages(me.messages) : null,
    me.mediaShared !== null ? s.media(me.mediaShared) : null,
    me.photosOfMe !== null ? s.photosOfMe(me.photosOfMe) : null,
    me.arrivedAt ? s.arrived(new Date(me.arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : null,
    me.pace,
  ].filter((x): x is string => !!x);

  return (
    <View style={styles.wrap}>
      <QLabel>{s.title}</QLabel>
      <QCard>
        <Text style={styles.title} accessibilityRole="header">{saved.server.title}</Text>
        <Text style={styles.body}>{saved.server.summary}</Text>
        {saved.server.highlights.map((h, i) => (
          <Text key={i} style={styles.body} accessibilityLabel={h}>
            {`•  ${h}`}
          </Text>
        ))}
      </QCard>
      {mine.length > 0 ? (
        <>
          <QLabel>{s.you}</QLabel>
          <QCard>
            {mine.map((line, i) => (
              <Text key={i} style={styles.body}>
                {line}
              </Text>
            ))}
          </QCard>
        </>
      ) : null}
      <Text style={styles.line}>{s.savedHere}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  title: { fontSize: 17, fontWeight: '600', color: colors.label, marginBottom: 4 },
  body: { fontSize: 15, lineHeight: 21, color: colors.label },
  line: { fontSize: 15, lineHeight: 21, color: colors.secondaryLabel },
});
