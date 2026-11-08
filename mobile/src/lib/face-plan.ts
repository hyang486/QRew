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

// FM-Q A′-2: temporary detection copies -------------------------------------------------------------------
// At match time this device makes a ~1920px JPEG (EXIF/GPS dropped by the re-encode) of each photo it is about
// to submit, uploads it to room-media/{room}/{media}/detect/{enrollment}.jpg, and the face-match function compares
// it and deletes it at once. Format: keep in sync with supabase/functions/_shared/detect.ts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Long edge of a detection copy (the 480px preview was too small for small faces). */
export const DETECT_LONG_EDGE = 1920;
/** Jobs per face-match call; the function accepts at most 5 job ids, and each copy lives for one call. */
export const DETECT_BATCH_SIZE = 5;
/** Photos prepared at once on the device (memory and data use). */
export const DETECT_CONCURRENCY = 2;
/** Rekognition's inline image limit; the function falls back to the preview above it. */
export const DETECT_MAX_BYTES = 5 * 1024 * 1024;

export function faceDetectPath(roomId: string, mediaId: string, enrollmentId: string): string | null {
  if (![roomId, mediaId, enrollmentId].every((s) => UUID_RE.test(s))) return null;
  return `${roomId}/${mediaId}/detect/${enrollmentId}.jpg`;
}

/** Resize for a detection copy: long edge to DETECT_LONG_EDGE, or null to keep the size (never `{}`, see F7-1). */
export function detectResize(width: number | null | undefined, height: number | null | undefined): { width: number } | { height: number } | null {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (Math.max(width, height) <= DETECT_LONG_EDGE) return null;
  return width >= height ? { width: DETECT_LONG_EDGE } : { height: DETECT_LONG_EDGE };
}

type DetectJobLike = JobLike & { id: string; media_id: string; created_at: string };

/**
 * The jobs the function would claim (queued, or running-stale with attempts left, under the attempt cap),
 * oldest first, split into batches of DETECT_BATCH_SIZE. Only these get a detection copy.
 */
export function detectBatches<J extends DetectJobLike>(jobs: readonly J[], now: number): J[][] {
  const open = jobs
    .filter((j) => {
      if (j.attempts >= FACE_JOB_MAX_ATTEMPTS) return false;
      if (j.status === 'queued') return true;
      return j.status === 'running' && now - Date.parse(j.updated_at) > FACE_JOB_STALE_MS;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const out: J[][] = [];
  for (let i = 0; i < open.length; i += DETECT_BATCH_SIZE) out.push(open.slice(i, i + DETECT_BATCH_SIZE));
  return out;
}

/**
 * Upload result. 'exists': a copy from an interrupted run is still there (insert-only path, so no overwrite).
 * Only this member can write that path, for the same immutable ready photo, so the copy is used as is.
 */
export function classifyDetectUpload(error: { message?: string; statusCode?: string | number; status?: string | number } | null): 'uploaded' | 'exists' | 'failed' {
  if (!error) return 'uploaded';
  const code = String(error.statusCode ?? error.status ?? '');
  if (code === '409' || /already exists|duplicate/i.test(error.message ?? '')) return 'exists';
  return 'failed';
}

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}
