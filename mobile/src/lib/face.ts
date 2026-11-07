import { FunctionsHttpError } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { en } from '@/i18n/en';

import { classifyMatchRun, createMatchRunCache, faceRefResize, type MatchRun } from './face-plan';
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
    // FG-R1: best effort; face-refs has no owner delete policy today, so this may remove nothing.
    // The room's whole face-refs prefix is still deleted by the janitor when the room is deleted.
    await supabase.storage.from('face-refs').remove([path]).catch(() => undefined);
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

/**
 * Asks the face-match function to process my queued jobs (the server limits it to my own
 * enrollments). While FACE_MATCH_ENABLED is off it answers 503 face_match_disabled.
 */
export async function runFaceMatch(roomId: string): Promise<MatchRun> {
  let run: MatchRun;
  try {
    const { error } = await supabase.functions.invoke('face-match', { body: {} });
    if (!error) run = classifyMatchRun({ status: 200 });
    else if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      const body = await res.json().catch(() => null);
      run = classifyMatchRun({ status: res.status, error: typeof body?.error === 'string' ? body.error : undefined });
    } else run = classifyMatchRun({ status: 0, error: error.message });
  } catch (e) {
    run = classifyMatchRun({ status: 0, error: e instanceof Error ? e.message : String(e) });
  }
  lastRuns.set(roomId, run);
  return run;
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
