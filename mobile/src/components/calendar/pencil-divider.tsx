import { useMemo, useState } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { pencilStrokes } from './sketch';
import { useCalendarColors } from './tokens';

const HEIGHT = 6;

/**
 * Qrewing Calendar: a straight pencil rule across its parent's width (the same graphite texture as the month grid),
 * for the day list and the diary instead of a card edge. `inset` keeps it off both sides. Decorative only.
 */
export function PencilDivider({ seed = 'divider', inset = 0, style }: { seed?: string; inset?: number; style?: StyleProp<ViewStyle> }) {
  const colors = useCalendarColors();
  const [width, setWidth] = useState(0);
  const passes = useMemo(
    () => (width > inset * 2 ? pencilStrokes([[inset, HEIGHT / 2, width - inset, HEIGHT / 2]], `divider:${seed}:${width}`) : []),
    [width, inset, seed],
  );
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      style={[{ height: HEIGHT, alignSelf: 'stretch' }, style]}
    >
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          {passes.map((p, i) => (
            <Path key={i} d={p.d} stroke={colors.pencil} strokeOpacity={p.opacity} strokeWidth={p.width} strokeLinecap="round" fill="none" />
          ))}
        </Svg>
      ) : null}
    </View>
  );
}
