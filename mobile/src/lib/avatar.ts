import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { supabase, SUPABASE_URL } from './supabase';

/**
 * Profile photo (display only; never a face-matching reference).
 *
 * Storage: bucket `avatars` (private), `{user_id}/{uuid}.jpg`, one JPEG of at most 2 MB.
 * The picked image is cropped square and re-encoded to a small JPEG on the device, which also
 * drops EXIF data such as location. Each change uploads a new object and then points
 * profiles.avatar_path at it; the server queues the previous object for deletion.
 * Co-members of an open room can read it through the authenticated Storage endpoint.
 */

const BUCKET = 'avatars';
const AVATAR_SIZE = 512;

export function avatarUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Opens the photo library with a square crop. Returns the picked image URI, or null if cancelled. */
export async function pickAvatar(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) return null;
  return result.assets[0].uri;
}

/** Re-encodes, uploads and sets the profile photo. */
export async function setProfilePhoto(userId: string, imageUri: string) {
  const ref = await ImageManipulator.manipulate(imageUri).resize({ width: AVATAR_SIZE }).renderAsync();
  const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  const bytes = await new File(saved.uri).arrayBuffer();
  const path = `${userId}/${randomUUID()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) throw uploadError;
  const { error } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', userId);
  if (error) throw error;
}

/** Clears the profile photo; the server queues the stored object for deletion. */
export async function removeProfilePhoto(userId: string) {
  const { error } = await supabase.from('profiles').update({ avatar_path: null }).eq('id', userId);
  if (error) throw error;
}
