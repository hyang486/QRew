// Recap triggers on the open room screen (spec 7.3 scheduled end, 3.3 trigger C).
import { useEffect, useRef } from 'react';

import { useRoomEvents } from '@/lib/room-channel';

import { recapStep, SEND_SAVE_DEBOUNCE_MS, stepCall } from './recap-plan';
import {
  bumpOpenMessages,
  fetchAndSaveRecap,
  loadMark,
  readAndSaveRecap,
  saveMark,
  saveMessageCountWhileOpen,
  saveMyPartWhileOpen,
} from './recap-store';
import { onMessageSent } from './sent-signal';

/**
 * In an AI room: remembers the room had Qrewing on, asks for the recap once at 60 minutes left and once more with
 * `refresh` in the last 10 minutes (each once per device, kept in AsyncStorage), and saves a recap announced on
 * the room channel. Saves my part (counts only) once on open, adds one message per successful send, and recounts
 * exactly about 10 s after the last send, so grace keeps the last open count even with no server recap yet. Never blocks the screen; every failure is silent (the Room ended screen says when nothing
 * was saved).
 */
export function useRecapTriggers(roomId: string, userId: string | undefined, aiEnabled: boolean, remainingMs: number) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!aiEnabled || !userId) return;
    saveMyPartWhileOpen(roomId, userId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onMessageSent((id) => {
      if (id !== roomId) return;
      // Counted at once, so a room ended inside the debounce keeps it; the head count below reconciles it.
      bumpOpenMessages(roomId);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        saveMessageCountWhileOpen(roomId, userId);
      }, SEND_SAVE_DEBOUNCE_MS);
    });
    return () => {
      off();
      // Leaving within the debounce: count now (kept only if the room is still open).
      if (timer) {
        clearTimeout(timer);
        saveMessageCountWhileOpen(roomId, userId);
      }
    };
  }, [roomId, userId, aiEnabled]);

  useEffect(() => {
    if (!aiEnabled || !userId || inFlight.current) return;
    inFlight.current = true;
    (async () => {
      const mark = (await loadMark(roomId)) ?? (await saveMark(roomId, {}));
      const step = recapStep(remainingMs, mark);
      if (!step) return;
      const call = stepCall(step);
      // Marked before the call, so a slow or failed call is not repeated on the next tick.
      await saveMark(roomId, call.mark);
      await fetchAndSaveRecap(roomId, userId, call.refresh ? { refresh: true } : undefined);
    })()
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  }, [roomId, userId, aiEnabled, remainingMs]);

  useRoomEvents(roomId, (e) => {
    if (e.table === 'room_recaps' && aiEnabled && userId) readAndSaveRecap(roomId, userId).catch(() => {});
  });
}
