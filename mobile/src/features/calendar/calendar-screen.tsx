/**
 * Qrewing Calendar (human FINAL 2026-11-13; tiers FINAL 2026-11-13 PM): a hand-drawn month with my rooms (hosted
 * or joined; past, current, future) as highlighter strokes and my own events. Phone-only data. Free and Plus: the
 * month, "+" to add, and a tap on my event's bar opens its editor. A room's bar or icon opens its diary card on Plus
 * and the Plus upsell on Free. "+N" lists that day's items. Plus only: the Qrewing button adds an event from a
 * sentence. All interaction is on the grid (no day list).
 */
import { useFonts } from 'expo-font';
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DayItemsSheet,
  DiaryCard,
  HighlighterStroke,
  highlighterFor,
  PlusUpsellCard,
  primarySegments,
  SketchyMonthGrid,
  useCalendarColors,
} from '@/components/calendar';
import { HAND_FONTS } from '@/components/hand-title';
import { QScreen } from '@/components/q-screen';
import { Button, colors, Hint } from '@/components/ui';
import { useAnnounce } from '@/features/event/announce';
import { calendarAdd } from '@/features/event/qrewing-api';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { HAND_FONT_LATIN, handFontFor } from '@/lib/hand-font';
import { useNow } from '@/lib/use-now';

import { calendarGate, calendarItems, parseCalendarAdd, type RoomSnapshot } from './calendar-data';
import { dayTitle, diaryText, monthTitle, rangeLabel, spokenJoin, weekdayLabels } from './calendar-format';
import {
  barAction,
  type CalItem,
  cellOf,
  type DateKey,
  isPastRoom,
  itemAction,
  itemsOnDay,
  keyOf,
  layoutMonth,
  localDateKey,
  MAX_LANES,
  monthGrid,
  overflowByDay,
  shiftMonth,
} from './calendar-plan';
import { useCalendar, usePlusPreview } from './calendar-store';

const t = en.calendar;
const ART = require('../../../assets/images/icon.png');
const CELL_H = 74;
const DAY_H = 20;
const STROKE_H = 14;
const LANE_PITCH = STROKE_H + 2;

export function CalendarScreen() {
  const uid = useAuth().session?.user.id;
  // Signed out: the root auth redirect takes over; nothing to show here.
  if (calendarGate(!!uid) === 'signedOut') return <ActivityIndicator style={styles.loading} />;
  return <CalendarMonth uid={uid!} />;
}

function CalendarMonth({ uid }: { uid: string }) {
  // Plus preview flag: null while unread (room taps wait), then Free or Plus.
  const plus = usePlusPreview(uid);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const palette = useCalendarColors();
  // Month, weekday and date numbers in the hand font (human FINAL 10:50); system font until it loads.
  const [handLoaded] = useFonts(HAND_FONTS);
  const hand = (text: string) => (handLoaded ? { fontFamily: handFontFor(text) } : null);
  const handNum = handLoaded ? { fontFamily: HAND_FONT_LATIN } : null;
  const doc = useCalendar(uid);
  const now = useNow(60_000);
  const today = localDateKey(now);
  const [month, setMonth] = useState(() => ({ year: +today.slice(0, 4), month0: +today.slice(5, 7) - 1 }));
  const [width, setWidth] = useState(0);
  const [diary, setDiary] = useState<RoomSnapshot | null>(null);
  const [upsell, setUpsell] = useState<RoomSnapshot | null>(null);
  const [sheetDay, setSheetDay] = useState<DateKey | null>(null);
  const [asking, setAsking] = useState(false);

  const grid = useMemo(() => monthGrid(month.year, month.month0), [month]);
  const items = useMemo(() => (doc ? calendarItems(doc) : []), [doc]);
  const segments = useMemo(() => layoutMonth(items, grid), [items, grid]);
  const overflow = useMemo(() => overflowByDay(segments, grid), [segments, grid]);
  const shown = useMemo(() => segments.filter((s) => s.lane < MAX_LANES), [segments]);
  const a11yFirst = useMemo(() => primarySegments(shown), [shown]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const weekdays = useMemo(() => weekdayLabels(0), []);
  const cellW = width / 7;
  const thisYear = +today.slice(0, 4);

  // A current or future room has no diary yet (Plus).
  function diaryLines(room: RoomSnapshot): string[] {
    return isPastRoom(room, now) ? diaryText(room.diary, t.diaryNone) : [t.diaryLater];
  }

  function roomOf(item: CalItem): RoomSnapshot | null {
    return item.kind === 'room' && doc ? (doc.rooms[item.id.slice('room:'.length)] ?? null) : null;
  }

  // Tiers FINAL: room → diary (Plus) or upsell (Free, never the diary text); my event → editor.
  function openItem(item: CalItem) {
    setSheetDay(null);
    const action = itemAction(item.kind, plus);
    if (action === 'edit') return router.push({ pathname: '/calendar-event', params: { id: item.id.slice('event:'.length) } });
    const room = roomOf(item);
    if (!room || !action) return;
    if (action === 'diary') setDiary(room);
    else setUpsell(room);
  }

  function itemLabel(item: CalItem): string {
    return t.barLabel(item.title, rangeLabel(item.start, item.end, thisYear), barAction(item.kind, plus));
  }

  const go = (by: number) => setMonth((m) => shiftMonth(m.year, m.month0, by));
  const sheetItems = sheetDay ? itemsOnDay(items, sheetDay) : [];

  return (
    <>
      <Stack.Screen
        options={{
          // The calendar paper (light and dark, calendar tokens) behind the whole screen, header included.
          headerStyle: { backgroundColor: palette.paper },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.paper },
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.add}
              onPress={() => router.push('/calendar-event')}
              style={styles.headerIcon}
            >
              <SymbolView name="plus" size={22} tintColor={colors.tint} />
            </Pressable>
          ),
        }}
      />
      <QScreen
        title={t.title}
        background={palette.paper}
        floating={
          // "Add with Qrewing" is Plus only (tiers FINAL); Free sees no button and makes no server call.
          plus !== true ? undefined : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.ask}
            onPress={() => setAsking(true)}
            style={[styles.fab, { bottom: Math.max(insets.bottom, 12) + 12, right: insets.right + 16 }]}
          >
            <Image source={ART} style={styles.fabArt} contentFit="cover" accessibilityIgnoresInvertColors />
            <View style={styles.fabRing} pointerEvents="none" />
          </Pressable>
          )
        }
      >
        <View style={styles.nav}>
          <Pressable accessibilityRole="button" accessibilityLabel={t.prevMonth} onPress={() => go(-1)} style={styles.navBtn}>
            <SymbolView name="chevron.left" size={20} tintColor={colors.label} />
          </Pressable>
          <Text style={[styles.month, { color: palette.ink }, hand(monthTitle(grid.year, grid.month0))]} accessibilityRole="header">
            {monthTitle(grid.year, grid.month0)}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t.nextMonth} onPress={() => go(1)} style={styles.navBtn}>
            <SymbolView name="chevron.right" size={20} tintColor={colors.label} />
          </Pressable>
        </View>
        <View style={styles.weekdays} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {weekdays.map((w, i) => (
            <Text key={i} style={[styles.weekday, { color: palette.ink }, hand(w)]}>
              {w}
            </Text>
          ))}
        </View>
        <View
          style={[styles.grid, { height: grid.rows * CELL_H, backgroundColor: palette.paper }]}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          {width > 0 ? (
            <>
              <SketchyMonthGrid weeks={grid.rows} cellWidth={cellW} cellHeight={CELL_H} seed={`${grid.year}-${grid.month0}`} />
              {Array.from({ length: grid.days }, (_, i) => {
                const day = i + 1;
                const key = keyOf(grid.year, grid.month0, day);
                const { row, col } = cellOf(grid, day);
                const more = overflow.get(day) ?? 0;
                // Day cells are not tap targets (tiers FINAL): the bars and "+N" are. VoiceOver reads the bars.
                return (
                  <View
                    key={key}
                    pointerEvents="box-none"
                    style={[styles.cell, { left: col * cellW, top: row * CELL_H, width: cellW, height: CELL_H }]}
                  >
                    <Text
                      style={[styles.dayNum, { color: palette.ink }, handNum, key === today && styles.today]}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    >
                      {day}
                    </Text>
                    {more > 0 ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t.moreLabel(more, dayTitle(key))}
                        onPress={() => setSheetDay(key)}
                        hitSlop={10}
                        style={styles.more}
                      >
                        <Text style={[styles.moreText, { color: palette.ink }, handNum]}>{t.more(more)}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
              {shown.map((s) => {
                  const item = byId.get(s.itemId)!;
                  return (
                    <View
                      key={`${s.itemId}:${s.row}`}
                      pointerEvents="box-none"
                      style={{
                        position: 'absolute',
                        left: s.colStart * cellW + 2,
                        top: s.row * CELL_H + DAY_H + s.lane * LANE_PITCH,
                      }}
                    >
                      <HighlighterStroke
                        width={(s.colEnd - s.colStart + 1) * cellW - 4}
                        height={STROKE_H}
                        color={highlighterFor(palette, s.itemId)}
                        startCap={s.capStart ? 'round' : 'flat'}
                        endCap={s.capEnd ? 'round' : 'flat'}
                        seed={`${s.itemId}:${s.row}`}
                        emoji={s.emoji ? item.emoji : undefined}
                        lanePitch={LANE_PITCH}
                        onPress={() => openItem(item)}
                        accessibilityLabel={itemLabel(item)}
                        a11yPrimary={a11yFirst.has(`${s.itemId}:${s.row}`)}
                      />
                    </View>
                  );
                })}
            </>
          ) : null}
        </View>

      </QScreen>

      <Modal visible={!!diary} transparent animationType="fade" onRequestClose={() => setDiary(null)}>
        {/* The close scrim is a sibling behind the card: a Pressable wrapping the card would make VoiceOver read
            only "Close diary" and never the diary itself. */}
        <View style={styles.scrim} accessibilityViewIsModal onAccessibilityEscape={() => setDiary(null)}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t.diaryClose}
            onPress={() => setDiary(null)}
          />
          {diary ? (
            <DiaryCard
              width={Math.min(360, width + 24 || 340)}
              title={diary.name}
              icon={diary.emoji}
              dateLine={rangeLabel(diary.start, diary.end, thisYear)}
              lines={diaryLines(diary)}
              accessibilityLabel={spokenJoin([diary.name, rangeLabel(diary.start, diary.end, thisYear), ...diaryLines(diary)])}
            />
          ) : null}
        </View>
      </Modal>

      <PlusUpsellCard
        visible={!!upsell}
        roomName={upsell?.name ?? ''}
        rangeLabel={upsell ? rangeLabel(upsell.start, upsell.end, thisYear) : ''}
        icon={upsell?.emoji}
        onSeePlus={() => {
          setUpsell(null);
          router.push('/plan-preview');
        }}
        onClose={() => setUpsell(null)}
      />

      <DayItemsSheet
        visible={!!sheetDay}
        dateLabel={sheetDay ? dayTitle(sheetDay) : ''}
        items={sheetItems.map((i) => ({ key: i.id, title: i.title, icon: i.emoji, kind: i.kind, a11yLabel: itemLabel(i) }))}
        onPick={(key) => {
          const item = byId.get(key);
          if (item) openItem(item);
        }}
        onClose={() => setSheetDay(null)}
      />

      <AskSheet visible={asking} onClose={() => setAsking(false)} today={today} />
    </>
  );
}

/** Bottom-right Qrewing: one sentence → calendar_add → the event editor prefilled to confirm and save. */
function AskSheet({ visible, onClose, today }: { visible: boolean; onClose: () => void; today: DateKey }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useAnnounce(error, tries);
  useAnnounce(busy ? t.askBusy : null, busy);

  function close() {
    setError(null);
    onClose();
  }

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await calendarAdd(text, today, tz);
    setBusy(false);
    const ev = 'data' in res ? parseCalendarAdd(res.data) : null;
    if (!ev) {
      const code = 'error' in res ? res.error : 'other';
      setError(code === 'unclear' ? t.askErrors.unclear : code === 'rate_limited' ? t.askErrors.rate_limited : t.askErrors.other);
      setTries((n) => n + 1);
      return;
    }
    setText('');
    onClose();
    router.push({ pathname: '/calendar-event', params: { ...ev, ask: '1' } });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={close}>
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle} accessibilityRole="header">
            {t.askTitle}
          </Text>
          <Pressable accessibilityRole="button" onPress={close} style={styles.headerIcon}>
            <Text style={styles.cancel}>{t.cancel}</Text>
          </Pressable>
        </View>
        <TextInput
          value={text}
          onChangeText={(v) => {
            setText(v);
            setError(null);
          }}
          placeholder={t.askPlaceholder}
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel={t.askTitle}
          maxLength={300}
          multiline
          autoFocus
          style={styles.askField}
        />
        {busy ? <Hint>{t.askBusy}</Hint> : null}
        {error ? <Hint tone="error">{error}</Hint> : null}
        <Button title={t.askSend} onPress={send} busy={busy} disabled={!text.trim()} />
      </View>
    </Modal>
  );
}

const FAB = 56;

const styles = StyleSheet.create({
  loading: { marginTop: 80 },
  headerIcon: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  month: { flex: 1, textAlign: 'center', fontSize: 24 },
  weekdays: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 16, opacity: 0.6 },
  grid: { position: 'relative', borderRadius: 8 },
  cell: { position: 'absolute', paddingTop: 2, paddingHorizontal: 4 },
  dayNum: { fontSize: 16, lineHeight: 18 },
  today: { textDecorationLine: 'underline' },
  more: { position: 'absolute', right: 2, top: 0, minWidth: 24, alignItems: 'flex-end', paddingHorizontal: 2 },
  moreText: { fontSize: 13, lineHeight: 18 },
  fab: { position: 'absolute', width: FAB, height: FAB, borderRadius: FAB / 2 },
  fabArt: { width: '100%', height: '100%', borderRadius: FAB / 2 },
  fabRing: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: FAB / 2, borderWidth: 1.5, borderColor: colors.label },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', padding: 16 },
  sheet: { flex: 1, padding: 24, gap: 12, backgroundColor: colors.background },
  sheetHead: { flexDirection: 'row', alignItems: 'center' },
  sheetTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: colors.label },
  cancel: { fontSize: 17, color: colors.tint },
  askField: {
    minHeight: 96,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.separator,
    borderRadius: 12,
    padding: 14,
    fontSize: 17,
    color: colors.label,
    textAlignVertical: 'top',
  },
});
