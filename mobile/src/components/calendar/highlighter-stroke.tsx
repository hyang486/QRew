import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { InkIcon } from './ink-icon';
import { type Cap, markerBar, strokeA11y } from './sketch';
import { useCalendarColors } from './tokens';

const MIN_TARGET = 44;

/**
 * Qrewing Calendar: one week-row segment of a room's translucent marker: a straight bar with marker grain. A
 * slanted chisel tip only at the range's real start and end ('round' cap); a straight cut where it wraps to another
 * row or the month ends ('flat'). An optional emoji sits in the middle. Tappable (44 pt hit
 * area through hitSlop) only when onPress is given; otherwise it takes no touches.
 */
export function HighlighterStroke({
  width,
  height,
  color,
  startCap,
  endCap,
  seed,
  emoji,
  onPress,
  accessibilityLabel,
  lanePitch,
  a11yPrimary = true,
}: {
  width: number;
  height: number;
  color: string;
  startCap: Cap;
  endCap: Cap;
  seed: string;
  emoji?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * Stacked strokes in one week row: the distance between lane tops. The vertical hit area then stops halfway to
   * the next lane, so neighbors never share a touch point (the 44 pt height applies only when lanes are that far apart).
   */
  lanePitch?: number;
  /**
   * A room spanning several week rows is one VoiceOver element: pass true only on its first visible segment (give it
   * the full-range label). Other segments stay tappable but are hidden from VoiceOver. Default true.
   */
  a11yPrimary?: boolean;
}) {
  const colors = useCalendarColors();
  const bar = useMemo(() => markerBar(width, height, startCap, endCap, seed), [width, height, startCap, endCap, seed]);
  if (!bar) return null;
  const band = (
    <>
      <Svg width={width} height={height}>
        <Path d={bar.body} fill={color} fillOpacity={colors.highlighterOpacity} />
        {bar.streaks.map((s, i) => (
          <Path key={i} d={s.d} stroke={color} strokeOpacity={s.opacity} strokeWidth={0.9} fill="none" />
        ))}
      </Svg>
      {emoji ? (
        <View pointerEvents="none" style={styles.center}>
          <InkIcon emoji={emoji} size={Math.round(height * 1.05)} />
        </View>
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View
        pointerEvents="none"
        style={{ width, height }}
        {...strokeA11y(a11yPrimary && !!accessibilityLabel, accessibilityLabel)}
        accessibilityRole={undefined}
      >
        {band}
      </View>
    );
  }
  const want = lanePitch != null ? Math.min(MIN_TARGET, lanePitch) : MIN_TARGET;
  const v = Math.max(0, (want - height) / 2);
  const h = Math.max(0, (MIN_TARGET - width) / 2);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: v, bottom: v, left: h, right: h }}
      {...strokeA11y(a11yPrimary, accessibilityLabel)}
      style={({ pressed }) => [{ width, height }, pressed && styles.pressed]}
    >
      {band}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  pressed: { opacity: 0.6 },
});
