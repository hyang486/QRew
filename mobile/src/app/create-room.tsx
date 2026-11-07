import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Button, colors, Field, Hint, Screen } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import { createRoom, ROOM_TYPES, type RoomType } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && { backgroundColor: colors.tint }]}
    >
      <Text style={[styles.chipText, selected && { color: 'white' }]}>{label}</Text>
    </Pressable>
  );
}

export default function CreateRoom() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [type, setType] = useState<RoomType>('sports');
  const [hours, setHours] = useState(96);
  const [locationAllowed, setLocationAllowed] = useState(true);
  const [statuses, setStatuses] = useState<string>(en.createRoom.statusesDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = useNow();
  const expiresPreview = new Date(now + hours * 3_600_000);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(en.createRoom.nameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom({
        name: trimmed,
        type,
        expiresAt: new Date(Date.now() + hours * 3_600_000),
        locationAllowed,
        statuses: statuses
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      router.replace({ pathname: '/room/[id]', params: { id: room.id } });
      router.push({ pathname: '/room/[id]/invite', params: { id: room.id } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Field
        label={en.createRoom.nameLabel}
        placeholder={en.createRoom.namePlaceholder}
        value={name}
        onChangeText={setName}
        maxLength={60}
        autoFocus
        returnKeyType="done"
      />

      <View style={styles.group}>
        <Text style={styles.label}>{en.createRoom.typeLabel}</Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {ROOM_TYPES.map((t) => (
            <Choice key={t} label={en.rooms.types[t]} selected={type === t} onPress={() => setType(t)} />
          ))}
        </View>
      </View>

      <View style={styles.group}>
        <Text style={styles.label}>{en.createRoom.expiryLabel}</Text>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {en.createRoom.expiryOptions.map((o) => (
            <Choice key={o.hours} label={o.label} selected={hours === o.hours} onPress={() => setHours(o.hours)} />
          ))}
        </View>
        <Hint>{en.createRoom.expiryHint(expiresPreview.toLocaleString())}</Hint>
        <Pressable accessibilityRole="link" onPress={() => router.push('/plan-preview')} hitSlop={8}>
          <Text style={styles.planLink}>{en.planPreview.createRoomLink}</Text>
        </Pressable>
      </View>

      <View style={styles.group}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{en.createRoom.locationLabel}</Text>
          <Switch
            value={locationAllowed}
            onValueChange={setLocationAllowed}
            accessibilityLabel={en.createRoom.locationLabel}
          />
        </View>
        <Hint>{en.createRoom.locationHint}</Hint>
      </View>

      <View style={styles.group}>
        <Field label={en.createRoom.statusesLabel} value={statuses} onChangeText={setStatuses} />
        <Hint>{en.createRoom.statusesHint}</Hint>
      </View>

      {error ? <Hint tone="error">{error}</Hint> : null}
      <Button title={en.createRoom.submit} onPress={submit} busy={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  planLink: { fontSize: 15, color: colors.tint },
  label: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.field,
    borderRadius: 18,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: { fontSize: 15, color: colors.label },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.field,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  switchLabel: { fontSize: 17, color: colors.label },
});
