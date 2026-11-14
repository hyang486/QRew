import Svg, { Path } from 'react-native-svg';

import { INK_ICON_BOX, INK_ICONS, inkIconKey } from './ink-icon-map';
import { useCalendarColors } from './tokens';

/** Stroke width in points at any size, close to the assets/art pen line. */
const STROKE_PT = 1.5;

/**
 * A room's or event's emoji drawn as a black-ink line icon (theme ink: near-black on light, light graphite on dark).
 * Decorative: the caller's element carries the words for VoiceOver (inkIconLabel), so the icon is hidden.
 */
export function InkIcon({ emoji, size = 22, color }: { emoji: string | null | undefined; size?: number; color?: string }) {
  const ink = useCalendarColors().ink;
  const { paths } = INK_ICONS[inkIconKey(emoji)];
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${INK_ICON_BOX} ${INK_ICON_BOX}`}
      fill="none"
      stroke={color ?? ink}
      strokeWidth={(STROKE_PT * INK_ICON_BOX) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {paths.map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}
