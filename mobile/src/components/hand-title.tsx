import { useFonts } from 'expo-font';
import { type StyleProp, StyleSheet, Text, type TextStyle } from 'react-native';

import { usePalette } from '@/components/ui';
import { HAND_FONT_KOREAN, HAND_FONT_LATIN, handFontFor } from '@/lib/hand-font';

/**
 * Qrew redesign: the bundled OFL handwriting fonts (assets/fonts, licenses next to them). Loaded at runtime by
 * expo-font, so existing dev builds need no rebuild. The root layout preloads them; useFonts here is cached.
 */
export const HAND_FONTS = {
  [HAND_FONT_LATIN]: require('@/assets/fonts/PatrickHand-Regular.ttf'),
  [HAND_FONT_KOREAN]: require('@/assets/fonts/Gaegu-Light.ttf'),
};

/** Qrew ink (components/ui palette): the design's #181817 on light; a pale ink on dark so titles and art stay visible. */
export function useInk() {
  return usePalette().ink;
}

/**
 * The one handwritten title of a screen, at the top of its content (the screen's nav title is left empty so it
 * is not shown twice). Body text stays in the system sans. Until the fonts load, the system font is used.
 * Long names wrap; Dynamic Type scales it (capped so a large setting still fits two lines on a phone).
 */
export function HandTitle({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const [loaded] = useFonts(HAND_FONTS);
  const ink = useInk();
  return (
    <Text
      accessibilityRole="header"
      maxFontSizeMultiplier={1.6}
      style={[styles.title, { color: ink }, loaded ? { fontFamily: handFontFor(children) } : styles.fallback, style]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 34, lineHeight: 42 },
  fallback: { fontWeight: '300' },
});
