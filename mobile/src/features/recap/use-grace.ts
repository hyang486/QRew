import { useEffect, useState } from 'react';

import { useNow } from '@/lib/use-now';

import { type GraceRoomFields, graceTimerDelay, graceUntilMs } from './grace-plan';

/**
 * Spec 7.3: whether this room is in its early-end grace window, and until when. A one-shot timer at grace_until
 * re-renders the screen, so it switches to the plain Room ended state on time without polling.
 */
export function useGrace(room: GraceRoomFields | null | undefined): { grace: boolean; untilMs: number | null } {
  // The 30 s clock keeps a long-open screen current; the timer below lands the switch right at grace_until.
  const clock = useNow(30_000);
  const [tick, setTick] = useState(0);
  const deletedAt = room?.deleted_at ?? null;
  const graceUntil = room?.grace_until ?? null;

  useEffect(() => {
    const r = { deleted_at: deletedAt, expires_at: '', grace_until: graceUntil };
    const delay = graceTimerDelay(r, Date.now());
    if (delay === null) return;
    // A little late is fine; firing early is re-checked by graceUntilMs on the next render.
    const t = setTimeout(() => setTick(Date.now()), delay + 250);
    return () => clearTimeout(t);
  }, [deletedAt, graceUntil, tick]);

  const untilMs = graceUntilMs(room, Math.max(clock, tick));
  return { grace: untilMs !== null, untilMs };
}

/** "3:45 PM" for the grace lines. */
export function graceTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
