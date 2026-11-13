import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { Button, colors, Hint } from '@/components/ui';

import { setQrewingMember } from './qrewing-api';
import { en } from '@/i18n/en';

const s = en.qrewing.disclosure;

/**
 * Qrewing AI disclosure (spec 3.2), shown on a member's first open of an AI room. Both answers create the
 * member's row, so it is not shown again; "Not now" keeps their messages out of every AI call. Swiping the sheet
 * down counts as Not now for this visit only (nothing is saved, so it shows again on the next open).
 */
export function DisclosureSheet({
  roomId,
  visible,
  onDone,
  onClose,
}: {
  roomId: string;
  visible: boolean;
  /** An answer was saved. */
  onDone: () => void;
  /** Swiped down without answering. */
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<'agree' | 'later' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(agree: boolean) {
    setBusy(agree ? 'agree' : 'later');
    setError(null);
    const res = await setQrewingMember(roomId, agree, false);
    setBusy(null);
    if (res.error) {
      setError(res.offline ? en.qrewing.errors.network : s.failed);
      return;
    }
    onDone();
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <ScrollView contentContainerStyle={styles.body}>
          <HandTitle style={styles.title}>{s.title}</HandTitle>
          {s.body.map((line) => (
            <Text key={line} style={styles.line}>
              {line}
            </Text>
          ))}
        </ScrollView>
        <View style={styles.actions}>
          {error ? <Hint tone="error">{error}</Hint> : null}
          <Button title={s.agree} onPress={() => answer(true)} busy={busy === 'agree'} disabled={busy !== null} />
          <Button title={s.notNow} variant="secondary" onPress={() => answer(false)} busy={busy === 'later'} disabled={busy !== null} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { paddingHorizontal: 24, paddingTop: 32, gap: 14 },
  title: { fontSize: 28, lineHeight: 36 },
  line: { fontSize: 16, lineHeight: 23, color: colors.label },
  actions: { paddingHorizontal: 24, gap: 10 },
});
