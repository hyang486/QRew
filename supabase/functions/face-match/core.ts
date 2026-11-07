import { FaceProviderError, type FaceProvider } from './provider.ts';

export const MAX_ATTEMPTS = 3;
/** Estimate threshold for "this photo probably contains you". Tune with real test photos. */
export const DEFAULT_SIMILARITY_THRESHOLD = 90;

export type Job = { id: string; enrollment_id: string; media_id: string; attempts: number };

export interface FaceStore {
  /** Atomically moves up to `limit` queued jobs to running and returns them. */
  claimJobs(limit: number): Promise<Job[]>;
  /** Null when the enrollment no longer exists (member left, room ended, re-enrolled). */
  getEnrollment(id: string): Promise<{ id: string; ref_path: string } | null>;
  /**
   * Live access check for the enrollment's room and member, read at call time:
   * 'ok' only if the room is not deleted, has not expired, and the member row still exists.
   * An expired room keeps its rows until the janitor runs, so existence alone is not enough.
   */
  enrollmentAccess(enrollmentId: string): Promise<'ok' | 'room_closed' | 'not_member'>;
  /** Path of the image to compare (preview if present, else original). Null if the photo is gone or not ready. */
  getPhotoPath(mediaId: string): Promise<string | null>;
  download(bucket: 'face-refs' | 'room-media', path: string): Promise<Uint8Array | null>;
  /** Writes the result only if the enrollment still exists. 'stale' means it was dropped. */
  saveMatch(enrollmentId: string, mediaId: string, r: { similarity: number | null; matched: boolean }): Promise<'saved' | 'stale'>;
  finishJob(jobId: string, status: 'done' | 'failed' | 'queued', error: string | null): Promise<void>;
}

export type BatchSummary = { claimed: number; done: number; matched: number; retried: number; failed: number; stale: number; providerCalls: number; aborted: boolean };

export async function processBatch(
  store: FaceStore,
  provider: FaceProvider,
  opts: { limit: number; threshold?: number; log?: (event: string, fields: Record<string, string | number>) => void },
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
    const photoPath = await store.getPhotoPath(job.media_id);
    if (!photoPath) {
      await store.finishJob(job.id, 'failed', 'photo_unavailable');
      s.failed++;
      continue;
    }
    if (!refCache.has(enrollment.id)) refCache.set(enrollment.id, await store.download('face-refs', enrollment.ref_path));
    const ref = refCache.get(enrollment.id);
    const target = await store.download('room-media', photoPath);
    if (!ref) {
      await store.finishJob(job.id, 'failed', 'reference_missing');
      s.failed++;
      continue;
    }
    if (!target) {
      await store.finishJob(job.id, 'failed', 'photo_unavailable');
      s.failed++;
      continue;
    }

    // Late-result guard, part 1b: re-check access immediately before the paid, external call.
    const access = await store.enrollmentAccess(job.enrollment_id);
    if (access !== 'ok') {
      s.stale++;
      log('not_eligible', { job: job.id, access });
      if (access === 'room_closed') await store.finishJob(job.id, 'failed', 'room_closed');
      continue; // not_member: the enrollment cascade removes the job
    }

    try {
      s.providerCalls++;
      const r = await provider.compare(ref, target);
      const matched = r.similarity !== null && r.similarity >= threshold;
      // Late-result guard, part 2: the write itself is conditional on the enrollment still existing.
      const saved = await store.saveMatch(job.enrollment_id, job.media_id, { similarity: r.similarity, matched });
      if (saved === 'stale') {
        s.stale++;
        log('stale_on_save', { job: job.id });
        continue;
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
  return s;
}
