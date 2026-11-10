import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  Vibration,
  View,
  type ViewStyle,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';

import { StatusPicker } from '@/components/status-picker';
import { colors, radius } from '@/components/ui';
import { en } from '@/i18n/en';
import { type StatusDefinition, useRoomActivity } from '@/lib/activity';
import { emergencyLocation } from '@/lib/chat-plan';
import { createAnnouncer, seenSummary } from '@/lib/emergency-plan';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { type Presence, useLivePresence } from '@/lib/location';
import { formatAge, type LatLng } from '@/lib/location-plan';
import { useRoomEvents } from '@/lib/room-channel';
import { listMembers } from '@/lib/rooms';
import { useNow } from '@/lib/use-now';

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * F2 (U5): at the largest text sizes the Emergency card must not push its own actions, the chat composer or
 * the Photos footer off screen. Its text scales only so far, and the cards scroll inside a box at most this
 * share of the window tall. At standard size the cards fit, so nothing scrolls and nothing changes.
 */
const EMERGENCY_FONT_CAP = 1.4;
const EMERGENCY_MAX_HEIGHT_SHARE = 0.36;

// One vibration per Emergency across every screen that shows its banner.
const announcer = createAnnouncer();

/**
 * #1: open Emergencies with their actions, the same card on chat, Map, Photos and Info. "I see it" and
 * "I'm OK" call the same RPCs everywhere (ack_emergency, clear_my_status). Vibrates once per new Emergency
 * raised by someone else, app-wide, while any of these screens is open.
 */
export function EmergencyAlerts({
  roomId,
  activity,
  userId,
  names,
  presence,
  onOpenLocation,
}: {
  roomId: string;
  activity: ReturnType<typeof useRoomActivity>;
  userId: string | undefined;
  names: Map<string, string>;
  /** Live position rows of the room (Q 04.03 "Last location shared · 4 min ago"). */
  presence: readonly Presence[];
  /** Map moves its own camera; elsewhere the link opens Map centered on the sender. */
  onOpenLocation?: (userId: string, coordinates: LatLng) => void;
}) {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const lastSeen = useMemo(() => new Map(presence.map((p) => [p.user_id, p])), [presence]);
  const seeded = useRef(false);
  useEffect(() => {
    if (activity.loading) return;
    const others = activity.emergencies.filter((e) => e.userId !== userId).map((e) => e.id);
    if (!seeded.current) {
      // First load of this screen: open Emergencies are shown, not re-announced.
      seeded.current = true;
      announcer.seed(others);
      return;
    }
    if (announcer.fresh(others).length > 0) Vibration.vibrate([0, 400, 200, 400]);
  }, [activity.loading, activity.emergencies, userId]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      Alert.alert(en.activity.actionFailed, errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!userId || activity.loading || activity.emergencies.length === 0) return null;

  // Recipients are the current members other than the sender.
  const recipients = Math.max(0, names.size - 1);

  function openLocation(senderId: string, coordinates: LatLng) {
    if (onOpenLocation) onOpenLocation(senderId, coordinates);
    else router.push({ pathname: '/room/[id]/map', params: { id: roomId, focus: senderId } });
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={{ maxHeight: Math.round(windowHeight * EMERGENCY_MAX_HEIGHT_SHARE), flexGrow: 0 }}
      contentContainerStyle={styles.alerts}
      contentInsetAdjustmentBehavior="never"
      alwaysBounceVertical={false}
      nestedScrollEnabled
      // When the cards overflow the box, show the indicator so it is clear the actions are below.
      onContentSizeChange={(_w, h) => {
        if (h > windowHeight * EMERGENCY_MAX_HEIGHT_SHARE) scrollRef.current?.flashScrollIndicators();
      }}
    >
      {activity.emergencies.map((e) => {
        const mine = e.userId === userId;
        const { who, seen } = seenSummary(e.ackedBy, names);
        const iAcked = e.ackedBy.has(userId);
        const location = emergencyLocation(lastSeen.get(e.userId));
        const name = names.get(e.userId) ?? en.chat.formerMember;
        return (
          // Q 04.03: bright red card with the requester, who has seen it, the age of the last shared location
          // and the actions; the same card on chat, Map, Photos and Info.
          <View key={e.id} style={styles.emergency} accessibilityRole="alert">
            <View style={styles.emergencyHead}>
              <SymbolView name="exclamationmark.triangle" size={22} tintColor={colors.danger} />
              <Text style={styles.emergencyTitle} maxFontSizeMultiplier={EMERGENCY_FONT_CAP}>{mine ? en.activity.helpRequested : en.activity.emergencyFrom(name)}</Text>
            </View>
            <Text style={styles.emergencyMeta} maxFontSizeMultiplier={EMERGENCY_FONT_CAP}>
              {timeOf(e.createdAt)} · {seen === 0 ? en.activity.waitingSeen : en.activity.seenByNames(who, seen, recipients)}
            </Text>
            <Text style={styles.emergencyMeta} maxFontSizeMultiplier={EMERGENCY_FONT_CAP}>
              {location.kind === 'shared' ? en.activity.lastLocation(formatAge(location.updatedAt, now)) : en.activity.noLocation}
            </Text>
            <View style={styles.emergencyActions}>
              {mine ? (
                <TextAction label={en.activity.imOkNow} busy={busy === 'ok'} onPress={() => run('ok', activity.clearStatus)} />
              ) : (
                <>
                  {location.kind === 'shared' ? (
                    <TextAction label={en.activity.openLastLocation} onPress={() => openLocation(e.userId, location.coordinates)} />
                  ) : null}
                  {iAcked ? (
                    <Text style={styles.emergencyMeta} maxFontSizeMultiplier={EMERGENCY_FONT_CAP}>{en.activity.acknowledged}</Text>
                  ) : (
                    <Chip
                      label={en.activity.acknowledge}
                      filled
                      busy={busy === `ack:${e.id}`}
                      onPress={() => run(`ack:${e.id}`, () => activity.acknowledge(e.id))}
                    />
                  )}
                </>
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** Live positions only while an Emergency is open (no presence traffic on screens that do not need it). */
function useEmergencyPresence(roomId: string, activity: ReturnType<typeof useRoomActivity>) {
  return useLivePresence(roomId, activity.emergencies.length > 0).rows;
}

/**
 * #1: the Emergency banner for screens that do not load the member list themselves (Photos, Info, Photos of
 * me). Loads the names, and reloads them on membership changes. Renders nothing when no Emergency is open.
 */
export function RoomEmergencyBanner({ roomId, style }: { roomId: string; style?: StyleProp<ViewStyle> }) {
  const { session } = useAuth();
  const userId = session?.user.id;
  // activity_seq only scopes the Arrived button, which this banner does not show.
  const activity = useRoomActivity(roomId, userId, 0);
  const presence = useEmergencyPresence(roomId, activity);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const loadNames = useCallback(() => {
    listMembers(roomId)
      .then((members) => setNames(new Map(members.map((m) => [m.user_id, m.display_name]))))
      .catch(() => {});
  }, [roomId]);
  useEffect(() => {
    loadNames();
  }, [loadNames]);
  useRoomEvents(roomId, (event) => {
    if (event.table === 'room_members') loadNames();
  });
  if (activity.emergencies.length === 0) return null;
  return (
    <View style={style}>
      <EmergencyAlerts roomId={roomId} activity={activity} userId={userId} names={names} presence={presence} />
    </View>
  );
}

/**
 * Q 03.01 / 04.03: under the chat tabs, the Arrived and Set status pills, then open Emergencies. Set status
 * opens the Q 03.02 sheet. `hideControls` (keyboard open) keeps only the Emergency cards, so typing keeps the
 * message space.
 */
export function RoomActivityBar({
  roomId,
  activitySeq,
  userId,
  names,
  hideControls,
}: {
  roomId: string;
  activitySeq: number;
  userId: string | undefined;
  names: Map<string, string>;
  hideControls?: boolean;
}) {
  const activity = useRoomActivity(roomId, userId, activitySeq);
  const presence = useEmergencyPresence(roomId, activity);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (e) {
      Alert.alert(en.activity.actionFailed, errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const myStatusId = userId ? activity.memberStatus.get(userId) : undefined;
  const myStatus = activity.statuses.find((s) => s.id === myStatusId);

  function pick(def: StatusDefinition) {
    setPicking(false);
    if (def.id === myStatusId) return;
    if (def.is_emergency) {
      Alert.alert(en.activity.emergencyConfirmTitle, en.activity.emergencyConfirmBody, [
        { text: en.room.cancel, style: 'cancel' },
        { text: en.activity.sendEmergency, style: 'destructive', onPress: () => run('status', () => activity.setStatus(def.id)) },
      ]);
    } else {
      run('status', () => activity.setStatus(def.id));
    }
  }

  function clear() {
    setPicking(false);
    if (myStatusId) run('status', activity.clearStatus);
  }

  if (!userId || activity.loading) return null;

  return (
    <View style={styles.wrap}>
      {hideControls ? null : (
        <View style={styles.row}>
          <Chip
            label={activity.myArrivedAt ? en.activity.arrivedAt(timeOf(activity.myArrivedAt)) : en.activity.arrived}
            filled={!activity.myArrivedAt}
            busy={busy === 'arrive'}
            onPress={activity.myArrivedAt ? undefined : () => run('arrive', activity.arrive)}
          />
          <Chip
            label={myStatus ? en.activity.statusValue(myStatus.label) : en.activity.setStatus}
            danger={myStatus?.is_emergency}
            busy={busy === 'status'}
            onPress={() => setPicking(true)}
          />
        </View>
      )}
      <EmergencyAlerts roomId={roomId} activity={activity} userId={userId} names={names} presence={presence} />
      <StatusPicker
        visible={picking}
        statuses={activity.statuses}
        currentId={myStatusId}
        onPick={pick}
        onClear={clear}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

/** Q 03.01 pill: pale by default, black when `filled` (the next action, "Arrived" / "I see it"). */
function Chip({
  label,
  onPress,
  busy,
  filled,
  danger,
}: {
  label: string;
  onPress?: () => void;
  busy?: boolean;
  filled?: boolean;
  danger?: boolean;
}) {
  const disabled = !onPress || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, filled && styles.chipFilled, (pressed || busy) && { opacity: 0.5 }]}
    >
      <Text
        style={[styles.chipText, filled && styles.chipTextFilled, danger && styles.chipDanger]}
        numberOfLines={1}
        maxFontSizeMultiplier={EMERGENCY_FONT_CAP}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Red text action on the Emergency card (Q 04.03 "I'm OK now", Q 04.04 "Open last shared location"). */
function TextAction({ label, onPress, busy }: { label: string; onPress: () => void; busy?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.textAction, (pressed || busy) && { opacity: 0.5 }]}
    >
      <Text style={styles.textActionText} maxFontSizeMultiplier={EMERGENCY_FONT_CAP}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingBottom: 8, gap: 10 },
  alerts: { gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    flexShrink: 1,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    backgroundColor: colors.field,
  },
  chipFilled: { backgroundColor: colors.tint },
  chipText: { fontSize: 14, color: colors.label },
  chipTextFilled: { color: colors.onTint },
  chipDanger: { color: colors.danger },
  emergency: {
    backgroundColor: colors.dangerField,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    borderRadius: 12,
    borderCurve: 'continuous',
    padding: 14,
    gap: 4,
  },
  emergencyHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  emergencyTitle: { flexShrink: 1, fontSize: 18, color: colors.danger },
  emergencyMeta: { fontSize: 13, color: colors.label },
  emergencyActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  textAction: { paddingVertical: 4 },
  textActionText: { fontSize: 14, color: colors.danger },
});
