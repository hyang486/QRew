// Expiry + storage cleanup worker logic. Pure: all I/O goes through JanitorStore, so it is tested offline.
import { staleDetectObjects } from '../_shared/detect.ts';

export type CleanupJob = { id: string; bucket: string; prefix: string; created_at: string; attempts: number };
export type StoredObject = { name: string; createdAt: string };

export interface JanitorStore {
  /** Deletes rooms whose expires_at has passed or that were ended (deleted_at set). Cascades and queues cleanup via triggers. Returns room ids. */
  deleteExpiredRooms(limit: number): Promise<string[]>;
  /** Jobs with verified_empty_at null, fewest attempts first, then oldest (J1: failing jobs cannot starve newer ones). */
  claimCleanupJobs(limit: number): Promise<CleanupJob[]>;
  /** All objects under a prefix (recursive), or the single object when `prefix` has no trailing slash. */
  listObjects(bucket: string, prefix: string): Promise<StoredObject[]>;
  removeObjects(bucket: string, names: string[]): Promise<void>;
  finishCleanup(id: string, r: { verifiedEmpty: boolean; error: string | null }): Promise<void>;
  /** face-refs object names that an enrollment still points to. */
  activeFaceRefPaths(): Promise<Set<string>>;
  listAllObjects(bucket: string): Promise<StoredObject[]>;
  /** FM-Q A′-2: room-media detect copies ({room}/{media}/detect/*) with their creation time (listing only). */
  listDetectObjects(): Promise<StoredObject[]>;
}

export type JanitorSummary = {
  roomsDeleted: number;
  jobsVerified: number;
  jobsRetrying: number;
  objectsRemoved: number;
  orphansRemoved: number;
  /** FM-Q A′-2: detect copies older than DETECT_TTL_MS removed through the Storage API. */
  detectRemoved: number;
  /** Jobs that failed again and have now failed STUCK_ATTEMPTS times or more (J1: visible repeated failure). */
  jobsStuck: number;
  /** Per-job counts, for before/after evidence. */
  jobs: { prefix: string; bucket: string; before: number; removed: number; after: number; verified: boolean }[];
};

export const ORPHAN_AGE_MS = 60 * 60 * 1000;
export const STUCK_ATTEMPTS = 5;

const isPrefixJob = (prefix: string) => prefix.endsWith('/');

/** Objects a job is allowed to delete: exact-path jobs delete that object; prefix jobs only objects that existed when queued. */
export function deletable(job: CleanupJob, objects: StoredObject[]): StoredObject[] {
  if (!isPrefixJob(job.prefix)) return objects.filter((o) => o.name === job.prefix);
  if (job.bucket === 'face-refs') {
    const cutoff = new Date(job.created_at).getTime();
    return objects.filter((o) => new Date(o.createdAt).getTime() <= cutoff);
  }
  return objects; // room-media: the room is deleted, nothing may remain
}

export async function runJanitor(
  store: JanitorStore,
  opts: { now: Date; roomLimit: number; jobLimit: number; log?: (event: string, f: Record<string, string | number>) => void },
): Promise<JanitorSummary> {
  const log = opts.log ?? (() => {});
  const out: JanitorSummary = { roomsDeleted: 0, jobsVerified: 0, jobsRetrying: 0, objectsRemoved: 0, orphansRemoved: 0, detectRemoved: 0, jobsStuck: 0, jobs: [] };

  out.roomsDeleted = (await store.deleteExpiredRooms(opts.roomLimit)).length;

  for (const job of await store.claimCleanupJobs(opts.jobLimit)) {
    try {
      const before = await store.listObjects(job.bucket, job.prefix);
      const victims = deletable(job, before);
      if (victims.length) await store.removeObjects(job.bucket, victims.map((o) => o.name));
      // Verify through the Storage API: nothing that this job may delete is still there.
      const after = await store.listObjects(job.bucket, job.prefix);
      const left = deletable(job, after).length;
      out.objectsRemoved += victims.length;
      out.jobs.push({ prefix: job.prefix, bucket: job.bucket, before: before.length, removed: victims.length, after: after.length, verified: left === 0 });
      if (left === 0) {
        await store.finishCleanup(job.id, { verifiedEmpty: true, error: null });
        out.jobsVerified++;
      } else {
        await store.finishCleanup(job.id, { verifiedEmpty: false, error: 'objects_remaining' });
        out.jobsRetrying++;
        if (job.attempts + 1 >= STUCK_ATTEMPTS) out.jobsStuck++;
      }
    } catch {
      log('cleanup_error', { job: job.id }); // no error text: it may echo paths
      await store.finishCleanup(job.id, { verifiedEmpty: false, error: 'storage_error' });
      out.jobsRetrying++;
      if (job.attempts + 1 >= STUCK_ATTEMPTS) {
        out.jobsStuck++;
        log('cleanup_stuck', { job: job.id, attempts: job.attempts + 1 });
      }
    }
  }

  // Orphan sweep: face-refs objects with no enrollment pointing at them, older than 1 hour
  // (the hour covers an upload that has not been enrolled yet).
  try {
    const active = await store.activeFaceRefPaths();
    const cutoff = opts.now.getTime() - ORPHAN_AGE_MS;
    const orphans = (await store.listAllObjects('face-refs')).filter((o) => !active.has(o.name) && new Date(o.createdAt).getTime() < cutoff);
    if (orphans.length) await store.removeObjects('face-refs', orphans.map((o) => o.name));
    out.orphansRemoved = orphans.length;
  } catch {
    log('orphan_sweep_error', {});
  }

  // FM-Q A′-2 backstop: face-match deletes each detect copy in finally; this removes any left by a crash,
  // an aborted batch or an interrupted upload once it is older than the TTL.
  try {
    const stale = staleDetectObjects(await store.listDetectObjects(), opts.now);
    if (stale.length) await store.removeObjects('room-media', stale.map((o) => o.name));
    out.detectRemoved = stale.length;
  } catch {
    log('detect_sweep_error', {});
  }
  return out;
}
