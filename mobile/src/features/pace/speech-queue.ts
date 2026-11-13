// One spoken cue at a time (spec 7.5). Pure, no imports, so node:test loads it directly; voice.ts drives it.

export type Utterance = { id: string; text: string };
export type SpeechQueue = {
  speaking: (Utterance & { untilMs: number }) | null;
  /** The next cue to say when the current one ends. Only the newest waits: an older waiting cue is stale. */
  pending: Utterance | null;
};

/** Upper bound for one cue when the native "done" event never comes: 1.5 s plus 90 ms a character, at most 20 s. */
export function speechBudgetMs(text: string): number {
  return Math.min(20_000, 1_500 + 90 * text.length);
}

export function newSpeechQueue(): SpeechQueue {
  return { speaking: null, pending: null };
}

function start(u: Utterance, nowMs: number) {
  return {
    queue: { speaking: { ...u, untilMs: nowMs + speechBudgetMs(u.text) }, pending: null },
    say: u,
  };
}

/** A new cue: said now when nothing is speaking (or the last one outlived its budget), otherwise it waits. */
export function enqueue(queue: SpeechQueue, u: Utterance, nowMs: number): { queue: SpeechQueue; say: Utterance | null } {
  if (queue.speaking && nowMs < queue.speaking.untilMs) return { queue: { ...queue, pending: u }, say: null };
  return start(u, nowMs);
}

/** The cue `id` ended (done, stopped, error, or its budget ran out): the waiting cue, if any, is said next. */
export function finish(queue: SpeechQueue, id: string, nowMs: number): { queue: SpeechQueue; say: Utterance | null } {
  if (queue.speaking?.id !== id) return { queue, say: null };
  if (!queue.pending) return { queue: newSpeechQueue(), say: null };
  return start(queue.pending, nowMs);
}
