import { useEffect, useState } from 'react';

import { type EndedRoomFields, type EndSeen, endTimerDelay, roomOverState } from './room-ended';

/**
 * G-U6-1: whether a loaded room is over while its screen stays open, for Photos & files, Map, Info and the other
 * room screens (Chat keeps its own clock). One timer armed for the room's end time, not a poll; the realtime
 * notices and server reads that each screen already makes cover a host's End and a removed row.
 * `nowMs` is when the end was seen, for the ended screen's "closed at" line.
 */
export function useRoomOver(room: EndedRoomFields | null | undefined): { over: boolean; nowMs?: number } {
  const expiresAt = room?.expires_at ?? null;
  const [seen, setSeen] = useState<EndSeen | null>(null);

  useEffect(() => {
    if (!expiresAt) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const delay = endTimerDelay(expiresAt, Date.now());
      if (delay === null) return;
      timer = setTimeout(() => {
        const now = Date.now();
        // setTimeout can fire a little early, and a capped wait fires long before the end: arm again.
        if (endTimerDelay(expiresAt, now) === 0) setSeen({ expiresAt, atMs: now });
        else arm();
      }, delay);
    };
    arm();
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return roomOverState(room, seen);
}
