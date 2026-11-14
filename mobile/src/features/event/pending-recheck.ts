/**
 * UI v2 (5): re-read triage rows that another member's call is still computing, with backoff, until they are done
 * or skipped. One read per due batch (per room: one rechecker per mute screen). There is no realtime on
 * message_triage, and a single re-read at 3 s missed a model result written at 3.6 s, so a small-talk message
 * stayed visible.
 */
export const PENDING_RECHECK_DELAYS_MS = [3_000, 6_000, 12_000, 24_000] as const;

export type RecheckRow = { id: string; state: 'pending' | 'done' | 'skipped' | string };

type Timers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createPendingRechecker<Row extends RecheckRow>(opts: {
  read: (ids: string[]) => Promise<Row[]>;
  /** Every row read, settled or not (the caller keeps only settled ones). */
  apply: (rows: Row[]) => void;
  delays?: readonly number[];
  timers?: Timers;
}) {
  const delays = opts.delays ?? PENDING_RECHECK_DELAYS_MS;
  const t = opts.timers ?? realTimers;
  // id -> the attempt it is waiting for and when that is due.
  const waiting = new Map<string, { attempt: number; dueAt: number }>();
  let timer: unknown = null;
  let timerAt = Infinity;
  let reading = false;
  let stopped = false;

  function arm() {
    if (stopped || reading) return;
    let next = Infinity;
    for (const w of waiting.values()) next = Math.min(next, w.dueAt);
    if (next === timerAt) return;
    if (timer != null) t.clearTimeout(timer);
    timer = null;
    timerAt = next;
    if (next === Infinity) return;
    timer = t.setTimeout(fire, Math.max(0, next - t.now()));
  }

  async function fire() {
    timer = null;
    timerAt = Infinity;
    if (stopped) return;
    const now = t.now();
    const due = [...waiting].filter(([, w]) => w.dueAt <= now).map(([id]) => id);
    if (due.length === 0) return arm();
    reading = true;
    let rows: Row[] = [];
    try {
      rows = await opts.read(due);
    } catch {
      // A failed read counts as still pending: the next attempt tries again.
    }
    reading = false;
    if (stopped) return;
    const settled = new Set(rows.filter((r) => r.state !== 'pending').map((r) => r.id));
    if (rows.length) opts.apply(rows);
    const at = t.now();
    for (const id of due) {
      const w = waiting.get(id);
      if (!w) continue;
      if (settled.has(id) || w.attempt + 1 >= delays.length) waiting.delete(id);
      else waiting.set(id, { attempt: w.attempt + 1, dueAt: at + delays[w.attempt + 1] });
    }
    arm();
  }

  return {
    /** Start (or keep) rechecking these ids; an id already waiting keeps its place in the backoff. */
    add(ids: string[]) {
      if (stopped) return;
      const at = t.now();
      for (const id of ids) if (!waiting.has(id)) waiting.set(id, { attempt: 0, dueAt: at + delays[0] });
      arm();
    },
    /** Mute off: drop what is waiting (a read in flight still applies its rows); add works again later. */
    clear() {
      waiting.clear();
      arm();
    },
    /** Room left or screen closed: no more reads. */
    cancel() {
      stopped = true;
      waiting.clear();
      if (timer != null) t.clearTimeout(timer);
      timer = null;
    },
    /** For tests: ids still waiting. */
    size: () => waiting.size,
  };
}
