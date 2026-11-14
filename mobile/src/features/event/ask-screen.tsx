// Private Qrewing chat (spec 10.1, 10.4): route `room/[id]/ask`. Only the asker sees it; nothing is posted to the
// room, and the history stays on this phone (ask-store).
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAnnounce } from '@/features/event/announce';
import { QField, QScreen, type QScreenReveal } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';
import { paceSnapshot, paceStartPoint } from '@/features/pace/engine';
import { en } from '@/i18n/en';
import { myFirstSharedPoint } from '@/lib/location';
import { supabase } from '@/lib/supabase';

import { ASK_FAKE, fakeAskInvoke } from './ask-fake';
import { type AskError, ASK_LIMITS, askAnchor, askQuestion, type AskTurn } from './ask-plan';
import { appendAskTurn, loadAskHistory, purgeAskHistory } from './ask-store';
import { DisclosureSheet } from './disclosure-sheet';
import { askQrewing } from './qrewing-api';

const s = en.qrewing.ask;

export function AskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  // The question waiting for its answer (shown as my bubble plus "thinking").
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<AskError | null>(null);
  const [consent, setConsent] = useState(false);
  useAnnounce(sending ? s.thinking : null, sending);
  useAnnounce(error ? en.qrewing.errors[error] : null, error);
  const mounted = useRef(true);
  const lastRef = useRef<ComponentRef<typeof View>>(null);
  const revealRef = useRef<QScreenReveal>(null);

  useEffect(() => {
    mounted.current = true;
    loadAskHistory(id).then((h) => {
      if (!mounted.current) return;
      setTurns(h);
      setLoaded(true);
    });
    return () => {
      mounted.current = false;
    };
  }, [id]);

  // The newest bubble (or the thinking line, or the error) stays in view.
  useEffect(() => {
    if (lastRef.current) revealRef.current?.(lastRef.current);
  }, [loaded, turns.length, sending, error]);

  async function send() {
    const q = askQuestion(draft);
    if (!q || sending) return;
    setSending(q);
    setDraft('');
    setError(null);
    const mine = await myAskContext(id);
    const res = await askQrewing(id, q, turns, mine.me, ASK_FAKE ? fakeAskInvoke : undefined, mine.anchor);
    if ('error' in res) {
      if (res.error === 'not_member') {
        // Spec 10.4: no longer in the room, so its history goes and the modal closes.
        await purgeAskHistory(id);
        if (mounted.current) router.back();
        return;
      }
      if (!mounted.current) return;
      setError(res.error);
      // The question is not lost: it goes back into the composer unless something new was typed.
      setDraft((cur) => cur || q);
      setSending(null);
      return;
    }
    const next = await appendAskTurn(id, { q, a: res.answer, at: Date.now() });
    if (!mounted.current) return;
    setTurns(next);
    setSending(null);
  }

  const canSend = !!askQuestion(draft) && !sending && loaded;
  const lastIndex = turns.length - 1;
  return (
    <QScreen
      title={s.title}
      subtitle={s.intro}
      revealRef={revealRef}
      actions={
        <View style={styles.composer}>
          <View style={styles.flex}>
            <QField
              label={s.placeholder}
              value={draft}
              onChangeText={setDraft}
              maxLength={ASK_LIMITS.question}
              multiline
              style={styles.field}
            />
          </View>
          <View style={styles.sendWrap}>
            <Button title={s.send} onPress={send} busy={!!sending} disabled={!canSend} />
          </View>
        </View>
      }
    >
      <Stack.Screen
        options={{
          title: s.title,
          headerTitle: '',
          // A visible way out besides the swipe (VoiceOver users cannot discover it).
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel={s.doneLabel} onPress={() => router.back()} style={styles.headerHit}>
              <Text style={styles.done}>{s.done}</Text>
            </Pressable>
          ),
        }}
      />
      {!loaded ? (
        <ActivityIndicator />
      ) : (
        <>
          {turns.length === 0 && !sending ? <Hint>{s.empty}</Hint> : null}
          {turns.map((t, i) => (
            <View key={`${t.at}:${i}`} style={styles.turn} ref={i === lastIndex && !sending && !error ? lastRef : undefined}>
              <Bubble mine text={t.q} />
              <Bubble text={t.a} />
            </View>
          ))}
          {sending ? (
            <View style={styles.turn} ref={!error ? lastRef : undefined}>
              <Bubble mine text={sending} />
              <Text style={styles.thinking} accessibilityLiveRegion="polite">
                {s.thinking}
              </Text>
            </View>
          ) : null}
          {error ? (
            <View ref={lastRef} style={styles.turn}>
              <Hint tone="error">{en.qrewing.errors[error]}</Hint>
              {error === 'not_consented' ? (
                <Button title={s.reviewConsent} variant="secondary" onPress={() => setConsent(true)} />
              ) : null}
            </View>
          ) : null}
        </>
      )}
      <DisclosureSheet
        roomId={id}
        visible={consent}
        onDone={() => {
          setConsent(false);
          setError(null);
        }}
        onClose={() => setConsent(false)}
      />
    </QScreen>
  );
}

/**
 * My own activity in this room for `me` (spec 10.3), and the progress `anchor` (bug b: the place pin, else my own
 * start point, else s11: my first point shared in this room); nothing when the room read fails.
 */
async function myAskContext(roomId: string) {
  try {
    const { data } = await supabase
      .from('rooms')
      .select('id, activity_state, activity_seq, place_lat, place_lng')
      .eq('id', roomId)
      .maybeSingle();
    if (!data) return { me: null, anchor: undefined };
    const place = data.place_lat != null && data.place_lng != null ? { latitude: data.place_lat, longitude: data.place_lng } : null;
    return { me: paceSnapshot(data), anchor: askAnchor(place, paceStartPoint(data), myFirstSharedPoint(roomId)) };
  } catch {
    return { me: null, anchor: undefined };
  }
}

function Bubble({ text, mine }: { text: string; mine?: boolean }) {
  return (
    <View
      style={[styles.bubble, mine ? styles.mine : styles.bot]}
      accessible
      accessibilityLabel={`${mine ? s.you : s.bot}: ${text}`}
    >
      <Text style={[styles.text, mine && { color: colors.onTint }]} selectable>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerHit: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  done: { fontSize: 17, fontWeight: '600', color: colors.tint, paddingHorizontal: 6 },
  flex: { flex: 1 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  field: { maxHeight: 120, paddingTop: 13, paddingBottom: 13 },
  sendWrap: { minWidth: 76 },
  turn: { gap: 8 },
  bubble: { maxWidth: '85%', borderRadius: 16, borderCurve: 'continuous', paddingHorizontal: 14, paddingVertical: 10 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.tint },
  bot: { alignSelf: 'flex-start', backgroundColor: colors.field },
  text: { fontSize: 16, color: colors.label },
  thinking: { fontSize: 14, color: colors.secondaryLabel },
});
