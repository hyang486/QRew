// Pure logic for the event features (entry form, consent gate, Mute small talk). No React Native imports, so
// `npm test` can load it.

/** Spec 1.3 limits; the server checks the same (22023). */
export const ENTRY_LIMITS = { headline: 80, interests: 300, lookingFor: 300, links: 3, link: 200 } as const;

export type EntryInput = { headline: string; interests: string; lookingFor: string; links: string[] };
export type EntryProblem = 'headlineRequired' | 'headlineTooLong' | 'interestsTooLong' | 'lookingForTooLong' | 'tooManyLinks' | 'linkInvalid';

/** Trims every field and drops empty links; returns the value to send or the first problem. */
export function validateEntry(input: EntryInput): { value: EntryInput } | { problem: EntryProblem } {
  const headline = input.headline.trim();
  const interests = input.interests.trim();
  const lookingFor = input.lookingFor.trim();
  const links = input.links.map((l) => l.trim()).filter((l) => l.length > 0);
  if (!headline) return { problem: 'headlineRequired' };
  if (headline.length > ENTRY_LIMITS.headline) return { problem: 'headlineTooLong' };
  if (interests.length > ENTRY_LIMITS.interests) return { problem: 'interestsTooLong' };
  if (lookingFor.length > ENTRY_LIMITS.lookingFor) return { problem: 'lookingForTooLong' };
  if (links.length > ENTRY_LIMITS.links) return { problem: 'tooManyLinks' };
  if (links.some((l) => !/^https:\/\/\S+$/i.test(l) || l.length > ENTRY_LIMITS.link)) return { problem: 'linkInvalid' };
  return { value: { headline, interests, lookingFor, links } };
}

/** True when the form differs from what it loaded (qa F2: leaving then asks before input is thrown away). */
export function entryDirty(loaded: EntryInput, current: EntryInput): boolean {
  return (
    loaded.headline !== current.headline ||
    loaded.interests !== current.interests ||
    loaded.lookingFor !== current.lookingFor ||
    loaded.links.length !== current.links.length ||
    loaded.links.some((l, i) => l !== current.links[i])
  );
}

type Me = { aiOk: boolean; mute: boolean } | null;

/** The disclosure shows once per member per AI room: until they answer (Agree or Not now both create their row). */
export function needsDisclosure(aiEnabled: boolean, me: Me): boolean {
  return aiEnabled && me === null;
}

/** Client gate before chat: event rooms that ask for entry info, for members who have not filled it in. */
export function needsEntry(entryRequired: boolean, roomType: string, hasProfile: boolean | null): boolean {
  return entryRequired && roomType === 'event' && hasProfile === false;
}

/**
 * The two chat gates, independent (B1): the disclosure sheet asks until the member answers, and the entry form
 * locks the list and composer until they fill it in. Closing the sheet without an answer (iOS swipe) hides the
 * sheet only; the entry gate still applies.
 */
export function chatGates(
  aiEnabled: boolean,
  me: Me,
  entryRequired: boolean,
  roomType: string,
  hasProfile: boolean | null,
): { disclosure: boolean; entry: boolean } {
  return { disclosure: needsDisclosure(aiEnabled, me), entry: needsEntry(entryRequired, roomType, hasProfile) };
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `body` mentions me personally (qa ruling 2026-11-12 Q1): "@" plus my full display name or its first
 * word, case-insensitive, NFC-normalized, word-bounded on both sides. The "@" must not follow a letter, digit,
 * "_", "." or another "@", so an email address ("x@bob.com") never matches; the name must end at a non-word
 * character, so "@Bobby" does not mention Bob. A bare name without "@" does not count. Names (or first words)
 * shorter than 2 characters never match. Such a message stays visible only for me; "@everyone"/"@all"/"@here" and
 * host messages come back important from the server for everyone.
 */
export function mentionsName(body: string | null | undefined, displayName: string | null | undefined): boolean {
  if (!body || !displayName) return false;
  const re = mentionRegExp(displayName);
  return re !== null && re.test(body.normalize('NFC'));
}

// One RegExp per display name (the chat checks every row); the last name only, since a phone has one user.
let mentionCache: { key: string; re: RegExp | null } | null = null;
function mentionRegExp(displayName: string): RegExp | null {
  if (mentionCache?.key === displayName) return mentionCache.re;
  const name = displayName.normalize('NFC').trim().replace(/\s+/g, ' ');
  const first = name.split(' ')[0];
  const names = [...new Set([name, first])].filter((n) => n.length >= 2);
  const re = names.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}_.@])@(?:${names.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'iu')
    : null;
  mentionCache = { key: displayName, re };
  return re;
}

export type ChatLike = { id: string; kind: string; sender_id: string | null; body: string | null };
/** A message's triage result. Only `done` rows are judged; `pending` and `skipped` (sender not consented, daily cap) are not. */
export type Importance = { state: 'done' | 'pending' | 'skipped'; important: boolean; reason: string | null };

/**
 * Whether a row stays visible while Mute small talk is on. Only text from someone else that triage judged
 * (`done`) and found not important is hidden, unless it mentions me. Unjudged, pending and skipped rows stay
 * visible, so a muted member still sees senders who did not consent. Notices (arrival, status, emergency, media,
 * system) and my own messages always show.
 */
export function staysVisible(
  item: ChatLike,
  userId: string | undefined,
  myName: string | undefined,
  flags: ReadonlyMap<string, Importance>,
): boolean {
  if (item.kind !== 'text') return true;
  if (!item.sender_id || item.sender_id === userId) return true;
  const flag = flags.get(item.id);
  if (!flag || flag.state !== 'done' || flag.important) return true;
  return mentionsName(item.body, myName);
}

export type MutedRow<T> = { type: 'message'; item: T } | { type: 'hidden'; key: string; ids: string[] };

/**
 * Collapses each run of hidden rows into one "N messages hidden" row (still reachable: `expanded` keys show
 * the run again). Order is kept, so it works on the inverted (newest first) list too. A run's key is its
 * last id (the oldest in a newest-first list), which stays stable while new messages arrive at the front.
 */
export function collapseSmallTalk<T extends ChatLike>(
  items: readonly T[],
  visible: (item: T) => boolean,
  expanded: ReadonlySet<string>,
): MutedRow<T>[] {
  const out: MutedRow<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const key = `hidden-${run[run.length - 1].id}`;
    if (expanded.has(key)) for (const item of run) out.push({ type: 'message', item });
    else out.push({ type: 'hidden', key, ids: run.map((r) => r.id) });
    run = [];
  };
  for (const item of items) {
    if (visible(item)) {
      flush();
      out.push({ type: 'message', item });
    } else {
      run.push(item);
    }
  }
  flush();
  return out;
}

/**
 * Batches new message ids for triage (spec 3.2: up to 5 within 2 s). `add` starts the timer on the first id;
 * a full batch flushes at once. Timers are injected so tests run without waiting.
 */
export function createTriageBatcher(opts: {
  flush: (ids: string[]) => void;
  maxBatch?: number;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const maxBatch = opts.maxBatch ?? 5;
  const delayMs = opts.delayMs ?? 2_000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: string[] = [];
  const seen = new Set<string>();
  let timer: unknown = null;

  function run() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (pending.length === 0) return;
    const ids = pending;
    pending = [];
    opts.flush(ids);
  }

  return {
    add(id: string) {
      if (seen.has(id)) return;
      seen.add(id);
      pending.push(id);
      if (pending.length >= maxBatch) run();
      else if (timer === null) timer = setTimer(run, delayMs);
    },
    flushNow: run,
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
    },
  };
}

type Timed = ChatLike & { created_at: string; pending?: unknown };

/** The newest loaded (not pending) message time in ms, or 0 when there is none. Marks the start of a mute session. */
export function newestMs(items: readonly Timed[]): number {
  let max = 0;
  for (const m of items) {
    if (m.pending) continue;
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * B2: whether the chat has had one successful load (latched). A mute session starts only after that, so a failed
 * first page (empty list, newestMs 0) never makes old messages look new when a later load brings them in.
 */
export function nextLoadedOnce(prev: boolean, loading: boolean, error: unknown): boolean {
  return prev || (!loading && (error === null || error === undefined));
}

export type ImportantBanner = { messageId: string; reason: string | null; mention: boolean; createdMs: number };

/**
 * The banner for the newest important text from someone else that arrived in this mute session (after `since`)
 * and was not dismissed. A mention wins without AI; otherwise the triage flag decides. Null when none.
 */
export function pickBanner(
  items: readonly Timed[],
  opts: {
    since: number;
    userId: string | undefined;
    myName: string | undefined;
    flags: ReadonlyMap<string, Importance>;
    dismissed: ReadonlySet<string>;
  },
): ImportantBanner | null {
  let best: ImportantBanner | null = null;
  for (const m of items) {
    if (m.pending || m.kind !== 'text' || !m.sender_id || m.sender_id === opts.userId) continue;
    if (opts.dismissed.has(m.id)) continue;
    const t = Date.parse(m.created_at);
    if (!Number.isFinite(t) || t <= opts.since) continue;
    if (best && t <= best.createdMs) continue;
    const mention = mentionsName(m.body, opts.myName);
    const flag = opts.flags.get(m.id);
    if (!mention && !(flag?.state === 'done' && flag.important)) continue;
    best = { messageId: m.id, reason: mention ? null : (flag?.reason ?? null), mention, createdMs: t };
  }
  return best;
}

/** Each member's links from entry info, keeping only https links (shown only, never fetched by Qrewing). */
export function linksByUser(profiles: readonly { user_id: string; links: readonly string[] | null }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of profiles) {
    const links = (p.links ?? []).filter((l) => /^https:\/\/\S+$/i.test(l)).slice(0, 3);
    if (links.length > 0) out.set(p.user_id, links);
  }
  return out;
}
