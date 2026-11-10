import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { qSpacing } from '@/components/q-screen';
import { colors } from '@/components/ui';
import { en } from '@/i18n/en';

export type AddChoice = 'camera' | 'library' | 'file';

const ROWS: { key: AddChoice; label: string; symbol: SymbolViewProps['name'] }[] = [
  { key: 'camera', label: en.media.addSheetTakePhoto, symbol: 'camera' },
  { key: 'library', label: en.media.addSheetPhotos, symbol: 'photo.on.rectangle' },
  { key: 'file', label: en.media.addSheetFiles, symbol: 'doc.text' },
];

/**
 * Q 05.01 "Add to the room": a bottom sheet with one row per add path the app supports (camera, photo library,
 * files). The choice is reported only after the sheet has finished closing (Modal onDismiss), because UIKit
 * refuses to present the picker or the originals notice over a sheet that is still dismissing.
 */
export function AddMediaSheet({
  visible,
  onClose,
  onChoose,
}: {
  visible: boolean;
  onClose: () => void;
  onChoose: (choice: AddChoice) => void;
}) {
  const insets = useSafeAreaInsets();
  const chosen = useRef<AddChoice | null>(null);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={() => {
        const choice = chosen.current;
        chosen.current = null;
        if (choice) onChoose(choice);
      }}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={en.media.closeSheet}
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <HandTitle style={styles.title}>{en.media.addSheetTitle}</HandTitle>
          {ROWS.map((row) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              onPress={() => {
                chosen.current = row.key;
                onClose();
              }}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.5 }]}
            >
              <SymbolView name={row.symbol} size={24} tintColor={colors.label} style={styles.icon} />
              <Text style={styles.rowText}>{row.label}</Text>
              <SymbolView name="chevron.right" size={13} tintColor={colors.secondaryLabel} />
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderCurve: 'continuous',
    paddingHorizontal: qSpacing.side,
    paddingTop: 8,
    gap: 4,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.separator, marginBottom: 12 },
  title: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 56 },
  icon: { width: 28, height: 28 },
  rowText: { flex: 1, fontSize: 17, color: colors.label },
});
