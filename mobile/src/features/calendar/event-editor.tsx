/**
 * Qrewing Calendar personal event: add ("+"), edit or delete my own event, or confirm one Qrewing read from a
 * sentence (`ask=1` with title/start/end/emoji params). Dates only; saved on this phone.
 */
import { DatePicker, Host } from '@expo/ui/swift-ui';
import { labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { useFonts } from 'expo-font';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { InkIcon, inkIconKey, inkIconLabel, useCalendarColors } from '@/components/calendar';
import { HAND_FONTS } from '@/components/hand-title';
import { QField, QLabel, QScreen } from '@/components/q-screen';
import { Button, colors, Hint, radius } from '@/components/ui';
import { useAnnounce } from '@/features/event/announce';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { handFontFor } from '@/lib/hand-font';
import { useNow } from '@/lib/use-now';

import { checkEvent, EVENT_TITLE_MAX } from './calendar-data';
import { keyToLocalDate, localDateToKey } from './calendar-format';
import { isDateKey, localDateKey } from './calendar-plan';
import { removeEvent, saveEvent, useCalendar } from './calendar-store';

const t = en.calendar;

/** A small curated set; Qrewing's pick is added in front when it isn't in the list. */
export const EVENT_EMOJIS = ['📌', '🎂', '🍽️', '☕', '🏃', '🚴', '⚽', '🎉', '🎵', '📚', '✈️', '🏖️', '🏥', '💼', '🛒', '❤️'];

export function EventEditor() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; title?: string; start?: string; end?: string; emoji?: string; ask?: string }>();
  const uid = useAuth().session?.user.id;
  const doc = useCalendar(uid);
  const paper = useCalendarColors().paper;
  const existing = params.id ? doc?.events.find((e) => e.id === params.id) : undefined;
  const today = localDateKey(useNow(60_000));
  const [title, setTitle] = useState(existing?.title ?? params.title ?? '');
  const [start, setStart] = useState(existing?.start ?? (isDateKey(params.start) ? params.start : today));
  const [end, setEnd] = useState(existing?.end ?? (isDateKey(params.end) ? params.end : today));
  const [emoji, setEmoji] = useState(existing?.emoji ?? params.emoji ?? EVENT_EMOJIS[0]);
  const [problem, setProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useAnnounce(problem, tries);
  // An emoji outside the grid (a sentence's pick) shows as the grid icon it maps to; it is kept until another is tapped.
  const picked = inkIconKey(emoji);
  const editing = !!existing;

  async function save() {
    if (!uid) return;
    const input = { title, start, end, emoji };
    const p = checkEvent(input);
    if (p) {
      setProblem(t.problems[p]);
      setTries((n) => n + 1);
      return;
    }
    await saveEvent(uid, existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, input);
    router.back();
  }

  function confirmDelete() {
    if (!uid || !existing) return;
    Alert.alert(t.deleteConfirm, existing.title, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.delete,
        style: 'destructive',
        onPress: () => {
          void removeEvent(uid, existing.id).then(() => router.back());
        },
      },
    ]);
  }

  return (
    <QScreen
      title={editing ? t.editEvent : t.newEvent}
      background={paper}
      subtitle={params.ask === '1' ? t.askConfirm : undefined}
      actions={
        <>
          {problem ? <Hint tone="error">{problem}</Hint> : null}
          <Button title={t.save} onPress={save} />
          {editing ? <Button title={t.delete} variant="destructive" onPress={confirmDelete} /> : null}
        </>
      }
    >
      <Stack.Screen
        options={{
          title: editing ? t.editEvent : t.newEvent,
          headerTitle: '',
          headerStyle: { backgroundColor: paper },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: paper },
        }}
      />
      <QField
        label={t.titleLabel}
        placeholder={t.titlePlaceholder}
        value={title}
        onChangeText={setTitle}
        maxLength={EVENT_TITLE_MAX}
        accessibilityLabel={t.titleLabel}
        returnKeyType="done"
      />
      <DateRow label={t.startLabel} value={start} onChange={(k) => {
        setStart(k);
        if (end < k) setEnd(k);
      }} />
      <DateRow label={t.endLabel} value={end} onChange={setEnd} />
      <QLabel>{t.emojiLabel}</QLabel>
      <View style={styles.emojis} accessibilityRole="radiogroup" accessibilityLabel={t.emojiLabel}>
        {EVENT_EMOJIS.map((e) => (
          <Pressable
            key={e}
            accessibilityRole="radio"
            accessibilityLabel={inkIconLabel(e)}
            accessibilityState={{ selected: inkIconKey(e) === picked }}
            onPress={() => setEmoji(e)}
            style={[styles.emoji, inkIconKey(e) === picked && { borderColor: colors.tint, backgroundColor: colors.field }]}
          >
            <InkIcon emoji={e} size={26} />
          </Pressable>
        ))}
      </View>
    </QScreen>
  );
}

function DateRow({ label, value, onChange }: { label: string; value: string; onChange: (key: string) => void }) {
  // Calendar look: the row label in the hand font, like the calendar (system font until it loads).
  const [handLoaded] = useFonts(HAND_FONTS);
  return (
    <View style={styles.dateRow}>
      {/* One label each way: the row Text is the visible one (hidden from VoiceOver); the picker's title is only
          spoken (labelsHidden), so neither the screen nor VoiceOver says "Starts Starts". */}
      <Text style={[styles.dateLabel, handLoaded ? { fontFamily: handFontFor(label) } : null]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {label}
      </Text>
      <Host matchContents>
        <DatePicker
          title={label}
          selection={keyToLocalDate(value)}
          displayedComponents={['date']}
          onDateChange={(d) => onChange(localDateToKey(d))}
          modifiers={[labelsHidden()]}
        />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  dateRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 12 },
  dateLabel: { flex: 1, fontSize: 19, color: colors.label },
  emojis: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emoji: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: 'transparent',
  },
});
