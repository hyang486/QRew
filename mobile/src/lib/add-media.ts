import { Alert } from 'react-native';

import { en } from '@/i18n/en';
import { errorMessage } from '@/lib/errors';
import { CameraError, enqueueUploads, formatBytes, MAX_MEDIA_BYTES, type PickedItem, splitBySize } from '@/lib/media';

/**
 * Runs one add path (camera, photo picker or file picker) and queues what fits for upload. Items over the size
 * limit are listed in an alert and skipped. Moved from the gallery (unit 5) so the Camera access is off screen
 * (Q 07.04) can run the library path too. Resolves 'camera-denied' when camera access is off: the caller shows
 * that screen instead of an alert. Other camera problems (no camera, the Simulator) stay an alert (G9 F2).
 */
export async function addToRoom(
  roomId: string,
  userId: string | undefined,
  pick: () => Promise<PickedItem[]>,
): Promise<'added' | 'nothing' | 'camera-denied'> {
  try {
    const { ok, tooLarge } = splitBySize(await pick());
    if (tooLarge.length > 0) {
      const list = tooLarge.map(({ item, size }) => `${item.fileName} (${formatBytes(size)})`).join(', ');
      Alert.alert(en.media.tooLargeTitle, en.media.tooLargeSkipped(formatBytes(MAX_MEDIA_BYTES), list));
    }
    if (ok.length > 0 && userId) {
      enqueueUploads(roomId, userId, ok);
      return 'added';
    }
    return 'nothing';
  } catch (e) {
    if (e instanceof CameraError && e.reason === 'denied') return 'camera-denied';
    // G9 F2: nothing was uploaded when the camera could not be used.
    Alert.alert(e instanceof CameraError ? en.media.cameraTitle : en.media.uploadFailed, errorMessage(e));
    return 'nothing';
  }
}
