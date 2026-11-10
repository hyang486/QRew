import { useRef } from 'react';
import { Linking, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HandTitle } from '@/components/hand-title';
import { QLink, qSpacing } from '@/components/q-screen';
import { Button, colors } from '@/components/ui';
import { en } from '@/i18n/en';
import { mapsUrl, type LatLng } from '@/lib/place-time';

type MapsApp = 'apple' | 'google';

/**
 * Q 08.02 "Open meeting location": a bottom sheet with Open in Apple Maps / Open in Google Maps (outlined) and a
 * Cancel text link, in the style of the Q 05.01 add sheet. The chosen app opens after the sheet has closed
 * (Modal onDismiss), so the hand-off to Maps never races the dismiss animation.
 */
export function MapsSheet({
  target,
  onClose,
}: {
  target: { placeName: string; pin: LatLng | null } | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const chosen = useRef<{ app: MapsApp; placeName: string; pin: LatLng | null } | null>(null);

  function choose(app: MapsApp) {
    if (target) chosen.current = { app, ...target };
    onClose();
  }

  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={() => {
        const c = chosen.current;
        chosen.current = null;
        if (c) Linking.openURL(mapsUrl(c.app, c.placeName, c.pin)).catch(() => {});
      }}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={en.placeTime.cancel}
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <HandTitle style={styles.title}>{en.placeTime.sheetTitle}</HandTitle>
          <Button title={en.placeTime.openApple} variant="secondary" onPress={() => choose('apple')} />
          <Button title={en.placeTime.openGoogle} variant="secondary" onPress={() => choose('google')} />
          <QLink title={en.placeTime.cancel} onPress={onClose} />
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
    gap: 12,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.separator, marginBottom: 4 },
  title: { marginBottom: 4 },
});
