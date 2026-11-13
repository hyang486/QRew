import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useAnnounce } from '@/features/event/announce';
import { QCard, QField, QLabel, QLink } from '@/components/q-screen';
import { colors, Hint, radius } from '@/components/ui';
import { en } from '@/i18n/en';

import {
  addQuestion,
  canAdd,
  canRemove,
  type DraftQuestion,
  type EntryQuestionKind,
  moveQuestion,
  QUESTION_KINDS,
  QUESTION_LIMITS,
  type QuestionProblem,
  removeQuestion,
  updateQuestion,
} from './entry-questions';

const s = en.qrewing.create;

const KIND_LABEL: Record<EntryQuestionKind, string> = { short: s.kindShort, long: s.kindLong, links: s.kindLinks };

/** The editor's inline error for a validateQuestions problem (n is the question's 1-based number). */
export function questionProblemText(problem: QuestionProblem, n: number | null): string {
  switch (problem) {
    case 'noQuestions':
      return s.noQuestions;
    case 'tooManyQuestions':
      return s.tooManyQuestions(QUESTION_LIMITS.max);
    case 'promptRequired':
      return s.promptRequired(n ?? 1);
    case 'promptTooLong':
      return s.promptTooLong(n ?? 1, QUESTION_LIMITS.prompt);
  }
}

function IconButton({ name, label, disabled, onPress }: { name: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.icon, (pressed || disabled) && { opacity: 0.35 }]}
    >
      <SymbolView name={name as never} size={18} tintColor={colors.label} />
    </Pressable>
  );
}

/**
 * Create room's entry question list (spec 9.4): edit the text, pick the answer kind, mark it required, move it up
 * or down, remove it, add one. 1 to 8 questions; `problem` points at the question the inline error is about.
 */
export function QuestionEditor({
  value,
  onChange,
  problem,
}: {
  value: DraftQuestion[];
  onChange: (next: DraftQuestion[]) => void;
  problem: { problem: QuestionProblem; key?: string } | null;
}) {
  const removable = canRemove(value);
  const problemIndex = problem?.key ? value.findIndex((q) => q.key === problem.key) : -1;
  useAnnounce(problem ? questionProblemText(problem.problem, problemIndex >= 0 ? problemIndex + 1 : null) : null, problem);
  return (
    <>
      <QLabel>{s.questionsTitle}</QLabel>
      <Hint>{s.questionsHint}</Hint>
      {value.map((q, i) => {
        const n = i + 1;
        const mine = problem?.key === q.key ? problem : null;
        return (
          <QCard key={q.key}>
            <View style={styles.head}>
              <Text style={styles.number}>{s.promptLabel(n)}</Text>
              <IconButton name="chevron.up" label={s.moveUp(n)} disabled={i === 0} onPress={() => onChange(moveQuestion(value, q.key, -1))} />
              <IconButton
                name="chevron.down"
                label={s.moveDown(n)}
                disabled={i === value.length - 1}
                onPress={() => onChange(moveQuestion(value, q.key, 1))}
              />
              <IconButton name="trash" label={s.remove(n)} disabled={!removable} onPress={() => onChange(removeQuestion(value, q.key))} />
            </View>
            <QField
              label={s.promptLabel(n)}
              placeholder={s.promptPlaceholder}
              value={q.prompt}
              onChangeText={(prompt) => onChange(updateQuestion(value, q.key, { prompt }))}
              maxLength={QUESTION_LIMITS.prompt}
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
            />
            <View style={styles.kinds} accessibilityRole="radiogroup">
              {QUESTION_KINDS.map((kind) => {
                const selected = q.kind === kind;
                return (
                  <Pressable
                    key={kind}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => onChange(updateQuestion(value, q.key, { kind }))}
                    style={[styles.chip, selected && { backgroundColor: colors.tint }]}
                  >
                    <Text style={[styles.chipText, selected && { color: colors.onTint }]}>{KIND_LABEL[kind]}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>{s.required}</Text>
              <Switch
                value={q.required}
                onValueChange={(required) => onChange(updateQuestion(value, q.key, { required }))}
                accessibilityLabel={`${s.promptLabel(n)} ${s.required}`}
              />
            </View>
            {mine ? <Hint tone="error">{questionProblemText(mine.problem, n)}</Hint> : null}
          </QCard>
        );
      })}
      {problem && !problem.key ? <Hint tone="error">{questionProblemText(problem.problem, null)}</Hint> : null}
      {canAdd(value) ? <QLink title={s.add} onPress={() => onChange(addQuestion(value, 'short'))} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  number: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.label },
  // 44 pt target without hitSlop, so neighbouring icons never overlap.
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.field,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 9,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, color: colors.label },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowTitle: { flex: 1, fontSize: 16, color: colors.label },
});
