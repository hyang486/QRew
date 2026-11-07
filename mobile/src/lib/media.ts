import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Share } from 'react-native';

import { en } from '@/i18n/en';

import type { Tables } from './database.types';
import { errorMessage } from './errors';
import { EXT_BY_MIME, exportFileName, extensionFor } from './file-name';
import { clearImageDiskCache } from './image-cache';
import { progressFraction } from './progress';
import { useRoomEvents } from './room-channel';
import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase';
import {
  applyProgress,
  isAbortError,
  nextQueued,
  patchJob,
  type QueueJob,
  removeJob,
  requeue,
  type RoomUploadSummary,
  roomSummary,
} from './upload-plan';

/**
 * Room media: original photos, videos and files.
 *
 * Storage layout (bucket `room-media`, private):
 *   {room_id}/{media_id}/original.<ext>   the untouched original bytes
 *   {room_id}/{media_id}/preview.jpg      a small JPEG for the grid (photos and videos)
 *
 * Originals are never recompressed: the picker returns the current asset representation
 * (HEIC stays HEIC) and passthrough video, and the native upload streams the file from disk.
 * The uploader records a SHA-256 of the original; a download is checked against that hash
 * and the server-recorded size before it is saved. Every read goes through the authenticated
 * Storage endpoint with the member's token, so room RLS applies to each request and no
 * long-lived public or signed link is created.
 */

export type Media = Tables<'media'>;
export type MediaKind = 'photo' | 'video' | 'file';
export type MediaFilter = 'all' | 'mine' | 'others';

/** Per-file limit: the Supabase Free plan's global upload limit (also set on the bucket). */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const BUCKET = 'room-media';
const PREVIEW_WIDTH = 480;

export type PickedItem = {
  uri: string;
  kind: MediaKind;
  mimeType: string;
  fileName: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Bytes on disk, when known (filled in by splitBySize). */
  size?: number;
};

export function objectUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function uploadUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Headers for an authenticated Storage read or write as the signed-in member. */
export function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_PUBLISHABLE_KEY };
}

async function freshToken() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error(en.errors.notSignedIn);
  return token;
}

export function formatBytes(n: number | null | undefined) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Picking -------------------------------------------------------------------

/** Photos and videos from the system picker, as originals (no recompression, no editing). */
export async function pickPhotosAndVideos(): Promise<PickedItem[]> {
  // iOS needs library access to hand over passthrough (original) videos; ask before the picker
  // so the dialog does not appear after a selection. Denial still allows picking photos.
  await ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => undefined);
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    allowsEditing: false,
    quality: 1,
    exif: false,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
  });
  if (result.canceled) return [];
  return result.assets.map((a) => {
    const kind: MediaKind = a.type === 'video' ? 'video' : 'photo';
    const mimeType = a.mimeType ?? (kind === 'video' ? 'video/quicktime' : 'image/jpeg');
    const fallbackName = `${kind === 'video' ? 'video' : 'photo'}.${EXT_BY_MIME[mimeType] ?? 'bin'}`;
    return {
      uri: a.uri,
      kind,
      mimeType,
      fileName: a.fileName ?? fallbackName,
      width: a.width || undefined,
      height: a.height || undefined,
      durationMs: a.duration ?? undefined,
    };
  });
}

/** Any file from the system document picker. */
export async function pickFile(): Promise<PickedItem[]> {
  const result = await File.pickFileAsync();
  if (result.canceled) return [];
  const f = result.result;
  return [{ uri: f.uri, kind: 'file', mimeType: f.type || 'application/octet-stream', fileName: f.name || 'file' }];
}

/**
 * Splits picked items into ones that fit the per-file limit and ones that do not, before any
 * upload starts. Unreadable sizes pass through; runJob checks again.
 */
export function splitBySize(items: PickedItem[]): { ok: PickedItem[]; tooLarge: { item: PickedItem; size: number }[] } {
  const ok: PickedItem[] = [];
  const tooLarge: { item: PickedItem; size: number }[] = [];
  for (const item of items) {
    let size = 0;
    try {
      size = Number(new File(item.uri).size ?? 0);
    } catch {
      size = 0;
    }
    if (size > MAX_MEDIA_BYTES) tooLarge.push({ item, size });
    else ok.push(size > 0 ? { ...item, size } : item);
  }
  return { ok, tooLarge };
}

// Upload --------------------------------------------------------------------

export type UploadJob = QueueJob & {
  /** Media row id (QueueJob.id); also the storage folder. */
  uploaderId: string;
  item: PickedItem;
  originalPath: string;
  previewPath: string | null;
  /** True once the media row exists on the server (retries update it instead of inserting). */
  rowCreated: boolean;
};

async function makePreview(item: PickedItem): Promise<string | null> {
  try {
    let source = item.uri;
    if (item.kind === 'video') {
      source = (await VideoThumbnails.getThumbnailAsync(item.uri, { time: 0, quality: 0.8 })).uri;
    } else if (item.kind !== 'photo') {
      return null;
    }
    const ref = await ImageManipulator.manipulate(source).resize({ width: PREVIEW_WIDTH }).renderAsync();
    const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
    return saved.uri;
  } catch {
    // A preview is a convenience; the grid falls back to an icon.
    return null;
  }
}

function abortError() {
  return Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

async function putObject(
  path: string,
  fileUri: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const token = await freshToken();
  // iOS uses a background URLSession by default, so a long video keeps uploading while the app
  // is briefly suspended (the JS promise is lost only if the app is terminated).
  const task = new File(fileUri).createUploadTask(uploadUrl(path), {
    httpMethod: 'POST',
    headers: { ...authHeaders(token), 'content-type': mimeType, 'x-upsert': 'true', 'cache-control': '3600' },
    onProgress: onProgress
      ? ({ bytesSent, totalBytes }) => {
          const f = progressFraction(bytesSent, totalBytes);
          if (f != null) onProgress(f);
        }
      : undefined,
    signal,
  });
  const result = await task.uploadAsync();
  throwIfAborted(signal);
  if (!result || result.status < 200 || result.status >= 300) {
    let message = `Upload failed (HTTP ${result?.status ?? 'error'})`;
    try {
      const body = JSON.parse(result?.body ?? '') as { message?: string; error?: string };
      if (body.message || body.error) message = body.message ?? body.error ?? message;
    } catch {
      // Non-JSON body: keep the status message.
    }
    throw new Error(message);
  }
}

/** Creates the job for a picked item (queued; nothing is sent yet). */
export function createJob(roomId: string, uploaderId: string, item: PickedItem): UploadJob {
  const id = randomUUID();
  const ext = extensionFor(item.fileName, item.mimeType);
  return {
    id,
    roomId,
    uploaderId,
    item,
    originalPath: `${roomId}/${id}/original.${ext}`,
    previewPath: item.kind === 'file' ? null : `${roomId}/${id}/preview.jpg`,
    state: 'queued',
    progress: 0,
    rowCreated: false,
  };
}

/**
 * Runs (or re-runs) one upload: media row -> preview -> original -> ready.
 * The server only accepts 'ready' when the stored original is nonempty and records its size.
 * On failure or cancel the row is marked 'failed' (never listed; deleted with the room).
 * The thrown error carries the updated job so a retry reuses the same row and paths.
 */
export async function runJob(job: UploadJob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<UploadJob> {
  const { item } = job;
  const file = new File(item.uri);
  if (!file.exists) throw new Error(en.errors.fileGone);
  const size = Number(file.size ?? 0);
  if (size <= 0) throw new Error(en.media.emptyFile);
  if (size > MAX_MEDIA_BYTES) throw new Error(en.media.tooLarge(formatBytes(MAX_MEDIA_BYTES), formatBytes(size)));

  let rowCreated = job.rowCreated;
  let previewPath = job.previewPath;
  if (!rowCreated) {
    const sha256 = await file.digest('SHA-256');
    throwIfAborted(signal);
    const { error } = await supabase.from('media').insert({
      id: job.id,
      room_id: job.roomId,
      uploader_id: job.uploaderId,
      kind: item.kind,
      original_path: job.originalPath,
      preview_path: previewPath,
      file_name: item.fileName.slice(0, 255),
      mime_type: item.mimeType,
      width: item.width ?? null,
      height: item.height ?? null,
      duration_ms: item.durationMs != null ? Math.round(item.durationMs) : null,
      content_sha256: sha256,
      status: 'uploading',
    });
    if (error) throw new Error(error.message);
    rowCreated = true;
  }

  try {
    throwIfAborted(signal);
    if (previewPath) {
      const previewUri = await makePreview(item);
      if (previewUri) {
        await putObject(previewPath, previewUri, 'image/jpeg', undefined, signal);
      } else {
        // No preview could be made: clear it so 'ready' does not require one.
        const { error } = await supabase.from('media').update({ preview_path: null }).eq('id', job.id);
        if (error) throw new Error(error.message);
        previewPath = null;
      }
    }
    onProgress(0.02);
    await putObject(job.originalPath, item.uri, item.mimeType, (f) => onProgress(0.02 + f * 0.97), signal);
    throwIfAborted(signal);
    const { error } = await supabase.from('media').update({ status: 'ready' }).eq('id', job.id);
    if (error) throw new Error(error.message);
    onProgress(1);
    return { ...job, rowCreated, previewPath };
  } catch (e) {
    await supabase.from('media').update({ status: 'failed' }).eq('id', job.id);
    throw Object.assign(isAbortError(e) ? abortError() : new Error(errorMessage(e)), {
      job: { ...job, rowCreated, previewPath },
    });
  }
}

/*
 * App-wide upload queue. It lives outside any screen so an upload keeps running, and its
 * progress or failure stays visible, after the user leaves the gallery (a long video is the
 * usual case). One job uploads at a time. Failed jobs stay until retried or removed;
 * cancelled jobs are removed. Sign-out cancels and clears everything.
 */
type UploadStore = { jobs: UploadJob[]; done: Record<string, number> };
let store: UploadStore = { jobs: [], done: {} };
const storeListeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let pumping = false;

function setStore(next: UploadStore) {
  if (next === store) return;
  store = next;
  for (const l of storeListeners) l();
}

function setJobs(update: (jobs: UploadJob[]) => UploadJob[]) {
  const jobs = update(store.jobs);
  if (jobs !== store.jobs) setStore({ ...store, jobs });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (let job = nextQueued(store.jobs); job; job = nextQueued(store.jobs)) {
      const current = job;
      const controller = new AbortController();
      controllers.set(current.id, controller);
      setJobs((js) => patchJob(js, current.id, { state: 'uploading', progress: 0, error: undefined }));
      try {
        await runJob(current, (f) => setJobs((js) => applyProgress(js, current.id, f)), controller.signal);
        const done = { ...store.done, [current.roomId]: (store.done[current.roomId] ?? 0) + 1 };
        setStore({ jobs: removeJob(store.jobs, current.id), done });
      } catch (e) {
        if (controller.signal.aborted || isAbortError(e)) {
          setJobs((js) => removeJob(js, current.id));
        } else {
          const failed = (e as { job?: UploadJob }).job ?? current;
          setJobs((js) =>
            js.some((j) => j.id === current.id)
              ? patchJob(js, current.id, { ...failed, state: 'failed', error: errorMessage(e) })
              : js,
          );
        }
      } finally {
        controllers.delete(current.id);
      }
    }
  } finally {
    pumping = false;
  }
}

export function enqueueUploads(roomId: string, uploaderId: string, items: PickedItem[]) {
  if (items.length === 0) return;
  const created = items.map((item) => createJob(roomId, uploaderId, item));
  setJobs((js) => [...js, ...created]);
  pump();
}

export function retryUpload(id: string) {
  setJobs((js) => requeue(js, id));
  pump();
}

/** Cancels a queued or running upload. The partial row is marked failed and never listed. */
export function cancelUpload(id: string) {
  const controller = controllers.get(id);
  if (controller) controller.abort();
  else setJobs((js) => removeJob(js, id));
}

export function dismissUpload(id: string) {
  setJobs((js) => (js.find((j) => j.id === id)?.state === 'failed' ? removeJob(js, id) : js));
}

/** Sign-out / account gone: stop every upload and forget the queue. */
export function cancelAllUploads() {
  for (const c of controllers.values()) c.abort();
  setStore({ jobs: [], done: {} });
}

function subscribeUploads(listener: () => void) {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function useUploadStore() {
  return useSyncExternalStore(subscribeUploads, () => store);
}

/** Upload jobs for one room, newest first; calls onUploaded after each finished upload. */
export function useUploads(roomId: string, onUploaded?: () => void) {
  const { jobs: all, done } = useUploadStore();
  const jobs = useMemo(() => all.filter((j) => j.roomId === roomId).reverse(), [all, roomId]);
  const doneCount = done[roomId] ?? 0;
  const seen = useRef(doneCount);
  const callback = useRef(onUploaded);
  useEffect(() => {
    callback.current = onUploaded;
  }, [onUploaded]);
  useEffect(() => {
    if (doneCount === seen.current) return;
    seen.current = doneCount;
    callback.current?.();
  }, [doneCount]);
  return { jobs, retry: retryUpload, cancel: cancelUpload, dismiss: dismissUpload };
}

/** Pending/failed counts for one room, for a compact indicator outside the gallery. */
export function useRoomUploadSummary(roomId: string): RoomUploadSummary {
  const { jobs } = useUploadStore();
  const s = roomSummary(jobs, roomId);
  // Stable primitives so callers can depend on them.
  return useMemo(() => ({ pending: s.pending, failed: s.failed, progress: s.progress }), [s.pending, s.failed, s.progress]);
}

// Listing -------------------------------------------------------------------

export async function listMedia(roomId: string, filter: MediaFilter, userId: string | undefined): Promise<Media[]> {
  let q = supabase
    .from('media')
    .select('*')
    .eq('room_id', roomId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(300);
  if (filter === 'mine' && userId) q = q.eq('uploader_id', userId);
  if (filter === 'others' && userId) q = q.neq('uploader_id', userId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getMedia(mediaId: string): Promise<Media | null> {
  const { data, error } = await supabase.from('media').select('*').eq('id', mediaId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Ready media in one room, refreshed on realtime changes and on demand. */
export function useRoomMedia(roomId: string, filter: MediaFilter, userId: string | undefined) {
  const [items, setItems] = useState<Media[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Loading until a fetch for the current room/filter/user has settled.
  const key = `${roomId}|${filter}|${userId ?? ''}`;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const loading = settledKey !== key;

  const reload = useCallback(async () => {
    try {
      const data = await listMedia(roomId, filter, userId);
      setItems(data);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSettledKey(`${roomId}|${filter}|${userId ?? ''}`);
    }
  }, [roomId, filter, userId]);

  // Initial fetch runs once the room channel settles, so no change between
  // the fetch and the subscription is missed; it still runs if realtime fails.
  useRoomEvents(
    roomId,
    (event) => {
      if (event.table === 'media') reload();
    },
    () => {
      reload();
    },
  );

  return { items, loading, error, reload };
}

// Download ------------------------------------------------------------------

function roomCacheDir(roomId: string) {
  return new Directory(cacheRoot(), roomId);
}

function cacheRoot() {
  return new Directory(Paths.cache, 'room-media');
}

/** Deletes this app's cached originals for a room (after it ends or the user leaves). */
export function clearRoomCache(roomId: string) {
  // M1: map photo pins may be in expo-image's disk cache.
  clearImageDiskCache();
  try {
    const dir = roomCacheDir(roomId);
    if (dir.exists) dir.delete();
  } catch {
    // Cache cleanup is best effort.
  }
}

/**
 * Deletes cached originals for every room not in `keepRoomIds` (rooms that expired, ended or were
 * left while this screen was not open). Call only with a successfully fetched room list.
 */
export function pruneRoomCaches(keepRoomIds: Iterable<string>) {
  try {
    const root = cacheRoot();
    if (!root.exists) return;
    const keep = new Set(keepRoomIds);
    for (const entry of root.list()) {
      if (entry instanceof Directory && !keep.has(entry.name)) entry.delete();
    }
  } catch {
    // Cache cleanup is best effort.
  }
}

/** Deletes all cached room originals (sign-out, or the account no longer exists). */
export function clearAllRoomCaches() {
  clearImageDiskCache();
  try {
    const root = cacheRoot();
    if (root.exists) root.delete();
  } catch {
    // Cache cleanup is best effort.
  }
}

export type DownloadResult = { file: File; bytes: number; sha256: string };

/**
 * Downloads the stored original into the room's cache folder and verifies it against the
 * server-recorded size and the uploader's SHA-256. A mismatched file is deleted.
 */
export async function downloadOriginal(media: Media, onProgress?: (fraction: number) => void): Promise<DownloadResult> {
  const token = await freshToken();
  const dir = roomCacheDir(media.room_id);
  // One folder per media id keeps names unique while the file keeps its original name (M-1).
  const mediaDir = new Directory(dir, media.id);
  if (mediaDir.exists) mediaDir.delete();
  mediaDir.create({ intermediates: true, idempotent: true });
  const dest = new File(mediaDir, exportFileName(media.file_name, media.mime_type, media.id));

  const task = File.createDownloadTask(objectUrl(media.original_path), dest, {
    headers: authHeaders(token),
    onProgress: onProgress
      ? ({ bytesWritten, totalBytes }) => {
          const f = progressFraction(bytesWritten, totalBytes);
          if (f != null) onProgress(f);
        }
      : undefined,
  });
  const file = await task.downloadAsync();
  if (!file) throw new Error(en.errors.downloadIncomplete);
  const bytes = Number(file.size ?? 0);
  const sha256 = await file.digest('SHA-256');
  if (bytes <= 0 || (media.size_bytes != null && bytes !== media.size_bytes) || (media.content_sha256 && sha256 !== media.content_sha256)) {
    file.delete();
    throw new Error(en.errors.downloadMismatch);
  }
  return { file, bytes, sha256 };
}

/**
 * Saves a verified original: photos and videos go to the photo library (add-only access),
 * other files open the share sheet so the user can choose where to keep them.
 */
export async function saveOriginal(media: Media, file: File): Promise<'library' | 'shared' | 'cancelled'> {
  if (media.kind === 'photo' || media.kind === 'video') {
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) throw new Error(en.errors.photosPermission);
    await MediaLibrary.Asset.create(file.uri);
    return 'library';
  }
  const result = await Share.share({ url: file.uri, title: media.file_name });
  return result.action === Share.dismissedAction ? 'cancelled' : 'shared';
}
