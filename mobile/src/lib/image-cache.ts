import { Image } from 'expo-image';

/**
 * M1 / AV1: the map's photo pins load through Image.loadAsync, which always stores into expo-image's
 * disk cache (expo-image 58 ios/ImageLoader.swift: createSDWebImageContext(..., cachePolicy: .disk);
 * ImageLoadOptions has no cache policy). Nothing else in the app uses the disk cache (every <Image>
 * is cachePolicy="memory"), so the whole disk cache is cleared whenever those photos must not stay
 * on the device: map screen closed, room left/ended/gone, sign-out, account deleted or gone, and on
 * launch (covers a crash or kill while the map was open). Best effort.
 */
export function clearImageDiskCache() {
  Image.clearDiskCache().catch(() => {});
}
