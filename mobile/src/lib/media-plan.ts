// Pure helpers for the Photos & files screens (Qrew unit 5, Q 05.03/05.04). No React Native imports, so
// `npm test` can load them under plain Node.

/**
 * Q 05.03 title. The app has no media titles (worklist gap 5: no invented "Run clip"), so a video is "Video", a
 * photo is "Photo" and a file shows its own name.
 */
export function mediaTitle(media: { kind: string; file_name: string }, labels: { video: string; photo: string }): string {
  if (media.kind === 'video') return labels.video;
  if (media.kind === 'photo') return labels.photo;
  return media.file_name;
}

// Q 05.04: after "Save original" on a media detail, the gallery shows "Original saved" once when it is next
// shown. In memory only: it is a confirmation of what just happened, not state to keep.
const savedRooms = new Set<string>();

/** A verified original from this room was saved on this device. */
export function noteSaved(roomId: string) {
  savedRooms.add(roomId);
}

/** True once after noteSaved for this room (the gallery shows its card), then false until the next save. */
export function takeSaved(roomId: string): boolean {
  return savedRooms.delete(roomId);
}

export type AgeUnit = 'sec' | 'min' | 'hr' | 'day';

/**
 * Q 05.03 "Shared by Mia · 18 sec": how long ago an item was shared, in the largest whole unit (floor), at
 * least 1 sec. A small clock skew (created_at a little after now) counts as 1 sec; a bad date is null.
 */
export function sharedAge(createdAt: string, nowMs: number): { n: number; unit: AgeUnit } | null {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return null;
  const sec = Math.max(1, Math.floor((nowMs - created) / 1000));
  if (sec < 60) return { n: sec, unit: 'sec' };
  const min = Math.floor(sec / 60);
  if (min < 60) return { n: min, unit: 'min' };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { n: hr, unit: 'hr' };
  return { n: Math.floor(hr / 24), unit: 'day' };
}
