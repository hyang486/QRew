import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { Tables } from './database.types';
import { useRoomEvents } from './room-channel';
import { supabase } from './supabase';

const ACTIVITY_TABLES = new Set(['member_status', 'status_definitions', 'emergency_events', 'emergency_acks', 'arrivals']);

export type StatusDefinition = Tables<'status_definitions'>;

/** An Emergency that is still open: its sender's current status is still Emergency. */
export type OpenEmergency = {
  id: string;
  userId: string;
  createdAt: string;
  /** Members (other than the sender) who acknowledged it. */
  ackedBy: Set<string>;
};

export type RoomActivity = {
  loading: boolean;
  error: unknown;
  /** Host-defined statuses in order, Emergency last. */
  statuses: StatusDefinition[];
  /** Current status per member (user id -> status definition id). */
  memberStatus: Map<string, string>;
  /** When the current user tapped Arrived in the current activity, or null. */
  myArrivedAt: string | null;
  emergencies: OpenEmergency[];
};

const EMPTY: RoomActivity = {
  loading: true,
  error: null,
  statuses: [],
  memberStatus: new Map(),
  myArrivedAt: null,
  emergencies: [],
};

async function fetchActivity(roomId: string, userId: string, activitySeq: number): Promise<Omit<RoomActivity, 'loading'>> {
  const [defs, member, arrival, events] = await Promise.all([
    supabase.from('status_definitions').select('*').eq('room_id', roomId).order('sort'),
    supabase.from('member_status').select('user_id, status_id').eq('room_id', roomId),
    supabase
      .from('arrivals')
      .select('arrived_at')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      // E2E (c): Arrived means arrived at the meetup, so my first arrival in any activity keeps the chip set.
      .order('arrived_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('emergency_events')
      .select('id, user_id, created_at')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);
  for (const r of [defs, member, arrival, events]) if (r.error) throw r.error;

  const statuses = [...(defs.data ?? [])].sort(
    (a, b) => Number(a.is_emergency) - Number(b.is_emergency) || a.sort - b.sort,
  );
  const emergencyId = statuses.find((s) => s.is_emergency)?.id;
  const memberStatus = new Map((member.data ?? []).map((m) => [m.user_id, m.status_id]));

  // Latest event per member whose status is still Emergency.
  const open: OpenEmergency[] = [];
  const seen = new Set<string>();
  for (const e of events.data ?? []) {
    if (seen.has(e.user_id)) continue;
    seen.add(e.user_id);
    if (emergencyId && memberStatus.get(e.user_id) === emergencyId) {
      open.push({ id: e.id, userId: e.user_id, createdAt: e.created_at, ackedBy: new Set() });
    }
  }
  if (open.length > 0) {
    const acks = await supabase
      .from('emergency_acks')
      .select('event_id, user_id')
      .in(
        'event_id',
        open.map((e) => e.id),
      );
    if (acks.error) throw acks.error;
    for (const a of acks.data ?? []) {
      const ev = open.find((e) => e.id === a.event_id);
      if (ev && a.user_id !== ev.userId) ev.ackedBy.add(a.user_id);
    }
  }

  return { error: null, statuses, memberStatus, myArrivedAt: arrival.data?.arrived_at ?? null, emergencies: open };
}

/**
 * Arrival, statuses and open Emergencies for a room. Refetches on any related room change notice,
 * after a (re)subscribe, when activity_seq changes and when the app returns to the foreground.
 */
export function useRoomActivity(roomId: string, userId: string | undefined, activitySeq: number) {
  const [state, setState] = useState<RoomActivity>(EMPTY);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!userId) return;
    const mine = ++seq.current;
    try {
      const next = await fetchActivity(roomId, userId, activitySeq);
      if (mine === seq.current) setState({ ...next, loading: false });
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [roomId, userId, activitySeq]);

  // Change notices from the room's private Broadcast topic; content is always refetched through RLS.
  useRoomEvents(
    roomId,
    (event) => {
      if (ACTIVITY_TABLES.has(event.table)) reload();
    },
    (status) => {
      if (status === 'SUBSCRIBED') reload();
    },
  );

  useEffect(() => {
    reload();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') reload();
    });
    return () => sub.remove();
  }, [reload]);

  const arrive = useCallback(async () => {
    const { error } = await supabase.rpc('mark_arrived', { p_room_id: roomId });
    if (error) throw error;
    await reload();
  }, [roomId, reload]);

  const setStatus = useCallback(
    async (statusId: string) => {
      const { error } = await supabase.rpc('set_my_status', { p_room_id: roomId, p_status_id: statusId });
      if (error) throw error;
      await reload();
    },
    [roomId, reload],
  );

  const clearStatus = useCallback(async () => {
    const { error } = await supabase.rpc('clear_my_status', { p_room_id: roomId });
    if (error) throw error;
    await reload();
  }, [roomId, reload]);

  const acknowledge = useCallback(
    async (eventId: string) => {
      const { error } = await supabase.rpc('ack_emergency', { p_event_id: eventId });
      if (error) throw error;
      await reload();
    },
    [reload],
  );

  return { ...state, reload, arrive, setStatus, clearStatus, acknowledge };
}
