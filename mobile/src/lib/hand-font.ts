// Qrew redesign: which bundled handwriting font draws a title (pure; unit tested).
// React Native has no per-glyph font fallback, so a title with any Hangul uses the Korean hand font
// (Gaegu Light, which also has Latin), and any other title the Latin hand font (Patrick Hand).

export const HAND_FONT_LATIN = 'QrewHand';
export const HAND_FONT_KOREAN = 'QrewHandKo';

const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/;

export function handFontFor(text: string) {
  return HANGUL.test(text) ? HAND_FONT_KOREAN : HAND_FONT_LATIN;
}
