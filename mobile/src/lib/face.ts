import { FunctionsHttpError } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { en } from '@/i18n/en';

import {
  classifyDetectUpload,
  classifyMatchRun,
  createMatchRunCache,
  DETECT_CONCURRENCY,
  DETECT_MAX_BYTES,
  detectBatches,
  detectResize,
  faceDetectPath,
  faceRefResize,
  mapLimit,
  type MatchRun,
} from './face-plan';
import { authHeaders, freshToken, objectUrl } from './media';
import { supabase } from './supabase';

/**
 * Room-scoped face reference upload. The object lives at
 * `face-refs/{room_id}/{user_id}/ref-{uuid}.jpg`, which only that member can read or write
 * (Storage RLS), then `enroll_face` records it and queues the room's existing photos.
 * Nothing is uploaded until the member has consented in the enrollment screen.
 */
export function faceRefPath(roomId: string, userId: string, id: string) {
  return `${roomId}/${userId}/ref-${id}.jpg`;
}

/**
 * Lets the member take or choose a reference photo. Returns a local JPEG (re-encoded on the device,
 * which also drops EXIF such as location), or null when cancelled. Throws if the camera is unavailable.
 */
export async function pickFaceReference(source: 'camera' | 'library'): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error(en.face.cameraDenied);
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  let context = ImageManipulator.manipulate(asset.uri);
  const resize = faceRefResize(asset.width);
  if (resize) context = context.resize(resize);
  const ref = await context.renderAsync();
  const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return saved.uri;
}

export async function enrollFace(roomId: string, photoUri: string): Promise<{ enrollmentId: string } | { error: string }> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return { error: en.errors.notSignedIn };
  const path = faceRefPath(roomId, userId, randomUUID());
  // ArrayBuffer body, not Blob: React Native Blob uploads can be stored empty.
  const bytes = await new File(photoUri).arrayBuffer();
  if (bytes.byteLength === 0) return { error: en.errors.photoUnreadable };
  const { error: upErr } = await supabase.storage.from('face-refs').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (upErr) return { error: upErr.message };
  const { data, error } = await supabase.rpc('enroll_face', { p_room_id: roomId, p_ref_path: path });
  if (error) {
    // FG-R1: enroll_face is one transaction, so on failure no enrollment points at `path` (and a failed
    // Replace keeps the previous enrollment). room-janitor's orphan sweep (every 15 min) deletes face-refs
    // objects that no enrollment references once they are older than 1 hour (ORPHAN_AGE_MS), so this upload
    // is removed within about 75 minutes, or earlier with the room. No client delete here on purpose:
    // face-refs has no DELETE policy, and an error can also mean the call committed but the response was
    // lost, in which case deleting `path` would break a live enrollment.
    return { error: error.message };
  }
  return { enrollmentId: data };
}

/** Removes the member's reference and match results for this room. The janitor deletes the stored object. */
export async function removeFaceEnrollment(roomId: string) {
  const { error } = await supabase.rpc('remove_face_enrollment', { p_room_id: roomId });
  if (error) return { error: error.message };
  clearMatchRun(roomId);
  return { ok: true as const };
}

export type FaceEnrollment = { id: string; ref_path: string; created_at: string };
export type FaceJobRow = { status: string; attempts: number; updated_at: string };
export type FaceMatchRow = { media_id: string; matched: boolean; excluded: boolean; similarity: number | null };
export type FaceData = { enrollment: FaceEnrollment | null; jobs: FaceJobRow[]; matches: FaceMatchRow[] };

/** My enrollment in this room with its jobs and matches (RLS: own rows only). */
export async function loadFaceData(roomId: string, userId: string): Promise<FaceData> {
  const { data: enrollment, error } = await supabase
    .from('face_enrollments')
    .select('id, ref_path, created_at')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!enrollment) return { enrollment: null, jobs: [], matches: [] };
  const [jobs, matches] = await Promise.all([
    supabase.from('face_jobs').select('status, attempts, updated_at').eq('enrollment_id', enrollment.id),
    supabase.from('face_matches').select('media_id, matched, excluded, similarity').eq('enrollment_id', enrollment.id),
  ]);
  if (jobs.error) throw jobs.error;
  if (matches.error) throw matches.error;
  return { enrollment, jobs: jobs.data ?? [], matches: matches.data ?? [] };
}

// The last face-match result per room, so the gallery knows about a run started by the enrollment screen.
const lastRuns = createMatchRunCache();

export function lastMatchRun(roomId: string): MatchRun | null {
  return lastRuns.get(roomId);
}

/** Forgets the room's last run (Retry, or the enrollment was removed). */
export function clearMatchRun(roomId: string) {
  lastRuns.clear(roomId);
}

async function invokeFaceMatch(body: { probe: true } | { jobIds: string[] }): Promise<MatchRun> {
  try {
    const { error } = await supabase.functions.invoke('face-match', { body });
    if (!error) return classifyMatchRun({ status: 200 });
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      const data = await res.json().catch(() => null);
      return classifyMatchRun({ status: res.status, error: typeof data?.error === 'string' ? data.error : undefined });
    }
    return classifyMatchRun({ status: 0, error: error.message });
  } catch (e) {
    return classifyMatchRun({ status: 0, error: e instanceof Error ? e.message : String(e) });
  }
}

type DetectMedia = { id: string; room_id: string; original_path: string; width: number | null; height: number | null };

/**
 * FM-Q A′-2: makes a temporary ~1920px JPEG of one ready photo and uploads it to the detect path that only
 * face-match reads. The re-encode drops EXIF/GPS. Local files are deleted on every path. Any failure is
 * 'failed', and face-match then falls back to the preview, so a failed copy never blocks matching.
 */
async function uploadDetectCopy(media: DetectMedia, enrollmentId: string): Promise<'uploaded' | 'exists' | 'failed'> {
  const path = faceDetectPath(media.room_id, media.id, enrollmentId);
  if (!path) return 'failed';
  const dir = new Directory(Paths.cache, 'face-detect', randomUUID());
  try {
    dir.create({ intermediates: true, idempotent: true });
    const token = await freshToken();
    const original = await File.createDownloadTask(objectUrl(media.original_path), new File(dir, 'original'), {
      headers: authHeaders(token),
    }).downloadAsync();
    if (!original) return 'failed';
    let context = ImageManipulator.manipulate(original.uri);
    const resize = detectResize(media.width, media.height);
    if (resize) context = context.resize(resize);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    // ArrayBuffer body, not Blob: React Native Blob uploads can be stored empty.
    const bytes = await new File(saved.uri).arrayBuffer();
    new File(saved.uri).delete();
    if (bytes.byteLength === 0 || bytes.byteLength > DETECT_MAX_BYTES) return 'failed';
    const { error } = await supabase.storage.from('room-media').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
    return classifyDetectUpload(error as { message?: string; statusCode?: string | number; status?: string | number } | null);
  } catch {
    return 'failed';
  } finally {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // Cache cleanup is best effort; the OS may also purge Paths.cache.
    }
  }
}

/**
 * Asks the face-match function to process my open jobs in this room (the server limits it to my own
 * enrollments). While FACE_MATCH_ENABLED is off the probe answers 503 face_match_disabled and nothing
 * is uploaded. Otherwise, per batch of up to 5 jobs: upload a detection copy of each photo, then one
 * call that compares and deletes those copies.
 */
export async function runFaceMatch(roomId: string): Promise<MatchRun> {
  const run = await runFaceMatchBatches(roomId);
  lastRuns.set(roomId, run);
  return run;
}

async function runFaceMatchBatches(roomId: string): Promise<MatchRun> {
  const probe = await invokeFaceMatch({ probe: true });
  if (probe.kind !== 'ok') return probe;
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return { kind: 'error', message: en.errors.notSignedIn };
    const { data: enrollment, error: enrErr } = await supabase
      .from('face_enrollments')
      .select('id')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .maybeSingle();
    if (enrErr) throw enrErr;
    if (!enrollment) return { kind: 'ok' };
    const { data: jobs, error: jobErr } = await supabase
      .from('face_jobs')
      .select('id, media_id, status, attempts, updated_at, created_at')
      .eq('enrollment_id', enrollment.id);
    if (jobErr) throw jobErr;
    for (const batch of detectBatches(jobs ?? [], Date.now())) {
      const { data: media, error: mediaErr } = await supabase
        .from('media')
        .select('id, room_id, original_path, width, height')
        .in(
          'id',
          batch.map((j) => j.media_id),
        )
        .eq('kind', 'photo')
        .eq('status', 'ready');
      if (mediaErr) throw mediaErr;
      // Photos that are gone or not ready get no copy; the function marks those jobs itself.
      await mapLimit(media ?? [], DETECT_CONCURRENCY, (m) => uploadDetectCopy(m, enrollment.id));
      const result = await invokeFaceMatch({ jobIds: batch.map((j) => j.id) });
      if (result.kind !== 'ok') return result;
    }
    return { kind: 'ok' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** "Not me": hides a photo from Photos of me (only the `excluded` column is writable). */
export async function excludeFaceMatch(enrollmentId: string, mediaId: string) {
  const { error } = await supabase
    .from('face_matches')
    .update({ excluded: true })
    .eq('enrollment_id', enrollmentId)
    .eq('media_id', mediaId);
  if (error) throw error;
}

/** Short-lived URL for my own reference photo (face-refs is private; only I can read my prefix). */
export async function faceRefUrl(refPath: string): Promise<string | null> {
  const { data } = await supabase.storage.from('face-refs').createSignedUrl(refPath, 300);
  return data?.signedUrl ?? null;
}

/** My enrollment id when this photo is currently in my Photos of me (matched, not excluded); otherwise null. */
export async function myVisibleMatch(roomId: string, userId: string, mediaId: string): Promise<string | null> {
  const { data: enrollment } = await supabase
    .from('face_enrollments')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!enrollment) return null;
  const { data } = await supabase
    .from('face_matches')
    .select('matched, excluded')
    .eq('enrollment_id', enrollment.id)
    .eq('media_id', mediaId)
    .maybeSingle();
  return data?.matched && !data.excluded ? enrollment.id : null;
}
