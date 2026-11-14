import { detectObjectPath } from '../_shared/detect.ts';
import { FaceProviderError, MAX_IMAGE_BYTES, type CompareResult, type FaceProvider } from './provider.ts';

export const MAX_ATTEMPTS = 3;
/** Estimate threshold for "this photo probably contains you". Tune with real test photos. */
export const DEFAULT_SIMILARITY_THRESHOLD = 90;

export type Job = { id: string; enrollment_id: string; media_id: string; attempts: number };

export interface FaceStore {
  /** Atomically moves up to `limit` queued jobs to running and returns them. */
  claimJobs(limit: number): Promise<Job[]>;
  /** Null when the enrollment no longer exists (member left, room ended, re-enrolled). */
  getEnrollment(id: string): Promise<{ id: string; ref_path: string; room_id: string } | null>;
  /**
   * Live access check for the enrollment's room and member, read at call time:
   * 'ok' only if the room is not deleted, has not expired, and the member row still exists.
   * An expired room keeps its rows until the janitor runs, so existence alone is not enough.
   */
  enrollmentAccess(enrollmentId: string): Promise<'ok' | 'room_closed' | 'not_member'>;
  /**
   * The photo's room and its fallback image (preview if present, else original). Null if the photo is gone,
   * not ready, or not a photo.
   */
  getPhoto(mediaId: string): Promise<{ room_id: string; fallback_path: string } | null>;
  download(bucket: 'face-refs' | 'room-media', path: string): Promise<Uint8Array | null>;
  /** Deletes one object through the Storage API. Missing objects are not an error. */
  removeObject(bucket: 'room-media', path: string): Promise<void>;
  /** Writes the result only if the enrollment still exists. 'stale' means it was dropped. */
  saveMatch(enrollmentId: string, mediaId: string, r: { similarity: number | null; matched: boolean }): Promise<'saved' | 'stale'>;
  finishJob(jobId: string, status: 'done' | 'failed' | 'queued', error: string | null): Promise<void>;
}

export type BatchSummary = { claimed: number; done: number; matched: number; retried: number; failed: number; stale: number; providerCalls: number; aborted: boolean };

/**
 * The face_compare log line: similarity diagnostics only. Fields: job, room, media (upload id), target (detect copy or
 * fallback), quality_filter, provider_floor, threshold, best_similarity, matched, target_had_face, outcome, faces
 * (index, returned at or above the provider floor or below it, similarity if returned, box size as a fraction).
 * Never image bytes, paths, user or enrollment ids, face ids, landmarks or box position.
 * outcome: matched | below_threshold (score returned, under threshold) | below_floor (faces found, all under the
 * provider floor) | no_face_returned (no face detected, or every face dropped by QualityFilter; AWS does not say which).
 */
export function compareLogFields(
  job: Job,
  roomId: string,
  target: 'detect' | 'fallback',
  threshold: number,
  r: CompareResult,
  matched: boolean,
): Record<string, unknown> {
  const d = r.detail;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const faces = d
    ? [
        ...d.matches.map((m) => ({ returned: 'at_or_above_floor', similarity: round1(m.similarity), box: m.box })),
        ...d.unmatched.map((u) => ({ returned: 'below_floor', similarity: null, box: u.box })),
      ].map((f, i) => ({ i, ...f }))
    : [];
  const outcome = matched
    ? 'matched'
    : r.similarity !== null
      ? 'below_threshold'
      : r.targetHadFace
        ? 'below_floor'
        : 'no_face_returned';
  return {
    job: job.id,
    room: roomId,
    media: job.media_id,
    target,
    quality_filter: d?.qualityFilter ?? null,
    provider_floor: d?.providerFloor ?? null,
    threshold,
    best_similarity: r.similarity === null ? null : round1(r.similarity),
    matched,
    target_had_face: r.targetHadFace,
    outcome,
    faces,
  };
}

export async function processBatch(
  store: FaceStore,
  provider: FaceProvider,
  opts: { limit: number; threshold?: number; log?: (event: string, fields: Record<string, unknown>) => void },
): Promise<BatchSummary> {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const log = opts.log ?? (() => {});
  const s: BatchSummary = { claimed: 0, done: 0, matched: 0, retried: 0, failed: 0, stale: 0, providerCalls: 0, aborted: false };
  const jobs = await store.claimJobs(opts.limit);
  s.claimed = jobs.length;
  const refCache = new Map<string, Uint8Array | null>();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (s.aborted) {
      await store.finishJob(job.id, 'queued', null); // untouched; give it back
      continue;
    }
    // Late-result guard, part 1: do not spend an API call for a dead enrollment.
    const enrollment = await store.getEnrollment(job.enrollment_id);
    if (!enrollment) {
      s.stale++;
      log('stale_before_call', { job: job.id });
      continue; // the job row cascades away with its enrollment
    }
    // FM-Q A′-2: the only detect path read for this job, built from the job's own rows (never from the caller).
    const detectPath = detectObjectPath(enrollment.room_id, job.media_id, enrollment.id);
    try {
      const photo = await store.getPhoto(job.media_id);
      if (!photo) {
        await store.finishJob(job.id, 'failed', 'photo_unavailable');
        s.failed++;
      } else if (photo.room_id !== enrollment.room_id) {
        // A photo from another room than the enrollment's is refused outright.
        await store.finishJob(job.id, 'failed', 'room_mismatch');
        s.failed++;
        log('room_mismatch', { job: job.id });
      } else {
        await runJob(job, enrollment, photo.fallback_path, detectPath);
      }
    } finally {
      // Lifetime of the detect copy ends here on every path: match, no face, provider error, timeout
      // (the provider maps its fetch timeout to 'transient'), stale or closed room. The janitor TTL
      // covers a crash of the function itself.
      if (detectPath) {
        try {
          await store.removeObject('room-media', detectPath);
        } catch {
          log('detect_delete_failed', { job: job.id }); // no path or error text
        }
      }
    }
  }
  return s;

  async function runJob(job: Job, enrollment: { id: string; ref_path: string; room_id: string }, fallbackPath: string, detectPath: string | null) {
    if (!refCache.has(enrollment.id)) refCache.set(enrollment.id, await store.download('face-refs', enrollment.ref_path));
    const ref = refCache.get(enrollment.id);
    let target = detectPath ? await store.download('room-media', detectPath) : null;
    let targetSource: 'detect' | 'fallback' = 'detect';
    if (!target || target.length > MAX_IMAGE_BYTES) {
      log('detect_fallback', { job: job.id, reason: !detectPath ? 'bad_path' : !target ? 'missing' : 'too_large' });
      target = await store.download('room-media', fallbackPath);
      targetSource = 'fallback';
    }
    if (!ref) {
      await store.finishJob(job.id, 'failed', 'reference_missing');
      s.failed++;
      return;
    }
    if (!target) {
      await store.finishJob(job.id, 'failed', 'photo_unavailable');
      s.failed++;
      return;
    }

    // Late-result guard, part 1b: re-check access immediately before the paid, external call.
    const access = await store.enrollmentAccess(job.enrollment_id);
    if (access !== 'ok') {
      s.stale++;
      log('not_eligible', { job: job.id, access });
      if (access === 'room_closed') await store.finishJob(job.id, 'failed', 'room_closed');
      return; // not_member: the enrollment cascade removes the job
    }

    try {
      s.providerCalls++;
      const r = await provider.compare(ref, target);
      const matched = r.similarity !== null && r.similarity >= threshold;
      log('face_compare', compareLogFields(job, enrollment.room_id, targetSource, threshold, r, matched));
      // Late-result guard, part 2: the write itself is conditional on the enrollment still existing.
      const saved = await store.saveMatch(job.enrollment_id, job.media_id, { similarity: r.similarity, matched });
      if (saved === 'stale') {
        s.stale++;
        log('stale_on_save', { job: job.id });
        return;
      }
      await store.finishJob(job.id, 'done', null);
      s.done++;
      if (matched) s.matched++;
    } catch (e) {
      const kind = e instanceof FaceProviderError ? e.kind : 'transient';
      log('provider_error', { job: job.id, kind }); // kind only: never the message, keys or bytes
      if (kind === 'auth') {
        s.aborted = true;
        await store.finishJob(job.id, 'queued', 'auth'); // not the job's fault
        s.retried++;
      } else if (kind === 'no_face_in_reference') {
        await store.finishJob(job.id, 'failed', kind);
        s.failed++;
      } else if (kind === 'bad_image') {
        // Unusable target photo: record "no match" so the gallery does not retry it forever.
        const saved = await store.saveMatch(job.enrollment_id, job.media_id, { similarity: null, matched: false });
        if (saved === 'stale') s.stale++;
        else {
          await store.finishJob(job.id, 'done', 'bad_image');
          s.done++;
        }
      } else if (job.attempts + 1 >= MAX_ATTEMPTS) {
        await store.finishJob(job.id, 'failed', kind);
        s.failed++;
      } else {
        await store.finishJob(job.id, 'queued', kind);
        s.retried++;
      }
    }
  }
}
