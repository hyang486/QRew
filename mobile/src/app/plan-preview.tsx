import { Alert, StyleSheet, Switch, Text, View } from 'react-native';

import { Button, colors, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { setPlusPreview, usePlusPreview } from '@/features/calendar/calendar-store';
import { useAuth } from '@/lib/auth';

/**
 * Plus plan preview (APP_CONCEPT_KO: plan and benefit demo only).
 * No purchase, billing, StoreKit or server entitlement is connected. Free values are the current
 * app limits; Plus price, capacity and duration are undecided, so they are shown as TBD.
 */
export default function PlanPreview() {
  const t = en.planPreview;
  const uid = useAuth().session?.user.id;
  const on = usePlusPreview(uid);
  return (
    <Screen>
      <View style={styles.badge} accessibilityRole="text">
        <Text style={styles.badgeText}>{t.badge}</Text>
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {t.heading}
      </Text>
      <Hint>{t.intro}</Hint>

      <View style={styles.table}>
        <View style={[styles.row, styles.headRow]}>
          <Text style={[styles.cellLabel, styles.head]}>{t.benefit}</Text>
          <Text style={[styles.cell, styles.head]}>{t.free}</Text>
          <Text style={[styles.cell, styles.head, styles.plus]}>{t.plus}</Text>
        </View>
        {t.rows.map((row, i) => (
          <View key={row.label} style={[styles.row, i === t.rows.length - 1 && styles.lastRow]}>
            <Text style={styles.cellLabel}>{row.label}</Text>
            <Text style={styles.cell}>{row.free}</Text>
            <Text style={[styles.cell, styles.plusValue]}>{row.plus}</Text>
          </View>
        ))}
      </View>

      <Hint>{t.tbdNote}</Hint>

      <Button title={t.cta} onPress={() => Alert.alert(t.ctaAlertTitle, t.ctaAlertBody)} />
      {uid ? (
        <View style={styles.previewRow}>
          <Text style={styles.previewLabel}>{t.tryPreview}</Text>
          <Switch value={!!on} onValueChange={(v) => void setPlusPreview(uid, v)} accessibilityLabel={t.tryPreview} />
        </View>
      ) : null}
      <Hint>{t.tryPreviewHint}</Hint>
    </Screen>
  );
}

const styles = StyleSheet.create({
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  previewLabel: { flex: 1, fontSize: 16, color: colors.label },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.warning,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  // Black on systemOrange: white text there is below 3:1 contrast.
  badgeText: { color: '#000', fontSize: 13, fontWeight: '700' },
  title: { fontSize: 28, fontWeight: '700', color: colors.label },
  table: { backgroundColor: colors.field, borderRadius: 10, borderCurve: 'continuous', overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  headRow: { paddingVertical: 8 },
  lastRow: { borderBottomWidth: 0 },
  head: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  cellLabel: { flex: 1.3, fontSize: 16, color: colors.label },
  cell: { flex: 1, fontSize: 16, color: colors.secondaryLabel },
  plus: { color: colors.tint },
  plusValue: { color: colors.label, fontWeight: '600' },
});
