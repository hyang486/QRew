import { useFonts } from 'expo-font';
import { SymbolView } from 'expo-symbols';
import { Fragment } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HAND_FONTS } from '@/components/hand-title';
import { colors } from '@/components/ui';
import { en } from '@/i18n/en';
import { handFontFor } from '@/lib/hand-font';

import { InkIcon } from './ink-icon';
import { PencilDivider } from './pencil-divider';
import { useCalendarColors } from './tokens';

const t = en.calendar;

export type DayItem = { key: string; title: string; icon?: string; kind: 'room' | 'event'; a11yLabel: string };

/**
 * Calendar tiers (human FINAL 2026-11-13 PM): "+N" on a day opens every item on that day. A row tap calls onPick with
 * the item key; the screen decides what opens and closes this sheet (it does not close itself).
 */
export function DayItemsSheet({
  visible,
  dateLabel,
  items,
  onPick,
  onClose,
}: {
  visible: boolean;
  dateLabel: string;
  items: DayItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [loaded] = useFonts(HAND_FONTS);
  const palette = useCalendarColors();
  const hand = (text: string) => (loaded ? { fontFamily: handFontFor(text) } : null);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.sheet, { backgroundColor: palette.paper }]}>
        <View style={styles.head}>
          <View style={styles.flex}>
            <Text style={[styles.date, { color: palette.ink }, hand(dateLabel)]} accessibilityRole="header">
              {dateLabel}
            </Text>
            <Text style={[styles.sub, { color: palette.ink }]}>{t.dayItemsTitle(items.length)}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>{t.dayItemsClose}</Text>
          </Pressable>
        </View>
        <PencilDivider seed={`sheet:${dateLabel}`} />
        <ScrollView contentContainerStyle={styles.list}>
          {items.map((item, i) => (
            <Fragment key={item.key}>
              {i > 0 ? <PencilDivider seed={item.key} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.a11yLabel}
                onPress={() => onPick(item.key)}
                style={styles.row}
              >
                <InkIcon emoji={item.icon} size={24} />
                <View style={styles.flex}>
                  <Text style={[styles.title, { color: palette.ink }, hand(item.title)]} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text style={[styles.kind, { color: palette.ink }]}>{t.dayItemsKind[item.kind]}</Text>
                </View>
                <SymbolView name="chevron.right" size={14} tintColor={colors.secondaryLabel} />
              </Pressable>
            </Fragment>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 24, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  date: { fontSize: 24 },
  sub: { fontSize: 13, opacity: 0.7 },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 17, color: colors.tint },
  list: { gap: 8, paddingBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  title: { fontSize: 19 },
  kind: { fontSize: 13, opacity: 0.7 },
});
