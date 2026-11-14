import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Button, colors, Hint, radius } from '@/components/ui';
import type { Room } from '@/lib/rooms';

import { runKey, usePaceRun } from './engine';
import {
  formatDuration,
  formatPace,
  type PaceTarget,
  parseDuration,
  parseKm,
  parsePace,
  targetSecPerKm,
  usualPace,
} from './pace-core';
import { paceApplies } from './pace-layer';
import { saveTarget, setOn, usePaceSettings } from './settings';
import { initialPaceSec, targetFieldsFilled } from './target-form';
import { en } from '@/i18n/en';
const t = en.pace;

/** Map screen card (spec 3.4): the Pace maker switch (per room, default off), the target, and my live stats. */
export function PaceCard({ room, share }: { room: Room; share: boolean }) {
  const settings = usePaceSettings(room.id);
  const run = usePaceRun(runKey(room.id, room.activity_seq));
  if (!paceApplies(room)) return null;
  const active = room.activity_state === 'active';
  const usual = usualPace(settings.history);
  const goal = targetSecPerKm(settings.target, usual);
  const stats = run?.tracker.lastFix
    ? t.stats(
        run.tracker.distanceM,
        formatDuration(run.tracker.movingMs / 1000),
        formatPace(run.recent),
      )
    : null;

  return (
    <View style={styles.group}>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{t.title}</Text>
        <Switch value={settings.on} onValueChange={(on) => setOn(room.id, on)} accessibilityLabel={t.title} />
      </View>
      <Hint>{t.switchHint}</Hint>
      {settings.on ? (
        <>
          {!share ? <Hint tone="error">{t.needsSharing}</Hint> : !active ? <Hint>{t.needsActivity}</Hint> : null}
          {stats ? <Text style={styles.stats}>{stats}</Text> : null}
          <TargetEditor target={settings.target} usual={usual} />
          {goal == null ? <Hint>{t.noTarget}</Hint> : null}
        </>
      ) : null}
    </View>
  );
}

type Mode = PaceTarget['kind'];

function TargetEditor({ target, usual }: { target: PaceTarget; usual: number | null }) {
  const [mode, setMode] = useState<Mode>(target.kind);
  // E2E (j): prefilled with my target or usual pace; with neither, empty under an "e.g." hint.
  const [pace, setPace] = useState(formatPace(initialPaceSec(target, usual)) ?? '');
  const paceTouched = useRef(false);
  // The usual pace can arrive after mount (history loads); fill it in unless I already typed.
  useEffect(() => {
    if (!paceTouched.current && usual != null && target.kind !== 'pace') setPace((p) => p || (formatPace(usual) ?? ''));
  }, [usual, target.kind]);
  const [km, setKm] = useState(target.kind === 'time' ? String(target.distanceM / 1000) : '');
  const [time, setTime] = useState(target.kind === 'time' ? formatDuration(target.timeS) : '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function choose(next: Mode) {
    setMode(next);
    setError(null);
    setSaved(false);
    if (next === 'usual') saveTarget({ kind: 'usual' });
  }

  function save() {
    setSaved(false);
    if (mode === 'pace') {
      const secPerKm = parsePace(pace);
      if (secPerKm == null) return setError(t.invalidPace);
      saveTarget({ kind: 'pace', secPerKm });
    } else if (mode === 'time') {
      const distanceM = parseKm(km);
      const timeS = parseDuration(time);
      if (distanceM == null || timeS == null) return setError(t.invalidTime);
      saveTarget({ kind: 'time', distanceM, timeS });
    }
    setError(null);
    setSaved(true);
  }

  const options: { mode: Mode; label: string }[] = [
    { mode: 'usual', label: t.targetUsual(formatPace(usual)) },
    { mode: 'pace', label: t.targetPace },
    { mode: 'time', label: t.targetTime },
  ];
  const shown =
    mode === 'pace' || mode === 'time'
      ? targetSecPerKm(
          mode === 'pace'
            ? { kind: 'pace', secPerKm: parsePace(pace) ?? 0 }
            : {
                kind: 'time',
                distanceM: parseKm(km) ?? 0,
                timeS: parseDuration(time) ?? 0,
              },
          usual,
        )
      : null;

  return (
    <View style={styles.target}>
      <Text style={styles.label} accessibilityRole="header">
        {t.target}
      </Text>
      <View style={styles.chips}>
        {options.map((o) => (
          <Pressable
            key={o.mode}
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === o.mode }}
            onPress={() => choose(o.mode)}
            style={[styles.chip, mode === o.mode && styles.chipOn]}
          >
            <Text style={[styles.chipText, mode === o.mode && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      {mode === 'pace' ? (
        <View style={styles.inputRow}>
          <TextInput
            value={pace}
            onChangeText={(v) => {
              paceTouched.current = true;
              setPace(v);
            }}
            placeholder={t.pacePlaceholder}
            keyboardType="numbers-and-punctuation"
            accessibilityLabel={t.targetPace}
            placeholderTextColor={colors.secondaryLabel}
            style={styles.input}
          />
          <Text style={styles.unit}>{t.perKm}</Text>
        </View>
      ) : null}
      {mode === 'time' ? (
        <View style={styles.inputRow}>
          <TextInput
            value={km}
            onChangeText={setKm}
            placeholder={t.distancePlaceholder}
            keyboardType="decimal-pad"
            accessibilityLabel={t.distanceLabel}
            placeholderTextColor={colors.secondaryLabel}
            style={styles.input}
          />
          <TextInput
            value={time}
            onChangeText={setTime}
            placeholder={t.timePlaceholder}
            keyboardType="numbers-and-punctuation"
            accessibilityLabel={t.timeLabel}
            placeholderTextColor={colors.secondaryLabel}
            style={styles.input}
          />
          {shown ? <Text style={styles.unit}>{`${formatPace(shown)} ${t.perKm}`}</Text> : null}
        </View>
      ) : null}
      {mode !== 'usual' ? (
        <Button title={t.save} variant="secondary" onPress={save} disabled={!targetFieldsFilled(mode, pace, km, time)} />
      ) : null}
      {mode !== 'usual' && !targetFieldsFilled(mode, pace, km, time) ? (
        <Hint>{mode === 'pace' ? t.paceEmpty : t.timeEmpty}</Hint>
      ) : null}
      {error ? <Hint tone="error">{error}</Hint> : null}
      {saved && !error ? <Hint>{t.saved}</Hint> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.field,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  switchLabel: { fontSize: 17, color: colors.label, flexShrink: 1 },
  stats: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
  target: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600', color: colors.label },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.field,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipOn: { backgroundColor: colors.tint },
  chipText: { fontSize: 15, color: colors.label },
  chipTextOn: { color: colors.onTint },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    minWidth: 88,
    backgroundColor: colors.field,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 17,
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
  unit: { fontSize: 15, color: colors.secondaryLabel },
});
