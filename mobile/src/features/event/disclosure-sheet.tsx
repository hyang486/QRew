import { useIsFocused, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
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
  const settled = useSettledFocus();
  const present = usePresentRetry(visible && settled);
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
      key={present.key}
      visible={visible && settled}
      onShow={present.onShow}
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

/** Fallback for a screen whose navigator sends no transitionEnd (no push animation). */
const SETTLE_FALLBACK_MS = 700;

/**
 * qa 2026-11-13: presented while the room's push was still animating, the page sheet was never drawn but still
 * took every tap until Agree. The sheet waits until its screen is focused and the push has finished; leaving the
 * screen resets that, so it never presents from a screen in the background.
 */
function useSettledFocus() {
  // The screen's native-stack navigator; the generic useNavigation type lacks the stack's transition events.
  const navigation = useNavigation() as unknown as {
    addListener: (event: 'transitionEnd', cb: () => void) => () => void;
  };
  const focused = useIsFocused();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!focused) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setSettled(true);
    };
    const off = navigation.addListener('transitionEnd', finish);
    const t = setTimeout(finish, SETTLE_FALLBACK_MS);
    return () => {
      off();
      clearTimeout(t);
      setSettled(false);
    };
  }, [focused, navigation]);
  return focused && settled;
}

/** A page sheet's slide-in takes about 0.5 s; past this without onShow, UIKit refused the presentation. */
const SHOW_TIMEOUT_MS = 1500;
const MAX_SHOW_RETRIES = 4;

/**
 * qa 2026-11-13 (f234327): host's first entry via the invite modal's Done showed no sheet. RN's Modal marks itself
 * presented before UIKit accepts it and never retries; the room screen's controller was still dismissing the invite
 * modal, so UIKit refused the presentation silently (no onShow). Until onShow arrives, remount the Modal to present
 * again. A refused presentation is not in the window, so it takes no taps meanwhile.
 */
function usePresentRetry(want: boolean) {
  const [shown, setShown] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!want) return;
    return () => {
      setShown(false);
      setAttempt(0);
    };
  }, [want]);
  useEffect(() => {
    if (!want || shown || attempt >= MAX_SHOW_RETRIES) return;
    const t = setTimeout(() => {
      if (__DEV__) console.log('[disclosure] no onShow, presenting again', attempt + 1);
      setAttempt(attempt + 1);
    }, SHOW_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [want, shown, attempt]);
  return { key: attempt, onShow: () => setShown(true) };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { paddingHorizontal: 24, paddingTop: 32, gap: 14 },
  title: { fontSize: 28, lineHeight: 36 },
  line: { fontSize: 16, lineHeight: 23, color: colors.label },
  actions: { paddingHorizontal: 24, gap: 10 },
});
