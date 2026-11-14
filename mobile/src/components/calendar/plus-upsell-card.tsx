import { useFonts } from 'expo-font';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { HAND_FONTS } from '@/components/hand-title';
import { Button } from '@/components/ui';
import { en } from '@/i18n/en';
import { handFontFor } from '@/lib/hand-font';

import { InkIcon } from './ink-icon';
import { useCalendarColors } from './tokens';

const t = en.calendar;

/**
 * Calendar tiers (human FINAL 2026-11-13 PM): a Free user's tap on a room opens this card, not the diary. It names the
 * room and its dates and offers the Plus preview. It never shows diary text, even one saved earlier.
 */
export function PlusUpsellCard({
  visible,
  roomName,
  rangeLabel,
  icon,
  onSeePlus,
  onClose,
}: {
  visible: boolean;
  roomName: string;
  rangeLabel: string;
  icon?: string;
  onSeePlus: () => void;
  onClose: () => void;
}) {
  const [loaded] = useFonts(HAND_FONTS);
  const palette = useCalendarColors();
  const hand = (text: string) => (loaded ? { fontFamily: handFontFor(text) } : null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The close scrim is a sibling behind the card so VoiceOver reads the card, not only "Close". */}
      <View style={styles.scrim} accessibilityViewIsModal onAccessibilityEscape={onClose}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t.upsellClose} onPress={onClose} />
        <View style={[styles.card, { backgroundColor: palette.paper, borderColor: palette.pencil }]}>
          <View style={styles.roomRow} accessible accessibilityLabel={`${roomName}, ${rangeLabel}`}>
            {icon ? <InkIcon emoji={icon} size={26} /> : null}
            <View style={styles.flex}>
              <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={[styles.room, { color: palette.ink }, hand(roomName)]}>
                {roomName}
              </Text>
              <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={[styles.range, { color: palette.ink }]}>
                {rangeLabel}
              </Text>
            </View>
          </View>
          <Text style={[styles.title, { color: palette.ink }]} accessibilityRole="header">
            {t.upsellCardTitle}
          </Text>
          <Text style={[styles.body, { color: palette.ink }]}>{t.upsellCardBody}</Text>
          <Button title={t.upsellSeePlus} onPress={onSeePlus} />
          <Button title={t.upsellClose} variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', padding: 16 },
  card: { width: '100%', maxWidth: 360, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth * 2, padding: 20, gap: 12 },
  flex: { flex: 1 },
  roomRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  room: { fontSize: 22 },
  range: { fontSize: 14, opacity: 0.7 },
  title: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21 },
});
