import { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * VoiceOver reads `text` when `trigger` changes and text is set. iOS only: Hint's accessibilityLiveRegion already
 * covers Android, and iOS ignores live regions, so inline errors and the thinking state were silent there.
 */
export function useAnnounce(text: string | null | undefined, trigger: unknown = text) {
  useEffect(() => {
    if (Platform.OS === 'ios' && text) AccessibilityInfo.announceForAccessibility(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trigger decides when; text is read at that moment.
  }, [trigger]);
}
