import { Stack, useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { type ComponentRef, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAnnounce } from '@/features/event/announce';
import { QField, QLabel, QScreen, type QScreenReveal } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';
import { useAuth } from '@/lib/auth';

import { getEntryProfile } from './entry-api';
import { en } from '@/i18n/en';

import {
  type AnswerDraft,
  type AnswerProblem,
  ANSWER_LIMITS,
  answerDraft,
  answerLimit,
  answersDirty,
  type EntryQuestion,
  ordered,
  validateAnswers,
} from './entry-questions';
import { saveEntryAnswers, useEntryQuestions } from './qrewing-api';

const s = en.qrewing.entry;

function problemText(p: AnswerProblem, q: EntryQuestion | undefined): string {
  const prompt = q?.prompt ?? '';
  switch (p) {
    case 'required':
      return s.answerRequired(prompt);
    case 'tooLong':
      return s.tooLong(prompt, q ? answerLimit(q.kind) : ANSWER_LIMITS.long);
    case 'tooManyLinks':
      return s.tooManyLinks;
    case 'linkInvalid':
      return s.linkInvalid;
  }
}

/** One text field of the form: a short or long answer, or one slot of a links answer. */
type Field = { q: EntryQuestion; slot: number | null };

/**
 * Entry info form (spec 3.2, 9.4): the room's own questions in position order, pushed from the chat gate or Room
 * info. `gate=1`: opened before chat, so Save returns to the chat with `replace` and Back leaves the room screen as
 * it was (the chat re-checks on focus).
 */
export function EntryScreen() {
  const { id, gate } = useLocalSearchParams<{ id: string; gate?: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const room = useEntryQuestions(id);
  const questions = useMemo(() => ordered(room.questions), [room.questions]);
  // My saved answers (entry_profiles.answers). `failed`: Save stays off so an empty form never replaces them.
  const [profile, setProfile] = useState<{ done: boolean; failed: boolean; answers: unknown }>({
    done: false,
    failed: false,
    answers: null,
  });
  const [loadTick, setLoadTick] = useState(0);
  // Only what the attendee changed; the rest comes from the saved answers (qa F2: leaving with changes asks first).
  const [edits, setEdits] = useState<AnswerDraft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first answer that fails validateAnswers, shown under its question (spec 9.4 R3).
  const [invalid, setInvalid] = useState<{ questionId: string; text: string } | null>(null);
  // qa F-EQ1: the failing question's field and its inline error are scrolled above the Save bar, with or without
  // a keyboard (a hardware keyboard sends no keyboard events, so the focus alone does not scroll).
  const errorRef = useRef<ComponentRef<typeof View>>(null);
  const revealRef = useRef<QScreenReveal>(null);
  const fields = useRef<(ComponentRef<typeof TextInput> | null)[]>([]);
  // Set after a successful save: prevention turns off first, then the effect below leaves.
  const [saved, setSaved] = useState(false);
  useAnnounce(invalid?.text, invalid);
  useAnnounce(error);

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    getEntryProfile(id, userId)
      .then((row) => {
        // 0028 adds `answers`; database.types.ts does not have it until the types are regenerated.
        const answers = row ? (row as unknown as { answers?: unknown }).answers : null;
        if (alive) setProfile({ done: true, failed: false, answers });
      })
      .catch(() => alive && setProfile({ done: true, failed: true, answers: null }));
    return () => {
      alive = false;
    };
  }, [id, userId, loadTick]);

  const loading = !room.loaded || !profile.done;
  const loadFailed = room.failed || profile.failed;
  const base = useMemo(() => answerDraft(questions, profile.answers), [questions, profile.answers]);
  const current = useMemo(() => ({ ...base, ...edits }), [base, edits]);
  const ready = !loading && !loadFailed && questions.length > 0;
  // UI audit (6): a room without questions shows a short explanation and no Save.
  const empty = !loading && !loadFailed && questions.length === 0;
  const dirty = ready && answersDirty(base, current);

  const list: Field[] = useMemo(
    () =>
      questions.flatMap<Field>((q) =>
        q.kind === 'links' ? Array.from({ length: ANSWER_LIMITS.links }, (_, slot) => ({ q, slot })) : [{ q, slot: null }],
      ),
    [questions],
  );

  // After the inline error is rendered: bring its question's first field and the error into view.
  useEffect(() => {
    if (!invalid) return;
    const field = fields.current[list.findIndex((f) => f.q.id === invalid.questionId)];
    if (field) revealRef.current?.(field, errorRef.current);
  }, [invalid, list]);

  // `repeat` turns prevention off and then runs the blocked action (dispatching alone would be blocked again).
  usePreventRemove(dirty && !busy && !saved, ({ repeat }) => {
    Alert.alert(s.discardTitle, s.discardBody, [
      { text: s.keepEditing, style: 'cancel' },
      { text: s.discard, style: 'destructive', onPress: repeat },
    ]);
  });

  useEffect(() => {
    if (!saved) return;
    if (gate === '1') router.replace({ pathname: '/room/[id]', params: { id } });
    else router.back();
  }, [saved, gate, id, router]);

  function retry() {
    setProfile({ done: false, failed: false, answers: null });
    setEdits({});
    setLoadTick((n) => n + 1);
    room.reload();
  }

  function setAnswer({ q, slot }: Field, text: string) {
    if (invalid?.questionId === q.id) setInvalid(null);
    setEdits((cur) => {
      if (slot === null) return { ...cur, [q.id]: text };
      const prev = (cur[q.id] ?? base[q.id]) as string[];
      return { ...cur, [q.id]: prev.map((v, j) => (j === slot ? text : v)) };
    });
  }

  async function save() {
    if (busy || saved || !ready) return;
    const checked = validateAnswers(questions, current);
    if ('problem' in checked) {
      // Inline under that question, scrolled into view by the effect above; focus goes to its first field.
      const q = questions.find((x) => x.id === checked.questionId);
      setInvalid({ questionId: checked.questionId, text: problemText(checked.problem, q) });
      setError(null);
      fields.current[list.findIndex((f) => f.q.id === checked.questionId)]?.focus();
      return;
    }
    setInvalid(null);
    setBusy(true);
    setError(null);
    const res = await saveEntryAnswers(id, checked.value);
    setBusy(false);
    if ('error' in res) {
      setError(res.error === 'network' ? en.qrewing.errors.network : s.saveFailed);
      return;
    }
    setSaved(true);
  }

  return (
    <QScreen
      title={s.title}
      subtitle={empty ? undefined : s.intro}
      keepVisible={errorRef}
      revealRef={revealRef}
      actions={
        empty ? undefined : (
          <>
            {error ? <Hint tone="error">{error}</Hint> : null}
            {loadFailed ? (
              <Button title={s.retry} variant="secondary" onPress={retry} />
            ) : (
              <Button title={s.save} onPress={save} busy={busy} disabled={!ready} />
            )}
          </>
        )
      }
    >
      <Stack.Screen
        options={{
          title: s.title,
          headerTitle: '',
          // qa F1: Save stays reachable from the header while the keyboard covers the bottom.
          headerRight: () =>
            !ready ? null : (
              <Pressable
                onPress={save}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy, busy }}
                style={styles.headerHit}
              >
                <Text style={[styles.headerSave, busy && styles.headerSaveBusy]}>{s.save}</Text>
              </Pressable>
            ),
        }}
      />
      {loading ? (
        <ActivityIndicator />
      ) : loadFailed ? (
        <Hint tone="error">{room.failed ? s.questionsLoadFailed : s.loadFailed}</Hint>
      ) : empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{s.noQuestions}</Text>
          <Hint>{s.noQuestionsBody}</Hint>
        </View>
      ) : (
        list.map((field, i) => {
          const { q, slot } = field;
          const last = i === list.length - 1;
          const value = current[q.id];
          const text = slot === null ? (value as string) : (value as string[])[slot];
          const links = slot !== null;
          const end = !links || slot === ANSWER_LIMITS.links - 1;
          return (
            <FieldBlock
              key={`${q.id}:${slot ?? ''}`}
              q={q}
              first={!links || slot === 0}
              end={end}
              error={end && invalid?.questionId === q.id ? invalid.text : null}
              errorRef={errorRef}
            >
              <QField
                label={links ? `${q.prompt} ${slot + 1}` : q.prompt}
                placeholder={links ? s.linkPlaceholderN(slot + 1) : undefined}
                value={text}
                onChangeText={(t) => setAnswer(field, t)}
                maxLength={links ? ANSWER_LIMITS.link : answerLimit(q.kind)}
                multiline={q.kind === 'long'}
                {...(links
                  ? { autoCapitalize: 'none' as const, autoCorrect: false, keyboardType: 'url' as const, textContentType: 'URL' as const }
                  : {})}
                ref={(r) => {
                  fields.current[i] = r;
                }}
                returnKeyType={last ? 'done' : 'next'}
                submitBehavior={last ? 'blurAndSubmit' : 'submit'}
                onSubmitEditing={() => (last ? save() : fields.current[i + 1]?.focus())}
              />
            </FieldBlock>
          );
        })
      )}
    </QScreen>
  );
}

/**
 * The question's label above its first field (a red * after required questions, spec 9.4 R2), and under its last
 * field the links note and the question's inline error.
 */
function FieldBlock({
  q,
  first,
  end,
  error,
  errorRef,
  children,
}: {
  q: EntryQuestion;
  first: boolean;
  end: boolean;
  error: string | null;
  children: ReactNode;
  errorRef: RefObject<ComponentRef<typeof View> | null>;
}) {
  return (
    <>
      {first ? (
        q.required ? (
          <Text style={styles.label} accessibilityRole="header" accessibilityLabel={`${q.prompt}, ${s.requiredMark}`}>
            {q.prompt}
            <Text style={styles.star} accessibilityLabel={s.requiredMark}>
              {' *'}
            </Text>
          </Text>
        ) : (
          <QLabel>{q.prompt}</QLabel>
        )
      ) : null}
      {children}
      {end && q.kind === 'links' ? <Text style={styles.note}>{s.linksNote}</Text> : null}
      {error ? (
        <View ref={errorRef}>
          <Hint tone="error">{error}</Hint>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 13, color: colors.secondaryLabel },
  // Matches QLabel (q-screen.tsx), which only takes a plain string.
  label: { fontSize: 12, color: colors.secondaryLabel, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 6 },
  star: { color: colors.danger },
  headerHit: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  empty: { gap: 8, paddingTop: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.label },
  headerSave: { fontSize: 17, fontWeight: '600', color: colors.tint, paddingHorizontal: 8 },
  headerSaveBusy: { opacity: 0.4 },
});
