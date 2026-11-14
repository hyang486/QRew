import { useColorScheme } from 'react-native';

/**
 * Qrewing Calendar colors, light and dark pairs (react-native-svg needs plain strings). Calendar-only (the approved
 * pencil mockup, docs/evidence/2026-11-13-calendar-pencil-mockup-v2.html), so they live here, not in components/ui.
 * ink: text and line icons. pencil: grid lines and dividers (graphite; light graphite on the dark paper).
 */
export const CAL_COLORS = {
  light: {
    ink: '#2B2A27',
    pencil: '#3D3B37',
    paper: '#FBF7EE',
    highlighters: ['#FFE14D', '#FF9EC4', '#8FE39A', '#8FD3FF', '#FFB870', '#C7A8FF'],
    highlighterOpacity: 0.55,
  },
  dark: {
    ink: '#E4DED2',
    pencil: '#BDB7AB',
    paper: '#1D1B17',
    highlighters: ['#E8C93A', '#E07FA8', '#6CC27A', '#6BB6E6', '#E39A55', '#A98BE6'],
    highlighterOpacity: 0.5,
  },
} as const;

export type CalendarColors = (typeof CAL_COLORS)['light'] | (typeof CAL_COLORS)['dark'];

export function useCalendarColors(): CalendarColors {
  return useColorScheme() === 'dark' ? CAL_COLORS.dark : CAL_COLORS.light;
}

/** A stable default highlighter for an item (by a seed such as the room id) when the caller has no color. */
export function highlighterFor(colors: CalendarColors, seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors.highlighters[h % colors.highlighters.length];
}
