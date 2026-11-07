import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { supabase } from './supabase';

/**
 * A change notice from the private Broadcast topic `room:<id>` (migration 0017).
 * It carries no row content: listeners refetch through RLS.
 */
export type RoomEvent = {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  /** The row id, for tables that have an `id` column. */
  id?: string;
  /** expiry_reminders notices (migration 0019): the expiry version the reminders are for. */
  expiry_version?: number;
};

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

type Listener = {
  onEvent: (event: RoomEvent) => void;
  onStatus: (status: ChannelStatus) => void;
};

type Entry = { channel: RealtimeChannel; listeners: Set<Listener>; status: ChannelStatus | null };

// One channel per room, shared by every screen and hook that needs it: joining the same topic twice
// on one socket would make the server close the first join.
const entries = new Map<string, Entry>();

function subscribeRoom(roomId: string, listener: Listener): () => void {
  let entry = entries.get(roomId);
  if (!entry) {
    const listeners = new Set<Listener>();
    const created: Entry = { channel: null as unknown as RealtimeChannel, listeners, status: null };
    created.channel = supabase
      .channel(`room:${roomId}`, { config: { private: true } })
      .on('broadcast', { event: '*' }, ({ payload }) => {
        for (const l of listeners) l.onEvent(payload as RoomEvent);
      })
      .subscribe((status) => {
        created.status = status as ChannelStatus;
        for (const l of listeners) l.onStatus(status as ChannelStatus);
      });
    entries.set(roomId, created);
    entry = created;
  } else if (entry.status) {
    // Late subscriber: report the current status so it can load right away.
    const status = entry.status;
    queueMicrotask(() => listener.onStatus(status));
  }
  entry.listeners.add(listener);

  return () => {
    const current = entries.get(roomId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      entries.delete(roomId);
      supabase.removeChannel(current.channel);
    }
  };
}

/** Listens to the room's change notices. Handlers may change between renders without resubscribing. */
export function useRoomEvents(
  roomId: string,
  onEvent: (event: RoomEvent) => void,
  onStatus?: (status: ChannelStatus) => void,
) {
  const handlers = useRef({ onEvent, onStatus });
  useLayoutEffect(() => {
    handlers.current = { onEvent, onStatus };
  });

  useEffect(
    () =>
      subscribeRoom(roomId, {
        onEvent: (e) => handlers.current.onEvent(e),
        onStatus: (s) => handlers.current.onStatus?.(s),
      }),
    [roomId],
  );
}
