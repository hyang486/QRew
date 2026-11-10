import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { colors } from '@/components/ui';
import { en } from '@/i18n/en';
import type { StatusDefinition } from '@/lib/activity';
import { statusSymbol } from '@/lib/chat-plan';

/**
 * Q 03.02 "Set your status": a bottom sheet with the room's statuses as an icon + text grid (icon by keyword,
 * a generic icon for custom statuses), Emergency in red, then Clear status and Cancel. Choosing only reports
 * the choice; the caller confirms Emergency and calls the RPC, as before with the action sheet.
 */
export function StatusPicker({
  visible,
  statuses,
  currentId,
  onPick,
  onClear,
  onClose,
}: {
  visible: boolean;
  statuses: StatusDefinition[];
  currentId: string | undefined;
  onPick: (status: StatusDefinition) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} accessibilityLabel={en.room.cancel} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]} accessibilityViewIsModal>
          <View style={styles.handle} />
          {/* flexShrink: inside the sheet's maxHeight the grid scrolls and Cancel stays below it (never over the last row). */}
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body} bounces={false}>
            <HandTitle style={styles.title}>{en.activity.chooseStatus}</HandTitle>
            <View style={styles.grid}>
              {statuses.map((s) => (
                <Tile
                  key={s.id}
                  label={s.label}
                  symbol={statusSymbol(s.label, s.is_emergency) as SFSymbol}
                  danger={s.is_emergency}
                  selected={s.id === currentId}
                  onPress={() => onPick(s)}
                />
              ))}
              <Tile label={en.activity.clearStatus} symbol="checkmark" selected={false} onPress={onClear} />
            </View>
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.5 }]}>
            <Text style={styles.cancelText} maxFontSizeMultiplier={1.5}>
              {en.room.cancel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Tile({
  label,
  symbol,
  danger,
  selected,
  onPress,
}: {
  label: string;
  symbol: SFSymbol;
  danger?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const color = danger ? colors.danger : colors.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        danger && styles.tileDanger,
        selected && styles.tileSelected,
        pressed && { opacity: 0.6 },
      ]}
    >
      <SymbolView name={symbol} size={22} tintColor={color} />
      {/* Dynamic Type capped at 1.4x so one word (Emergency, Resting) fits a half-width tile on the 17e; a longer
          custom label shrinks to fit two lines instead of breaking inside a word. */}
      <Text
        style={[styles.tileText, { color }]}
        numberOfLines={2}
        maxFontSizeMultiplier={1.4}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    maxHeight: '85%',
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderCurve: 'continuous',
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: colors.separator, marginBottom: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 8, gap: 16 },
  title: { fontSize: 30, lineHeight: 38 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    // Two columns (Q 03.02): half the row minus half the gap.
    width: '48.6%',
    minHeight: 64,
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    padding: 12,
    gap: 10,
    justifyContent: 'space-between',
  },
  tileDanger: { backgroundColor: colors.dangerField },
  tileSelected: { borderWidth: 1.5, borderColor: colors.label },
  tileText: { fontSize: 15 },
  cancel: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 24 },
  cancelText: { fontSize: 15, color: colors.secondaryLabel },
});
