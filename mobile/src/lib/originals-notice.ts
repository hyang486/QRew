import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

import { en } from '@/i18n/en';

// #7: photos and videos are shared as originals (spec), including any location saved in them. Before the first
// photo/video add on this device, say so once. Not stored per account: it is a device-level notice.
const KEY = 'moment.originals-notice.v1';

/** Resolves true to go on with the add. Shows the notice once; Cancel leaves it unseen so it shows again. */
export async function confirmOriginalsNotice(): Promise<boolean> {
  try {
    if ((await AsyncStorage.getItem(KEY)) === 'seen') return true;
  } catch {
    // Storage unreadable: show the notice again rather than skip it.
  }
  const ok = await new Promise<boolean>((resolve) => {
    Alert.alert(
      en.media.originalsNoticeTitle,
      en.media.originalsNoticeBody,
      [
        { text: en.media.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: en.media.originalsNoticeContinue, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
  if (!ok) return false;
  await AsyncStorage.setItem(KEY, 'seen').catch(() => undefined);
  // Let the alert finish dismissing, so the picker presented next is not refused by UIKit.
  await new Promise((r) => setTimeout(r, 400));
  return true;
}
