import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { QCard, QScreen } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';

import { listEntryProfiles } from './entry-api';
import { linksByUser } from './event-plan';
import { peopleEmpty } from './people-empty';
import { type MatchResult, type QrewingError, requestMatches, useEntryQuestions, useQrewingRoom } from './qrewing-api';
import { matchStep } from './qrewing-plan';
import { en } from '@/i18n/en';

const s = en.qrewing.people;

type State =
  | { status: 'loading' }
  | {
      status: 'ready';
      result: MatchResult;
      links: ReadonlyMap<string, string[]>;
      updating: boolean;
      /** No re-ask follows: the copy says to tap Refresh (R5). */
      final: boolean;
      /** A failed re-ask: the kept list shows with this line (R4). */
      error: QrewingError | null;
    }
  | { status: 'pending'; final: boolean }
  | { status: 'error'; error: QrewingError };

type Loaded = { state: State; retryInMs: number | null };

async function load(roomId: string, last: MatchResult | null, isRetry: boolean): Promise<Loaded> {
  const [res, profiles] = await Promise.all([requestMatches(roomId), listEntryProfiles(roomId).catch(() => [])]);
  const step = matchStep(res, last, isRetry);
  if (step.show === 'error') return { state: { status: 'error', error: step.error }, retryInMs: null };
  const final = step.retryInMs === null;
  if (step.show === 'pending') return { state: { status: 'pending', final }, retryInMs: step.retryInMs };
  return {
    state: { status: 'ready', result: step.result, links: linksByUser(profiles), updating: step.pending, final, error: step.error },
    retryInMs: step.retryInMs,
  };
}

/**
 * People to meet (spec 3.2): Qrewing's suggestions from entry info, with each person's headline, the reason and
 * their links. Refresh asks again; the server reuses a list younger than 10 minutes and marks it stale.
 */
export function PeopleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const q = useQrewingRoom(id);
  const [state, setState] = useState<State>({ status: 'loading' });
  // Only the newest request may set the state (a Refresh after leaving, or two quick taps, must not).
  const latest = useRef(0);
  // The last list shown, kept while a 202 pending answer is re-asked.
  const lastList = useRef<MatchResult | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    const ask = (isRetry: boolean) => {
      const n = ++latest.current;
      load(id, lastList.current, isRetry).then(({ state: next, retryInMs }) => {
        if (latest.current !== n) return;
        if (next.status === 'ready') lastList.current = next.result;
        setState(next);
        // One re-ask after a pending answer; the re-ask itself never schedules another (isRetry).
        if (retryInMs !== null) retryTimer.current = setTimeout(() => ask(true), retryInMs);
      });
    };
    ask(false);
  }, [id]);

  useEffect(() => {
    const req = latest;
    lastList.current = null;
    run();
    return () => {
      req.current++;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [run]);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    run();
  }, [run]);

  const notConsented = q.me !== null && !q.me.aiOk;
  const questions = useEntryQuestions(id);
  const empty = peopleEmpty({
    status: state.status,
    error: state.status === 'error' || state.status === 'ready' ? state.error : null,
    matches: state.status === 'ready' ? state.result.matches.length : 0,
    notConsented,
    questions: { loaded: questions.loaded, failed: questions.failed, count: questions.questions.length },
  });

  return (
    <QScreen
      title={s.title}
      actions={
        empty === 'noQuestions' ? undefined : empty === 'noEntry' ? (
          <Button
            title={en.qrewing.info.addEntry}
            onPress={() => router.push({ pathname: '/room/[id]/entry', params: { id } })}
          />
        ) : (
          <Button title={s.refresh} variant="secondary" onPress={refresh} busy={state.status === 'loading'} />
        )
      }
    >
      <Stack.Screen options={{ title: s.title, headerTitle: '' }} />
      {state.status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Hint>{s.loading}</Hint>
        </View>
      ) : state.status === 'pending' ? (
        <Hint>{state.final ? s.pendingFinal : s.pending}</Hint>
      ) : state.status === 'error' ? (
        empty === 'noQuestions' ? (
          <EmptyState title={s.noQuestionsTitle} body={s.noQuestions} />
        ) : empty === 'noEntry' ? (
          <EmptyState title={s.noEntryTitle} body={s.noEntry} />
        ) : (
          <Hint tone="error">{notConsented ? s.notConsented : en.qrewing.errors[state.error]}</Hint>
        )
      ) : empty === 'noQuestions' ? (
        <EmptyState title={s.noQuestionsTitle} body={s.noQuestions} />
      ) : state.result.matches.length === 0 ? (
        <EmptyState title={s.emptyTitle} body={s.empty} />
      ) : (
        <>
          {state.error ? (
            <Hint tone="error">{state.error === 'network' ? en.qrewing.errors.network : s.updateFailed}</Hint>
          ) : state.updating ? (
            <Hint>{state.final ? s.updatingFinal : s.updating}</Hint>
          ) : state.result.stale ? (
            <Hint>{s.stale}</Hint>
          ) : null}
          {state.result.matches.map((m) => (
            <QCard key={m.userId}>
              <Text style={styles.name} accessibilityRole="header">{m.displayName}</Text>
              {m.headline ? <Text style={styles.headline}>{m.headline}</Text> : null}
              <Text style={styles.reason}>{m.reason}</Text>
              {(state.links.get(m.userId) ?? []).map((url) => (
                <Pressable key={url} onPress={() => Linking.openURL(url).catch(() => {})} accessibilityRole="link">
                  <Text style={styles.link} numberOfLines={1}>
                    {url.replace(/^https:\/\//i, '')}
                  </Text>
                </Pressable>
              ))}
            </QCard>
          ))}
        </>
      )}
    </QScreen>
  );
}

/** UI audit 7: a neutral empty state; the screen's one pinned action is its CTA. */
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.label, textAlign: 'center' },
  emptyBody: { fontSize: 15, color: colors.secondaryLabel, textAlign: 'center' },
  center: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  name: { fontSize: 17, fontWeight: '600', color: colors.label },
  headline: { fontSize: 15, color: colors.secondaryLabel },
  reason: { fontSize: 15, color: colors.label, marginTop: 4 },
  link: { fontSize: 15, color: colors.tint, textDecorationLine: 'underline', marginTop: 4 },
});
