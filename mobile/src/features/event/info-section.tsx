import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { QCard, QLabel } from '@/components/q-screen';
import { QRowCard } from '@/components/q-row-card';
import { Button, colors, Hint } from '@/components/ui';

import { setQrewingMember, setQrewingRoom, useEntryQuestions, useQrewingRoom } from './qrewing-api';
import { en } from '@/i18n/en';

const s = en.qrewing.info;

/**
 * Room info "Qrewing AI" section (spec 3.2). Host: the room switches (also the retry path when the switch failed
 * at create time). Members of an AI room: include/stop including my messages, my entry info and People to meet
 * (event rooms).
 */
export function QrewingInfoSection({ roomId, roomType, isHost }: { roomId: string; roomType: string; isHost: boolean }) {
  const router = useRouter();
  const q = useQrewingRoom(roomId);
  // Spec 9.4 R4: entry info needs questions, which are set only on Create room. Read for the host of an event room.
  const entryQuestions = useEntryQuestions(isHost && roomType === 'event' ? roomId : '');
  const noQuestions = entryQuestions.loaded && !entryQuestions.failed && entryQuestions.questions.length === 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = q.reload;
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  async function run(action: () => Promise<{ error?: string; offline?: boolean }>) {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if (res.error) setError(res.offline ? en.qrewing.errors.network : s.saveFailed);
    q.reload();
  }

  const isEvent = roomType === 'event';
  // Offline: the host sees why the switches are missing (not a switch that reads Off); members see nothing, as
  // in a room without AI.
  if (q.readFailed) {
    if (!isHost) return null;
    return (
      <View style={styles.section}>
        <QLabel>{s.section}</QLabel>
        <Hint tone="error">{s.loadFailed}</Hint>
        <Button title={s.retry} variant="secondary" onPress={reload} />
      </View>
    );
  }
  if (!isHost && !q.aiEnabled) return null;
  const aiOk = q.me?.aiOk ?? false;

  return (
    <View style={styles.section}>
      <QLabel>{s.section}</QLabel>
      {isHost ? (
        <>
          <QCard row>
            <Text style={styles.cardTitle}>{en.qrewing.create.aiLabel}</Text>
            <Switch
              value={q.aiEnabled}
              disabled={busy}
              onValueChange={(v) => run(() => setQrewingRoom(roomId, v, v && isEvent && q.entryRequired))}
              accessibilityLabel={en.qrewing.create.aiLabel}
            />
          </QCard>
          {q.aiEnabled && isEvent ? (
            <QCard row>
              <Text style={styles.cardTitle}>{en.qrewing.create.entryLabel}</Text>
              <Switch
                value={q.entryRequired}
                // Turning it off always works; turning it on needs questions (22023 otherwise).
                disabled={busy || (noQuestions && !q.entryRequired)}
                onValueChange={(v) => (v && noQuestions ? undefined : run(() => setQrewingRoom(roomId, true, v)))}
                accessibilityLabel={en.qrewing.create.entryLabel}
              />
            </QCard>
          ) : null}
          {q.aiEnabled && isEvent && noQuestions && !q.entryRequired ? <Hint>{s.entryNoQuestions}</Hint> : null}
        </>
      ) : null}
      {q.aiEnabled ? (
        <>
          <QRowCard
            icon={aiOk ? 'checkmark.circle' : 'circle'}
            title={aiOk ? s.consentOn : s.consentOff}
            subtitle={aiOk ? s.withdraw : s.agree}
            busy={busy}
            onPress={() => run(() => setQrewingMember(roomId, !aiOk, false))}
          />
          {isEvent ? (
            <>
              <QRowCard
                icon="person.text.rectangle"
                title={s.editEntry}
                onPress={() => router.push({ pathname: '/room/[id]/entry', params: { id: roomId } })}
              />
              <QRowCard
                icon="person.2.wave.2"
                title={s.peopleToMeet}
                onPress={() => router.push({ pathname: '/room/[id]/people', params: { id: roomId } })}
              />
            </>
          ) : null}
        </>
      ) : null}
      {error ? <Hint tone="error">{error}</Hint> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12, marginTop: 12 },
  cardTitle: { flex: 1, fontSize: 16, color: colors.label },
});
