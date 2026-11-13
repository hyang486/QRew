import { SymbolView } from 'expo-symbols';
import { Stack, useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useInk } from '@/components/hand-title';
import { QCard, QScreen } from '@/components/q-screen';
import { RoomEnded } from '@/components/room-ended';
import { Button, colors, Hint } from '@/components/ui';
import { purgeAskHistory } from '@/features/event/ask-store';
import { noteSiriRoomClosed } from '@/features/event/siri-mirror';
import { useQrewingRoom } from '@/features/event/qrewing-api';
import { endCopyHasRecap } from '@/features/event/qrewing-plan';
import { recapAfterEnd } from '@/features/recap/recap-store';
import { en } from '@/i18n/en';
import { useAuth } from '@/lib/auth';
import { endsDay } from '@/lib/chat-plan';
import { endGate, runOnce, type RunState } from '@/lib/end-plan';
import { errorMessage } from '@/lib/errors';
import { cancelExpiryReminder } from '@/lib/expiry-reminders';
import { setActivityState } from '@/lib/location';
import { clearRoomCache } from '@/lib/media';
import { endRoom, getRoom, type Room } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; room: Room | null };

/**
 * Qrew unit 4 (Q 03.04): the End activity and End room confirm screens, pushed from Map and Info. Back, the swipe
 * and Keep all just pop the screen, so nothing changes. End runs once (runOnce: a double tap cannot end twice),
 * shows its error on the screen and allows a retry. Host-only, like the RPCs (private.is_room_host).
 */
export function EndConfirm({ kind }: { kind: 'activity' | 'room' }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const ink = useInk();
  const now = useNow(30_000);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runState = useRef<RunState>({ current: 'idle' });
  // Navigate after End only while this screen is still on top (the user may have swiped back meanwhile).
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  useLayoutEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  const reload = useCallback(async () => {
    try {
      setLoad({ status: 'ready', room: await getRoom(id) });
    } catch (e) {
      setLoad({ status: 'error', message: errorMessage(e) });
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      if (runState.current.current === 'idle') reload();
    }, [reload]),
  );

  // Spec 7.4: the end-room deletion lines name the recap only when Qrewing AI may have written one.
  // The recap is left out only when a read answered that Qrewing AI is off (still loading or a failed read keeps
  // the recap wording, review R6). No id: no read, recap wording.
  const qrewing = useQrewingRoom(id ?? '');
  const recapOn = endCopyHasRecap(qrewing);
  const ev = en.endRoom;
  const copy =
    kind === 'activity'
      ? en.endActivity
      : { ...ev, effectsLabel: recapOn ? ev.effectsLabel : ev.effectsLabelNoRecap };
  const header = <Stack.Screen options={{ title: copy.title, headerTitle: '', gestureEnabled: !running }} />;

  if (load.status === 'loading') {
    return (
      <QScreen>
        {header}
        <ActivityIndicator style={styles.loading} />
      </QScreen>
    );
  }
  if (load.status === 'error') {
    return (
      <QScreen title={copy.title} actions={<Button title={en.home.retry} variant="secondary" onPress={reload} />}>
        {header}
        <Hint tone="error">{load.message}</Hint>
      </QScreen>
    );
  }

  const room = load.room;
  const gate = endGate(kind, room, userId, now);
  // After a successful End the room is not reloaded (useFocusEffect skips it), so the screen does not flash
  // "not running" while it leaves.
  if (gate === 'gone' || !room) {
    // Q 06.04: the shared ended screen (closed-at time only when the loaded row shows it).
    return (
      <>
        {header}
        <RoomEnded room={room} nowMs={now} />
      </>
    );
  }
  if (gate !== 'ready') {
    const message = gate === 'not-host' ? copy.notHost : en.endActivity.notRunning;
    return (
      <QScreen
        title={copy.title}
        actions={
          <Button
            title={kind === 'activity' ? en.endActivity.back : en.room.cancel}
            variant="secondary"
            onPress={() => router.back()}
          />
        }
      >
        {header}
        <Text style={styles.body}>{message}</Text>
      </QScreen>
    );
  }

  async function confirm() {
    if (!room) return;
    setError(null);
    setRunning(true);
    try {
      const ran = await runOnce(runState.current, async () => {
        if (kind === 'activity') {
          await setActivityState(room.id, 'ended');
        } else {
          await endRoom(room.id);
          // Spec 7.3: end_room first, then the recap in the background (15 s limit, never blocks leaving).
          recapAfterEnd(room.id, userId);
          cancelExpiryReminder(room.id);
          clearRoomCache(room.id);
          void purgeAskHistory(room.id);
          noteSiriRoomClosed(room.id);
        }
      });
      if (!ran || !focusedRef.current) return;
      if (kind === 'activity') router.back();
      else router.dismissTo('/');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  const expiresMs = new Date(room.expires_at).getTime();
  const lines =
    kind === 'activity'
      ? [
          en.endActivity.body,
          en.endActivity.roomOpenUntil(
            endsDay(expiresMs, now),
            new Date(expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' }),
            new Date(expiresMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          ),
        ]
      : [en.endRoom.body, recapOn ? ev.deleted : ev.deletedNoRecap];
  const from = kind === 'activity' ? ['mappin.and.ellipse'] : ['bubble.left', 'photo', 'doc'];
  const to = kind === 'activity' ? 'photo' : 'trash';

  return (
    <QScreen
      title={copy.title}
      bottomAlign="center"
      bottom={
        <QCard>
          <View style={styles.effects} accessible accessibilityLabel={copy.effectsLabel}>
            <View style={styles.icons}>
              {from.map((name) => (
                <SymbolView key={name} name={name as never} size={from.length > 1 ? 30 : 40} tintColor={ink} />
              ))}
            </View>
            <SymbolView name="arrow.right" size={22} tintColor={ink} />
            <SymbolView name={to as never} size={40} tintColor={ink} />
          </View>
          <Text style={styles.effectsText} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {copy.effects}
          </Text>
        </QCard>
      }
      actions={
        <>
          {error ? <Hint tone="error">{error}</Hint> : null}
          <Button title={copy.confirm} busy={running} onPress={confirm} />
          <Button title={copy.keep} variant="secondary" disabled={running} onPress={() => router.back()} />
        </>
      }
    >
      {header}
      {lines.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}
    </QScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  body: { fontSize: 15, lineHeight: 21, color: colors.secondaryLabel },
  effects: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 18 },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  effectsText: { fontSize: 15, color: colors.label, textAlign: 'center', paddingBottom: 6 },
});
