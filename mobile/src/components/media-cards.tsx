import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/components/ui';
import { en } from '@/i18n/en';

/** Pale Q card with an icon, a line and a gray line under it (Q 05.04 "Original saved", Q 06.03 "Room closes in"). */
function NoticeCard({
  symbol,
  title,
  body,
  onDismiss,
}: {
  symbol: SymbolViewProps['name'];
  title: string;
  body: string;
  onDismiss?: () => void;
}) {
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <SymbolView name={symbol} size={22} tintColor={colors.label} />
      <View style={styles.text} accessible accessibilityLabel={`${title} ${body}`}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={en.media.dismissSaved} hitSlop={10}>
          <SymbolView name="xmark" size={14} tintColor={colors.secondaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Q 05.04: a verified original was saved; it stays on the device after the room closes. */
export function SavedCard({ onDismiss }: { onDismiss?: () => void }) {
  return <NoticeCard symbol="checkmark" title={en.media.savedTitle} body={en.media.savedBody} onDismiss={onDismiss} />;
}

/** Q 06.03: "Room closes in 57 min / Save originals before 10:00 PM." */
export function ClosesSoonCard({ minutes, time }: { minutes: number; time: string }) {
  return <NoticeCard symbol="clock" title={en.media.closesIn(minutes)} body={en.media.saveBefore(time)} />;
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 16, color: colors.label },
  body: { fontSize: 13, color: colors.secondaryLabel },
});
