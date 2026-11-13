// Host-defined entry questions (planning/QREWING_AI_SPEC_EN.md section 9): the pure editor and answer rules.
// No React Native imports, so `npm test` loads it. The server (0028) checks the same caps (22023).

export type EntryQuestionKind = 'short' | 'long' | 'links';

/** A question as the host edits it on Create room. `key` is local only (list keys, focus); the server assigns ids. */
export type DraftQuestion = { key: string; kind: EntryQuestionKind; prompt: string; required: boolean };

/** A row of public.entry_questions as the client reads it. */
export type EntryQuestion = { id: string; position: number; kind: EntryQuestionKind; prompt: string; required: boolean };

/** What set_entry_questions takes, in order. */
export type QuestionPayload = { kind: EntryQuestionKind; prompt: string; required: boolean };

/** entry_profiles.answers: question id -> a string (short, long) or a string array (links). */
export type EntryAnswers = Record<string, string | string[]>;

export const QUESTION_LIMITS = { min: 1, max: 8, prompt: 120 } as const;
export const ANSWER_LIMITS = { short: 80, long: 300, links: 3, link: 200 } as const;
export const QUESTION_KINDS: readonly EntryQuestionKind[] = ['short', 'long', 'links'];

/** The default four (spec 9.1), the editor's starting list. */
export const DEFAULT_QUESTIONS: readonly QuestionPayload[] = [
  { kind: 'short', prompt: 'Headline', required: true },
  { kind: 'long', prompt: 'Interests', required: false },
  { kind: 'long', prompt: 'Looking for', required: false },
  { kind: 'links', prompt: 'Links', required: false },
];

// --- editor -----------------------------------------------------------------------------------------------------

let nextKey = 0;
const newKey = () => `q${++nextKey}`;

export function defaultDraft(): DraftQuestion[] {
  return DEFAULT_QUESTIONS.map((q) => ({ ...q, key: newKey() }));
}

/** Adds an empty optional question at the end; unchanged at the cap. */
export function addQuestion(list: DraftQuestion[], kind: EntryQuestionKind): DraftQuestion[] {
  if (list.length >= QUESTION_LIMITS.max) return list;
  return [...list, { key: newKey(), kind, prompt: '', required: false }];
}

/** Removes a question; the last one stays (at least one is needed). */
export function removeQuestion(list: DraftQuestion[], key: string): DraftQuestion[] {
  if (list.length <= QUESTION_LIMITS.min) return list;
  return list.filter((q) => q.key !== key);
}

/** Moves a question one place up (-1) or down (+1); unchanged at either end. */
export function moveQuestion(list: DraftQuestion[], key: string, by: -1 | 1): DraftQuestion[] {
  const i = list.findIndex((q) => q.key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function updateQuestion(
  list: DraftQuestion[],
  key: string,
  patch: Partial<Pick<DraftQuestion, 'kind' | 'prompt' | 'required'>>,
): DraftQuestion[] {
  return list.map((q) => (q.key === key ? { ...q, ...patch } : q));
}

export function canAdd(list: DraftQuestion[]): boolean {
  return list.length < QUESTION_LIMITS.max;
}
export function canRemove(list: DraftQuestion[]): boolean {
  return list.length > QUESTION_LIMITS.min;
}

export type QuestionProblem = 'noQuestions' | 'tooManyQuestions' | 'promptRequired' | 'promptTooLong';

/** Trims prompts; the payload to send, or the first problem (with the question's key when it is one question's). */
export function validateQuestions(
  list: DraftQuestion[],
): { value: QuestionPayload[] } | { problem: QuestionProblem; key?: string } {
  if (list.length < QUESTION_LIMITS.min) return { problem: 'noQuestions' };
  if (list.length > QUESTION_LIMITS.max) return { problem: 'tooManyQuestions' };
  const value: QuestionPayload[] = [];
  for (const q of list) {
    const prompt = q.prompt.trim();
    if (!prompt) return { problem: 'promptRequired', key: q.key };
    if (chars(prompt) > QUESTION_LIMITS.prompt) return { problem: 'promptTooLong', key: q.key };
    value.push({ kind: q.kind, prompt, required: q.required });
  }
  return { value };
}

// --- answers ----------------------------------------------------------------------------------------------------

/** The form's state: one string per short/long question, ANSWER_LIMITS.links strings per links question. */
export type AnswerDraft = Record<string, string | string[]>;

/** Questions in position order (the form and the server agree on order by position, not by fetch order). */
export function ordered(questions: EntryQuestion[]): EntryQuestion[] {
  return [...questions].sort((a, b) => a.position - b.position);
}

/** The form's starting values from a saved answers object (missing or wrong-typed answers start empty). */
export function answerDraft(questions: EntryQuestion[], saved: unknown): AnswerDraft {
  const src = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const out: AnswerDraft = {};
  for (const q of questions) {
    const v = src[q.id];
    if (q.kind === 'links') {
      const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      out[q.id] = Array.from({ length: ANSWER_LIMITS.links }, (_, i) => arr[i] ?? '');
    } else {
      out[q.id] = typeof v === 'string' ? v : '';
    }
  }
  return out;
}

export function answersDirty(loaded: AnswerDraft, current: AnswerDraft): boolean {
  const keys = new Set([...Object.keys(loaded), ...Object.keys(current)]);
  for (const k of keys) {
    const a = loaded[k];
    const b = current[k];
    if (Array.isArray(a) || Array.isArray(b)) {
      const x = Array.isArray(a) ? a : [];
      const y = Array.isArray(b) ? b : [];
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return true;
    } else if ((a ?? '') !== (b ?? '')) return true;
  }
  return false;
}

export type AnswerProblem = 'required' | 'tooLong' | 'tooManyLinks' | 'linkInvalid';

// Case-sensitive like the server (spec 9.2 `^https://`). Lengths count code points like Postgres char_length.
const HTTPS = /^https:\/\/\S+$/;
const chars = (text: string) => [...text].length;

export function answerLimit(kind: EntryQuestionKind): number {
  return kind === 'short' ? ANSWER_LIMITS.short : kind === 'long' ? ANSWER_LIMITS.long : ANSWER_LIMITS.link;
}

/**
 * Trims every answer and drops empty links; the answers to send (empty optional answers left out), or the first
 * problem in position order with its question id. Mirrors upsert_entry_answers (22023).
 */
export function validateAnswers(
  questions: EntryQuestion[],
  draft: AnswerDraft,
): { value: EntryAnswers } | { problem: AnswerProblem; questionId: string } {
  const value: EntryAnswers = {};
  for (const q of ordered(questions)) {
    const raw = draft[q.id];
    if (q.kind === 'links') {
      const links = (Array.isArray(raw) ? raw : []).map((l) => l.trim()).filter((l) => l.length > 0);
      if (q.required && links.length === 0) return { problem: 'required', questionId: q.id };
      if (links.length > ANSWER_LIMITS.links) return { problem: 'tooManyLinks', questionId: q.id };
      if (links.some((l) => !HTTPS.test(l) || chars(l) > ANSWER_LIMITS.link)) return { problem: 'linkInvalid', questionId: q.id };
      if (links.length) value[q.id] = links;
    } else {
      const text = (typeof raw === 'string' ? raw : '').trim();
      if (q.required && !text) return { problem: 'required', questionId: q.id };
      if (chars(text) > answerLimit(q.kind)) return { problem: 'tooLong', questionId: q.id };
      if (text) value[q.id] = text;
    }
  }
  return { value };
}

// --- server errors ----------------------------------------------------------------------------------------------

export type EntryQuestionsError = 'notHost' | 'invalid' | 'locked' | 'network' | 'failed';

/** set_entry_questions / upsert_entry_answers Postgres codes (spec 9.2): 42501 host only, 22023 invalid, 55000 locked. */
export function entryQuestionsErrorKind(code: string | null | undefined, offline: boolean): EntryQuestionsError {
  if (offline) return 'network';
  switch (code) {
    case '42501':
      return 'notHost';
    case '22023':
      return 'invalid';
    case '55000':
      return 'locked';
    default:
      return 'failed';
  }
}

/** Rows from public.entry_questions, dropping anything malformed, in position order. */
export function parseQuestions(rows: unknown): EntryQuestion[] {
  if (!Array.isArray(rows)) return [];
  const out: EntryQuestion[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { id, position, kind, prompt, required } = r as Record<string, unknown>;
    if (typeof id !== 'string' || typeof position !== 'number' || typeof prompt !== 'string') continue;
    if (kind !== 'short' && kind !== 'long' && kind !== 'links') continue;
    out.push({ id, position, kind, prompt, required: required === true });
  }
  return ordered(out);
}
