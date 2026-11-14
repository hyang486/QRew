import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { gridPencil } from './sketch';
import { useCalendarColors } from './tokens';

/** Room around the grid so the grain beside the outer lines is not clipped. */
const PAD = 3;

/**
 * Qrewing Calendar: the month grid in pencil (7 × weeks cells), optionally on cream paper. The lines are straight
 * and even; only their texture is pencil (graphite pressure, grain, rare breaks). Lines only: the caller lays out
 * day numbers, strokes and press targets on top. Deterministic per seed, so it never jitters.
 */
export function SketchyMonthGrid({
  weeks,
  cellWidth,
  cellHeight,
  seed = 'grid',
  paper = false,
}: {
  weeks: number;
  cellWidth: number;
  cellHeight: number;
  seed?: string;
  paper?: boolean;
}) {
  const colors = useCalendarColors();
  const width = cellWidth * 7;
  const height = cellHeight * weeks;
  const passes = useMemo(() => gridPencil(weeks, cellWidth, cellHeight, seed, PAD), [weeks, cellWidth, cellHeight, seed]);
  if (width <= 0 || height <= 0) return null;
  return (
    <View pointerEvents="none" style={{ width, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={width + PAD * 2} height={height + PAD * 2} style={styles.svg}>
        {paper ? <Rect x={PAD} y={PAD} width={width} height={height} rx={10} fill={colors.paper} /> : null}
        {passes.map((p, i) => (
          <Path key={i} d={p.d} stroke={colors.pencil} strokeOpacity={p.opacity} strokeWidth={p.width} strokeLinecap="round" fill="none" />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  svg: { position: 'absolute', left: -PAD, top: -PAD },
});
