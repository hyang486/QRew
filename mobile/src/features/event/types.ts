/**
 * Row and response types for Qrewing AI (planning/QREWING_AI_SPEC_EN.md sections 1 and 2). Rows come from the
 * generated `database.types.ts` (0027 applied); the 2.x response types are the Edge Function contract, not DB.
 */

import type { Tables } from '@/lib/database.types';

export type QrewingError =
  | 'ai_not_configured'
  | 'ai_off'
  | 'not_member'
  | 'not_muted'
  | 'no_entry'
  | 'too_early'
  | 'not_consented'
  | 'ask_limit'
  | 'unclear'
  | 'rate_limited'
  | 'ai_failed'
  | 'network';

/** 1.1 public.qrewing_rooms */
export type QrewingRoomRow = Tables<'qrewing_rooms'>;

/** 1.2 public.qrewing_members */
export type QrewingMemberRow = Tables<'qrewing_members'>;

/** 1.3 public.entry_profiles */
export type EntryProfileRow = Tables<'entry_profiles'>;

/** 1.4 public.message_triage. `state` is a text column with a check constraint, so it is narrowed here. */
export type MessageTriageRow = Omit<Tables<'message_triage'>, 'state' | 'source'> & {
  state: 'pending' | 'done' | 'skipped';
  source: 'model' | 'rule';
};

/** 1.5 public.room_recaps. `state` is a text column with a check constraint, so it is narrowed here. */
export type RoomRecapRow = Omit<Tables<'room_recaps'>, 'state'> & { state: 'pending' | 'done' | 'failed' };

/** 2.1 triage response item */
export type TriageResult = {
  messageId: string;
  state: 'done' | 'pending' | 'skipped';
  important: boolean | null;
  reason: string | null;
};

/** 2.2 recap response (200) */
export type RecapResult = {
  state: 'done';
  title: string;
  summary: string;
  highlights: string[];
  generatedAt: string;
  cached: boolean;
  /** With `diary: true` (Qrewing Calendar): one emoji for the room's purpose and 1-3 first-person lines, or null. */
  emoji?: string;
  diary?: string[] | null;
};

/** 2.3 match response item */
export type Match = {
  userId: string;
  displayName: string;
  headline: string;
  reason: string;
  score: number;
};

/** 2.3 match response (200) */
export type MatchResult = {
  matches: Match[];
  cached: boolean;
  stale?: boolean;
  generatedAt: string;
};
