import { useHeaderHeight } from 'expo-router/react-navigation';
import { type ComponentRef, useCallback, useRef, useState } from 'react';
import type { View } from 'react-native';

/**
 * Where a screen's root actually starts on screen, and how much of it sits under the header.
 * With a translucent (iOS 26) native header the root starts at y = 0, behind the status bar and
 * header; with an opaque one it starts below it. Attach `rootRef` and `onLayout` to the root View
 * and pad its top by `overlap` only, so both cases lay out right. `top` is the real offset (for a
 * keyboard avoider).
 */
export function useHeaderOverlap() {
  const headerHeight = useHeaderHeight();
  const rootRef = useRef<ComponentRef<typeof View>>(null);
  const [rootY, setRootY] = useState<number | null>(null);
  const onLayout = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y) => setRootY(y));
  }, []);
  const top = rootY ?? headerHeight;
  return { rootRef, onLayout, top, overlap: Math.max(0, headerHeight - top) };
}
