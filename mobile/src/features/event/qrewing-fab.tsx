// Floating "Ask Qrewing" button (spec 10.1): bottom right of the in-room screens, only when the room has Qrewing AI on
// and the probe answers ok. Before the asker agrees to Qrewing AI here, a tap shows the existing consent sheet.
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/components/ui';
import { en } from '@/i18n/en';

import { DisclosureSheet } from './disclosure-sheet';
import { probeQrewing, useQrewingRoom } from './qrewing-api';

const s = en.qrewing.ask;
const ART = require('../../../assets/images/icon.png');
export const QREWING_FAB_SIZE = 56;
/** Bottom padding for a scroll area under the button, so its last row can scroll clear of it. */
export const QREWING_FAB_CLEARANCE = QREWING_FAB_SIZE + 24;

/** The room's Qrewing switch plus a probe ok, and my consent. `available` is false until both answer. */
export function useQrewingAsk(roomId: string) {
  const q = useQrewingRoom(roomId);
  const [probe, setProbe] = useState<{ roomId: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!q.aiEnabled) return;
    let alive = true;
    probeQrewing(roomId).then((r) => alive && setProbe({ roomId, ok: !('error' in r) }));
    return () => {
      alive = false;
    };
  }, [roomId, q.aiEnabled]);
  const available = q.aiEnabled && probe?.roomId === roomId && probe.ok;
  return { available, agreed: !!q.me?.aiOk, reload: q.reload };
}

/**
 * Mount it only on a live room (never in grace or on Room ended), as the last child of the screen's content area
 * that ends above its bottom controls (composer, Save, map buttons), so it never covers them. `bottom` adds more
 * clearance; `safeArea` adds the home-indicator inset (only for an area that reaches the bottom of the screen).
 */
export function QrewingFab({ roomId, bottom = 0, safeArea = false }: { roomId: string; bottom?: number; safeArea?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { available, agreed, reload } = useQrewingAsk(roomId);
  const [consent, setConsent] = useState(false);
  // Set when the consent sheet saved an answer: the ask screen opens once the reload shows I agreed.
  const openAfterConsent = useRef(false);

  useEffect(() => {
    if (!openAfterConsent.current || !agreed) return;
    openAfterConsent.current = false;
    router.push({ pathname: '/room/[id]/ask', params: { id: roomId } });
  }, [agreed, roomId, router]);

  if (!available) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={s.fabLabel}
        onPress={() => (agreed ? router.push({ pathname: '/room/[id]/ask', params: { id: roomId } }) : setConsent(true))}
        hitSlop={6}
        style={({ pressed }) => [
          styles.fab,
          { bottom: bottom + (safeArea ? Math.max(insets.bottom, 12) : 0) + 12, right: insets.right + 16 },
          pressed && styles.pressed,
        ]}
      >
        <Image source={ART} style={styles.art} contentFit="cover" accessibilityIgnoresInvertColors />
        <View style={styles.ring} pointerEvents="none" />
      </Pressable>
      <DisclosureSheet
        roomId={roomId}
        visible={consent}
        onDone={() => {
          setConsent(false);
          openAfterConsent.current = true;
          reload();
        }}
        onClose={() => setConsent(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    width: QREWING_FAB_SIZE,
    height: QREWING_FAB_SIZE,
    borderRadius: QREWING_FAB_SIZE / 2,
  },
  // A thin ink ring, so the cream art stays visible on the cream screen (themed, no hard-coded shadow color).
  ring: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: QREWING_FAB_SIZE / 2, borderWidth: 1.5, borderColor: colors.label },
  art: { width: '100%', height: '100%', borderRadius: QREWING_FAB_SIZE / 2 },
  pressed: { opacity: 0.7 },
});
