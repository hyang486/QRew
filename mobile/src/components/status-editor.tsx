import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, colors, Hint } from '@/components/ui';
import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import {
  normalizeStatusLabels,
  removedStatusLabels,
  STATUS_LABEL_MAX,
  type StatusLabelsResult,
  statusLabelsChanged,
} from '@/lib/status-plan';
import { useRoomEvents } from '@/lib/room-channel';
import { supabase } from '@/lib/supabase';

type Row = { key: number; text: string };

function problemText(result: Extract<StatusLabelsResult, { ok: false }>): string {
  if (result.error === 'tooLong') return en.statusEditor.tooLong(result.label, STATUS_LABEL_MAX);
  if (result.error === 'emergency') return en.statusEditor.emergency;
  return en.statusEditor.duplicate(result.label);
}

/**
 * The room's status list (Room info). The host edits the non-Emergency statuses through
 * set_status_definitions; other members see the list read-only. Emergency is always shown and fixed.
 * Qrew unit 5 (Q 03.03): the host sees the read-only list too until `editing` (Edit status options); the
 * draft rows stay while the editor is closed, so closing it never drops unsaved edits.
 */
export function StatusEditor({ roomId, isHost, editing = true }: { roomId: string; isHost: boolean; editing?: boolean }) {
  const nextKey = useRef(0);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'normal' | 'error'; text: string } | null>(null);

  const toRows = useCallback(
    (labels: string[]) => labels.map((text) => ({ key: nextKey.current++, text })),
    [],
  );

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('status_definitions')
      .select('label, sort')
      .eq('room_id', roomId)
      .eq('is_emergency', false)
      .order('sort');
    if (error) {
      setLoadFailed(true);
      return;
    }
    const labels = (data ?? []).map((d) => d.label);
    setLoadFailed(false);
    setSaved(labels);
    setRows(toRows(labels));
  }, [roomId, toRows]);

  useEffect(() => {
    // load only sets state after its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Live refresh (SE-1): the list is broadcast as status_definitions notices (0017). The host's unsaved
  // edits win: no reload while the rows differ from the saved list or a save is in flight.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);
  useRoomEvents(roomId, (event) => {
    if (event.table !== 'status_definitions' || busy) return;
    if (saved !== null) {
      const current = normalizeStatusLabels(rows.map((r) => r.text));
      if (!current.ok || statusLabelsChanged(saved, current.labels)) return;
    }
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      load();
    }, 300);
  });

  if (loadFailed) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{en.statusEditor.title}</Text>
        <Hint tone="error">{en.statusEditor.loadError}</Hint>
        <Button title={en.home.retry} variant="secondary" onPress={load} />
      </View>
    );
  }
  if (saved === null) return null;

  const result = normalizeStatusLabels(rows.map((r) => r.text));
  const dirty = result.ok ? statusLabelsChanged(saved, result.labels) : true;

  async function write(labels: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase.rpc('set_status_definitions', { p_room_id: roomId, p_labels: labels });
      if (error) throw error;
      setSaved(labels);
      setRows(toRows(labels));
      setMessage({ tone: 'normal', text: en.statusEditor.saved });
    } catch (e) {
      setMessage({ tone: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!result.ok) {
      setMessage({ tone: 'error', text: problemText(result) });
      return;
    }
    const labels = result.labels;
    const removed = removedStatusLabels(saved!, labels);
    if (removed.length === 0) {
      write(labels);
      return;
    }
    Alert.alert(en.statusEditor.removeConfirmTitle, en.statusEditor.removeConfirmBody(removed.join(', ')), [
      { text: en.statusEditor.cancel, style: 'cancel' },
      { text: en.statusEditor.removeConfirm, style: 'destructive', onPress: () => write(labels) },
    ]);
  }

  if (!isHost || !editing) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {en.room.statusOptions}
        </Text>
        <View>
          {saved.map((label) => (
            <Text key={label} style={styles.line}>
              {label}
            </Text>
          ))}
          <View style={styles.lineRow}>
            <Text style={styles.lineDanger}>Emergency</Text>
            <Text style={styles.fixedTag}>{en.statusEditor.emergencyFixed}</Text>
          </View>
        </View>
        {!isHost ? <Hint>{en.statusEditor.memberHint}</Hint> : null}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{en.statusEditor.title}</Text>
      <View style={styles.row}>
        <Text style={styles.fixedLabel}>Emergency</Text>
        <Text style={styles.fixedTag}>{en.statusEditor.emergencyFixed}</Text>
      </View>

      {isHost
        ? rows.map((row, i) => (
            <View key={row.key} style={styles.row}>
              <TextInput
                style={styles.input}
                value={row.text}
                onChangeText={(text) => {
                  setMessage(null);
                  setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, text } : r)));
                }}
                placeholder={en.statusEditor.placeholder}
                placeholderTextColor={colors.secondaryLabel}
                accessibilityLabel={en.statusEditor.rowLabel(i + 1)}
                maxLength={STATUS_LABEL_MAX * 2 + 10}
                editable={!busy}
                returnKeyType="done"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={en.statusEditor.remove(row.text.trim())}
                hitSlop={8}
                disabled={busy}
                onPress={() => {
                  setMessage(null);
                  setRows((prev) => prev.filter((r) => r.key !== row.key));
                }}
              >
                <Text style={styles.remove}>−</Text>
              </Pressable>
            </View>
          ))
        : saved.map((label) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
            </View>
          ))}

      {isHost ? (
        <>
          <Button
            title={en.statusEditor.add}
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setMessage(null);
              setRows((prev) => [...prev, { key: nextKey.current++, text: '' }]);
            }}
          />
          <Hint>{en.statusEditor.hostHint}</Hint>
          {message ? <Hint tone={message.tone}>{message.text}</Hint> : null}
          <Button title={en.statusEditor.save} busy={busy} disabled={!dirty} onPress={save} />
        </>
      ) : (
        <Hint>{en.statusEditor.memberHint}</Hint>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, color: colors.secondaryLabel, textTransform: 'uppercase' },
  // Q 03.03: plain lines with a hairline under each.
  line: {
    fontSize: 15,
    color: colors.label,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  lineDanger: { flex: 1, fontSize: 15, color: colors.danger, paddingVertical: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: 46,
    gap: 10,
  },
  input: { flex: 1, fontSize: 17, color: colors.label, paddingVertical: 12 },
  label: { flex: 1, fontSize: 17, color: colors.label, paddingVertical: 12 },
  fixedLabel: { flex: 1, fontSize: 17, color: colors.danger, fontWeight: '600', paddingVertical: 12 },
  fixedTag: { fontSize: 14, color: colors.secondaryLabel },
  remove: { fontSize: 26, lineHeight: 28, color: colors.danger, paddingHorizontal: 6 },
});
