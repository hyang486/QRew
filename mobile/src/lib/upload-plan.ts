/**
 * Pure rules for the app-wide upload queue (no React, no native modules; unit tested).
 *
 * Jobs are kept in the order they were added. One job uploads at a time across the app, so a
 * large video does not compete with other uploads for bandwidth. A job lives in the queue until
 * it finishes (removed), fails (kept with its error until retried or removed), or is cancelled
 * by the user (removed).
 */

export type UploadState = 'queued' | 'uploading' | 'failed';

export type QueueJob = {
  id: string;
  roomId: string;
  state: UploadState;
  progress: number;
  error?: string;
};

/** The next job to start, or undefined when nothing is waiting. */
export function nextQueued<J extends QueueJob>(jobs: readonly J[]): J | undefined {
  return jobs.find((j) => j.state === 'queued');
}

export function patchJob<J extends QueueJob>(jobs: readonly J[], id: string, patch: Partial<J>): J[] {
  let changed = false;
  const next = jobs.map((j) => {
    if (j.id !== id) return j;
    changed = true;
    return { ...j, ...patch };
  });
  return changed ? next : (jobs as J[]);
}

export function removeJob<J extends QueueJob>(jobs: readonly J[], id: string): J[] {
  return jobs.some((j) => j.id === id) ? jobs.filter((j) => j.id !== id) : (jobs as J[]);
}

/** A failed job goes back to the queue with its progress reset. Other states are unchanged. */
export function requeue<J extends QueueJob>(jobs: readonly J[], id: string): J[] {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.state !== 'failed') return jobs as J[];
  return patchJob(jobs, id, { state: 'queued', progress: 0, error: undefined } as Partial<J>);
}

/**
 * Progress from a running upload is applied only while that job is still uploading, so a late
 * callback cannot revive a cancelled job or overwrite a failure.
 */
export function applyProgress<J extends QueueJob>(jobs: readonly J[], id: string, progress: number): J[] {
  const job = jobs.find((j) => j.id === id);
  if (!job || job.state !== 'uploading') return jobs as J[];
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : job.progress;
  // Never move backwards within one attempt (a retry resets progress through requeue).
  if (p <= job.progress) return jobs as J[];
  return patchJob(jobs, id, { progress: p } as Partial<J>);
}

export type RoomUploadSummary = { pending: number; failed: number; progress: number | null };

/**
 * Counts for one room: pending = queued + uploading; progress is the uploading job's fraction
 * (null when none is uploading).
 */
export function roomSummary(jobs: readonly QueueJob[], roomId: string): RoomUploadSummary {
  let pending = 0;
  let failed = 0;
  let progress: number | null = null;
  for (const j of jobs) {
    if (j.roomId !== roomId) continue;
    if (j.state === 'failed') failed += 1;
    else pending += 1;
    if (j.state === 'uploading') progress = j.progress;
  }
  return { pending, failed, progress };
}

/** True for the rejection an aborted fetch/upload produces. */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

// #8: one chat line per finished upload batch.

/** True when the room has nothing queued or uploading (failed jobs wait for the user, so they don't count). */
export function roomIdle(jobs: readonly QueueJob[], roomId: string): boolean {
  return !jobs.some((j) => j.roomId === roomId && j.state !== 'failed');
}

const KIND_WORDS = { photo: ['a photo', 'photos'], video: ['a video', 'videos'], file: ['a file', 'files'] } as const;

/**
 * The stored body of the media chat line for a batch, without the sender's name: "shared 3 photos",
 * "shared a file", "shared 2 photos and a video". Null for an empty batch (nothing is posted).
 */
export function sharedBody(kinds: readonly ('photo' | 'video' | 'file')[]): string | null {
  const parts = (['photo', 'video', 'file'] as const).flatMap((kind) => {
    const n = kinds.filter((k) => k === kind).length;
    if (n === 0) return [];
    return [n === 1 ? KIND_WORDS[kind][0] : `${n} ${KIND_WORDS[kind][1]}`];
  });
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `shared ${list}`;
}
