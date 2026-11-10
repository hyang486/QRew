import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useInk } from '@/components/hand-title';
import { colors } from '@/components/ui';

/**
 * Qrew unit 5: a pale card with a leading icon, a title and a small gray line (Q 07.01 "Mia Chen / Display name",
 * Q 03.03 "12 people / 8 arrived · View participants ›"). With onPress it is a button with a chevron.
 */
export function QRowCard({
  icon,
  leading,
  title,
  subtitle,
  value,
  onPress,
  busy,
  accessibilityLabel,
  accessibilityHint,
  expanded,
}: {
  /** SF Symbol name for the leading icon. */
  icon?: string;
  /** A custom leading view (an avatar) instead of the icon. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Gray text at the trailing edge (Language "English"). */
  value?: string;
  onPress?: () => void;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** For a card that shows and hides a section below it. */
  expanded?: boolean;
}) {
  const ink = useInk();
  const body = (
    <>
      {leading ?? (icon ? <SymbolView name={icon as never} size={24} tintColor={ink} style={styles.icon} /> : null)}
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={styles.value}>{value}</Text> : null}
      {busy ? (
        <ActivityIndicator />
      ) : onPress ? (
        <SymbolView
          name={expanded === undefined ? 'chevron.right' : expanded ? 'chevron.up' : 'chevron.down'}
          size={14}
          weight="semibold"
          tintColor={colors.secondaryLabel}
        />
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.card} accessible accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: !!busy, disabled: !!busy, expanded }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
    >
      {body}
    </Pressable>
  );
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
    paddingVertical: 14,
    minHeight: 56,
  },
  icon: { width: 28, height: 28 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 17, color: colors.label },
  subtitle: { fontSize: 13, color: colors.secondaryLabel },
  value: { fontSize: 17, color: colors.secondaryLabel },
});
