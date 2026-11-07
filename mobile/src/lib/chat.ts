import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { Tables } from './database.types';
import { useRoomEvents } from './room-channel';
import { supabase } from './supabase';

export type Message = Tables<'messages'>;

/** A message as shown in the list: server rows plus the sender's own unconfirmed sends. */
export type ChatItem = Message & { pending?: 'sending' | 'failed' };

export const MAX_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 50;

/** Newest first. `before` pages back from a created_at timestamp. */
export async function fetchMessages(roomId: string, before?: string): Promise<Message[]> {
  let query = supabase
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);
  // lte, not lt: rows sharing the boundary timestamp are re-fetched and de-duplicated by id instead of skipped.
  if (before) query = query.lte('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** The id is generated on the client, so the realtime echo replaces the optimistic row instead of duplicating it. */
async function insertMessage(row: { id: string; room_id: string; sender_id: string; body: string }) {
  const { data, error } = await supabase.from('messages').insert({ ...row, kind: 'text' }).select().single();
  if (error) throw error;
  return data;
}

function byNewest(a: Message, b: Message) {
  if (a.created_at === b.created_at) return a.id < b.id ? 1 : -1;
  return a.created_at < b.created_at ? 1 : -1;
}

/** Merges rows into a newest-first list; a server row replaces a pending row with the same id. */
function merge(current: ChatItem[], incoming: Message[]): ChatItem[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  const all = [...map.values()];
  // Unconfirmed sends stay at the bottom (newest end) until the server row arrives.
  const pending = all.filter((m) => m.pending);
  const confirmed = all.filter((m) => !m.pending).sort(byNewest);
  return [...pending.reverse(), ...confirmed];
}

type ChatState = {
  messages: ChatItem[];
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  live: boolean;
};

/**
 * Loads the latest page, listens for new-message notices on the room's private Broadcast topic,
 * and refetches the latest page after a (re)subscribe or when the app returns to the foreground,
 * so gaps while disconnected are filled.
 */
export function useChat(roomId: string, userId: string | undefined, onNewSender?: (senderId: string) => void) {
  const [state, setState] = useState<ChatState>({ messages: [], loading: true, error: null, hasMore: true, live: false });
  const messagesRef = useRef<ChatItem[]>([]);
  const loadingOlder = useRef(false);
  const onNewSenderRef = useRef(onNewSender);
  onNewSenderRef.current = onNewSender;

  const apply = useCallback((fn: (s: ChatState) => ChatState) => {
    setState((s) => {
      const next = fn(s);
      messagesRef.current = next.messages;
      return next;
    });
  }, []);

  const refreshLatest = useCallback(async () => {
    try {
      const rows = await fetchMessages(roomId);
      apply((s) => ({
        ...s,
        messages: merge(s.messages, rows),
        loading: false,
        error: null,
        hasMore: s.messages.length === 0 ? rows.length === PAGE_SIZE : s.hasMore,
      }));
    } catch (error) {
      apply((s) => ({ ...s, loading: false, error }));
    }
  }, [roomId, apply]);

  // Change notices carry only the message id; the row itself is read through RLS.
  useRoomEvents(
    roomId,
    async (event) => {
      if (event.table !== 'messages' || event.op !== 'INSERT' || !event.id) return;
      const { data: row } = await supabase.from('messages').select('*').eq('id', event.id).maybeSingle();
      if (!row) return;
      apply((s) => ({ ...s, messages: merge(s.messages, [row]) }));
      if (row.kind === 'system' || (row.sender_id && row.sender_id !== userId)) {
        onNewSenderRef.current?.(row.sender_id ?? '');
      }
    },
    (status) => {
      const live = status === 'SUBSCRIBED';
      apply((s) => ({ ...s, live }));
      if (live) refreshLatest();
    },
  );

  useEffect(() => {
    refreshLatest();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshLatest();
    });
    return () => sub.remove();
  }, [refreshLatest]);

  const loadOlder = useCallback(async () => {
    const oldest = messagesRef.current.filter((m) => !m.pending).at(-1);
    if (!oldest || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const rows = await fetchMessages(roomId, oldest.created_at);
      apply((s) => ({ ...s, messages: merge(s.messages, rows), hasMore: rows.length === PAGE_SIZE }));
    } catch {
      // Older history is best effort; the next scroll retries.
    } finally {
      loadingOlder.current = false;
    }
  }, [roomId, apply]);

  const deliver = useCallback(
    async (item: ChatItem) => {
      try {
        const row = await insertMessage({ id: item.id, room_id: item.room_id, sender_id: item.sender_id!, body: item.body! });
        apply((s) => ({ ...s, messages: merge(s.messages.filter((m) => m.id !== row.id), [row]) }));
      } catch {
        apply((s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === item.id ? { ...m, pending: 'failed' } : m)),
        }));
      }
    },
    [apply],
  );

  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || !userId) return;
      const item: ChatItem = {
        id: randomUUID(),
        room_id: roomId,
        sender_id: userId,
        kind: 'text',
        body,
        media_id: null,
        created_at: new Date().toISOString(),
        pending: 'sending',
      };
      apply((s) => ({ ...s, messages: [item, ...s.messages] }));
      deliver(item);
    },
    [roomId, userId, apply, deliver],
  );

  const retry = useCallback(
    (id: string) => {
      const item = messagesRef.current.find((m) => m.id === id && m.pending === 'failed');
      if (!item) return;
      apply((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, pending: 'sending' } : m)) }));
      deliver(item);
    },
    [apply, deliver],
  );

  const discard = useCallback(
    (id: string) => apply((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== id) })),
    [apply],
  );

  return { ...state, send, retry, discard, loadOlder, reload: refreshLatest };
}
