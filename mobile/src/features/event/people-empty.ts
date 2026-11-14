/**
 * People to meet empty states (UI audit 7). A room with no entry questions can never get suggestions, so it says
 * so instead of "Tell Qrewing about you" plus "Add my entry info", which led to the entry screen's dead end.
 * questions: the same useEntryQuestions read the entry screen uses.
 */
export type PeopleEmpty = 'noQuestions' | 'noEntry' | 'noMatches' | null;

export function peopleEmpty(input: {
  status: 'loading' | 'pending' | 'error' | 'ready';
  error: string | null;
  matches: number;
  notConsented: boolean;
  questions: { loaded: boolean; failed: boolean; count: number };
}): PeopleEmpty {
  if (input.notConsented) return null;
  const noEntry = input.status === 'error' && input.error === 'no_entry';
  const noMatches = input.status === 'ready' && input.matches === 0;
  if (!noEntry && !noMatches) return null;
  const q = input.questions;
  if (q.loaded && !q.failed && q.count === 0) return 'noQuestions';
  return noEntry ? 'noEntry' : 'noMatches';
}
