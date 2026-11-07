// Pure rules for "Photos of me" (room-scoped face matching). Server side: face_enrollments,
// face_jobs and face_matches (own rows only, RLS) and the face-match Edge Function, which returns
// 503 face_match_disabled while FACE_MATCH_ENABLED is off.

/** Same as MAX_ATTEMPTS in supabase/functions/face-match/core.ts. */
export const FACE_JOB_MAX_ATTEMPTS = 3;
/** The function retakes a 'running' job after this long (crashed worker). */
export const FACE_JOB_STALE_MS = 5 * 60_000;

type MediaLike = { id: string; kind: string; status: string };
type MatchLike = { media_id: string; matched: boolean; excluded: boolean };
type JobLike = { status: string; attempts: number; updated_at: string };

/** Ready photos that the service matched to me and that I did not mark "Not me", in the given media order. */
export function photosOfMe<M extends MediaLike>(media: readonly M[], matches: readonly MatchLike[]): M[] {
  const mine = new Set(matches.filter((m) => m.matched && !m.excluded).map((m) => m.media_id));
  return media.filter((m) => m.kind === 'photo' && m.status === 'ready' && mine.has(m.id));
}

/**
 * Pending = queued, or running and either still fresh or retakeable. Failed = failed, or running,
 * stale and out of attempts (the function never retakes it).
 */
export function faceJobCounts(jobs: readonly JobLike[], now: number): { pending: number; failed: number } {
  let pending = 0;
  let failed = 0;
  for (const j of jobs) {
    if (j.status === 'queued') pending++;
    else if (j.status === 'failed') failed++;
    else if (j.status === 'running') {
      const stale = now - Date.parse(j.updated_at) > FACE_JOB_STALE_MS;
      if (stale && j.attempts >= FACE_JOB_MAX_ATTEMPTS) failed++;
      else pending++;
    }
  }
  return { pending, failed };
}

export type MatchRun = { kind: 'ok' } | { kind: 'disabled' } | { kind: 'error'; message: string };

/** Classifies a face-match call. status 0 = no HTTP response (network). */
export function classifyMatchRun(r: { status: number; error?: string }): MatchRun {
  if (r.status >= 200 && r.status < 300) return { kind: 'ok' };
  if (r.status === 503 && r.error === 'face_match_disabled') return { kind: 'disabled' };
  return { kind: 'error', message: r.error ?? `HTTP ${r.status}` };
}

/** FG-2: call the function right after enrolling, or while my enrollment still has pending jobs. */
export function shouldRunMatch(justEnrolled: boolean, pending: number): boolean {
  return justEnrolled || pending > 0;
}

export type FaceViewState = 'consent' | 'disabled' | 'error' | 'checking' | 'ready';

/**
 * What the Photos of me view shows. Disabled hides every match badge and count (FG-3), so it wins
 * over pending work; so does an error.
 */
export function faceViewState(s: { enrolled: boolean; run: MatchRun | null; pending: number }): FaceViewState {
  if (!s.enrolled) return 'consent';
  if (s.run?.kind === 'disabled') return 'disabled';
  if (s.run?.kind === 'error') return 'error';
  return s.pending > 0 ? 'checking' : 'ready';
}

/** Longest side kept for a face reference; wider images are scaled down to this width. */
export const FACE_REF_WIDTH = 1280;

/**
 * F7-1: the resize for a face reference, or null to keep the size. Never an empty `{}`: expo-image-manipulator
 * 58 then renders a 0x0 image and saveAsync fails ("Cannot create image data"), which broke every reference
 * not wider than FACE_REF_WIDTH. An unknown or invalid width also keeps the size.
 */
export function faceRefResize(width: number | null | undefined): { width: number } | null {
  return typeof width === 'number' && Number.isFinite(width) && width > FACE_REF_WIDTH ? { width: FACE_REF_WIDTH } : null;
}

/**
 * F7-2: the last face-match result per room. A run started on the enrollment screen must show in the
 * gallery that is already open underneath, so the view re-reads this on focus. A newer run replaces the
 * entry; rooms never share one; removing the enrollment or retrying clears it.
 */
export function createMatchRunCache() {
  const runs = new Map<string, MatchRun>();
  return {
    get: (roomId: string): MatchRun | null => runs.get(roomId) ?? null,
    set: (roomId: string, run: MatchRun) => {
      runs.set(roomId, run);
    },
    clear: (roomId: string) => {
      runs.delete(roomId);
    },
  };
}
