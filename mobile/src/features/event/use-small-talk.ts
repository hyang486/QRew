// Mute small talk (spec 3.2): collapse rows that are not important, triage new text from others in batches,
// vibrate and show a banner for important ones. In-app only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Vibration } from 'react-native';

import { supabase } from '@/lib/supabase';

import {
  type ChatLike,
  createTriageBatcher,
  type Importance,
  type ImportantBanner,
  mentionsName,
  newestMs,
  nextLoadedOnce,
  pickBanner,
  staysVisible,
} from './event-plan';
import { createPendingRechecker } from './pending-recheck';
import { triageMessages } from './qrewing-api';
import type { MessageTriageRow, QrewingError } from './types';

export type { ImportantBanner };

type Item = ChatLike & { created_at: string; pending?: unknown };
type Flag = { id: string; important: boolean | null; reason: string | null; state: Importance['state'] };

async function readTriage(ids: string[]): Promise<Flag[]> {
  if (ids.length === 0) return [];
  const { data } = await supabase.from('message_triage').select('*').in('message_id', ids);
  return ((data ?? []) as MessageTriageRow[]).map((r) => ({ id: r.message_id, important: r.important, reason: r.reason, state: r.state }));
}

export function useSmallTalk({
  roomId,
  userId,
  myName,
  muted,
  ready,
  loadError,
  messages,
}: {
  roomId: string;
  userId: string | undefined;
  myName: string | undefined;
  /** Mute small talk is on and I agreed to the disclosure. */
  muted: boolean;
  /** The first page of messages is not loading. */
  ready: boolean;
  /** The last load failed (B2: no mute session until a load succeeds). */
  loadError?: unknown;
  /** Newest first, as the chat list holds them. */
  messages: readonly Item[];
}) {
  const [flags, setFlags] = useState<ReadonlyMap<string, Importance>>(() => new Map());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [unavailable, setUnavailable] = useState<QrewingError | null>(null);

  // A mute session starts when mute is on and the first page is loaded. Only messages newer than the newest one
  // loaded at that moment are triaged and can alert; older ones only read existing flags.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const loadedNow = nextLoadedOnce(loadedOnce, !ready, loadError);
  if (loadedNow !== loadedOnce) setLoadedOnce(loadedNow);
  const session = muted && loadedNow ? 'on' : 'off';
  const [prevSession, setPrevSession] = useState<'on' | 'off'>('off');
  const [since, setSince] = useState<number | null>(null);
  if (session !== prevSession) {
    setPrevSession(session);
    setUnavailable(null);
    setDismissed(new Set());
    setSince(session === 'on' ? newestMs(messages) : null);
  }

  const applyFlags = useCallback((rows: Flag[]) => {
    const done = rows.filter((r) => r.state !== 'pending');
    if (done.length === 0) return;
    setFlags((cur) => {
      const next = new Map(cur);
      for (const r of done) next.set(r.id, { state: r.state, important: r.important === true, reason: r.reason });
      return next;
    });
  }, []);

  const batcher = useRef<ReturnType<typeof createTriageBatcher> | null>(null);
  const rechecker = useRef<ReturnType<typeof createPendingRechecker<Flag>> | null>(null);
  // Rechecks run only while mute is on.
  useEffect(() => {
    if (session === 'off') rechecker.current?.clear();
  }, [session]);
  useEffect(() => {
    let alive = true;
    // Another member's call is computing these: re-read the shared rows with backoff until done or skipped.
    const recheck = createPendingRechecker<Flag>({ read: readTriage, apply: (rows) => alive && applyFlags(rows) });
    rechecker.current = recheck;
    const b = createTriageBatcher({
      flush: async (ids) => {
        const res = await triageMessages(roomId, ids);
        if (!alive) return;
        if ('error' in res) {
          // Without triage nothing may stay hidden: show everything and say why.
          setUnavailable(res.error);
          return;
        }
        applyFlags(res.map((r) => ({ id: r.messageId, important: r.important, reason: r.reason, state: r.state })));
        const pending = res.filter((r) => r.state === 'pending').map((r) => r.messageId);
        if (pending.length > 0) recheck.add(pending);
      },
    });
    batcher.current = b;
    return () => {
      alive = false;
      b.cancel();
      recheck.cancel();
      rechecker.current = null;
      batcher.current = null;
    };
  }, [roomId, applyFlags]);

  // Existing flags for the loaded messages (no model call).
  const unknownKey = muted
    ? messages
        .filter((m) => m.kind === 'text' && !m.pending && !flags.has(m.id))
        .slice(0, 200)
        .map((m) => m.id)
        .join(',')
    : '';
  useEffect(() => {
    if (!unknownKey) return;
    let alive = true;
    readTriage(unknownKey.split(','))
      .then((rows) => alive && applyFlags(rows))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [unknownKey, applyFlags]);

  // New text from others in this mute session goes to triage, unless it mentions me (important without AI).
  const queued = useRef(new Set<string>());
  useEffect(() => {
    if (since === null || unavailable) return;
    for (const m of messages) {
      if (m.pending || m.kind !== 'text' || !m.sender_id || m.sender_id === userId) continue;
      if (queued.current.has(m.id) || flags.has(m.id)) continue;
      if (Date.parse(m.created_at) <= since) continue;
      queued.current.add(m.id);
      // A mention is important without AI: no model call.
      if (mentionsName(m.body, myName)) continue;
      batcher.current?.add(m.id);
    }
  }, [messages, since, unavailable, userId, myName, flags]);

  const banner = useMemo(
    () => (since === null ? null : pickBanner(messages, { since, userId, myName, flags, dismissed })),
    [messages, since, userId, myName, flags, dismissed],
  );

  const bannerId = banner?.messageId;
  useEffect(() => {
    if (bannerId) Vibration.vibrate();
  }, [bannerId]);

  const visible = useCallback((item: ChatLike) => staysVisible(item, userId, myName, flags), [userId, myName, flags]);
  const dismissBanner = useCallback(() => {
    if (bannerId) setDismissed((cur) => new Set(cur).add(bannerId));
  }, [bannerId]);

  return {
    /** Collapse only while muted and triage is working. */
    active: muted && !unavailable,
    unavailable,
    visible,
    banner,
    dismissBanner,
  };
}
