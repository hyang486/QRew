import { requireOptionalNativeModule } from 'expo';
import { Vibration } from 'react-native';

import { enqueue, finish, newSpeechQueue, speechBudgetMs, type Utterance } from './speech-queue';

/**
 * Spoken cues through expo-speech. Its JS entry calls requireNativeModule, which throws on a build made before
 * expo-speech was added, so it is loaded only when the native module is present; otherwise cues vibrate.
 */
type SpeechApi = typeof import('expo-speech');
const speech: SpeechApi | null =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  requireOptionalNativeModule('ExpoSpeech') != null ? (require('expo-speech') as SpeechApi) : null;
const VIBRATE = [0, 250, 150, 250];
let nextId = 0;

/** Whether cues are spoken on this build. */
export const canSpeak = speech != null;

// One cue at a time: a cue that arrives while another is spoken waits for its end (only the newest waits).
let queue = newSpeechQueue();
let budgetTimer: ReturnType<typeof setTimeout> | null = null;

function say(u: Utterance | null) {
  if (!u || !speech) return;
  if (budgetTimer) clearTimeout(budgetTimer);
  // If no callback comes, the cue's time budget ends it.
  budgetTimer = setTimeout(() => ended(u.id), speechBudgetMs(u.text));
  try {
    speech.speak(u.text, {
      language: 'en-US',
      onDone: () => ended(u.id),
      onStopped: () => ended(u.id),
      onError: () => {
        Vibration.vibrate(VIBRATE);
        ended(u.id);
      },
    });
  } catch {
    Vibration.vibrate(VIBRATE);
    ended(u.id);
  }
}

function ended(id: string) {
  const r = finish(queue, id, Date.now());
  queue = r.queue;
  if (!queue.speaking && budgetTimer) {
    clearTimeout(budgetTimer);
    budgetTimer = null;
  }
  say(r.say);
}

/** Stops the cue being spoken and drops the waiting one (switch or sharing off, activity ended, screen left). */
export function stopSpeech() {
  queue = newSpeechQueue();
  if (budgetTimer) {
    clearTimeout(budgetTimer);
    budgetTimer = null;
  }
  speech?.stop().catch(() => {});
}

type Listener = (text: string) => void;
const listeners = new Set<Listener>();

/** The on-screen cue banner subscribes here; every cue is also shown, spoken or not. */
export function onCue(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Speaks a cue when possible (after the one being spoken), otherwise vibrates; the banner shows `text` either way.
 * `spoken` is the wording for speech (pace-core spokenCue: no m:ss, no "km"); `text` is spoken when it is absent.
 */
export function speak(text: string, spoken?: string) {
  if (speech) {
    const r = enqueue(queue, { id: String(++nextId), text: spoken ?? text }, Date.now());
    queue = r.queue;
    say(r.say);
  } else {
    Vibration.vibrate(VIBRATE);
  }
  for (const l of listeners) l(text);
}
