// FM-Q A′-2: temporary face-detection copies in room-media.
// Path: {room_id}/{media_id}/detect/{enrollment_id}.jpg. The enrolled member's device uploads a ~1920px,
// EXIF/GPS-free JPEG right before it asks face-match to process that job; face-match deletes it in
// `finally`. The janitor removes any copy older than DETECT_TTL_MS, and the room purge removes the room
// prefix. Participants cannot read or list these objects (storage policy); only the service role reads them.
// Keep the format in sync with mobile/src/lib/face-plan.ts (faceDetectPath) and the storage policy.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DETECT_NAME = new RegExp(`^${UUID}/${UUID}/detect/${UUID}\\.jpg$`);
const UUID_ONLY = new RegExp(`^${UUID}$`);

/** Janitor backstop: a detect copy older than this is deleted even if face-match never ran. */
export const DETECT_TTL_MS = 15 * 60_000;

/** The only detect path face-match reads for a job. Null when any id is not a lowercase UUID. */
export function detectObjectPath(roomId: string, mediaId: string, enrollmentId: string): string | null {
  if (![roomId, mediaId, enrollmentId].every((s) => UUID_ONLY.test(s))) return null;
  return `${roomId}/${mediaId}/detect/${enrollmentId}.jpg`;
}

/** True only for an object name in the exact detect format. */
export function isDetectObjectName(name: string): boolean {
  return DETECT_NAME.test(name);
}

/** Detect copies the janitor may delete: exact detect names created before now - ttl. */
export function staleDetectObjects<T extends { name: string; createdAt: string }>(objects: readonly T[], now: Date, ttlMs = DETECT_TTL_MS): T[] {
  const cutoff = now.getTime() - ttlMs;
  return objects.filter((o) => {
    if (!isDetectObjectName(o.name)) return false;
    const t = Date.parse(o.createdAt);
    return Number.isFinite(t) && t < cutoff;
  });
}
