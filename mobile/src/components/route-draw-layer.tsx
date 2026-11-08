import { useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { addStrokePoint, type Point, type Size } from '@/lib/route-draw';

/**
 * R-1 / R1-C: a transparent layer over the editor's map while the pen is on. A one-finger gesture-handler Pan
 * that activates on touch-down (minDistance 0) takes the stroke natively, so the map underneath cannot pan,
 * zoom, rotate or select a place, and nothing else can claim the touch after one move (the R1-C repro lost
 * left-to-right strokes to the stack back-swipe; the editor is also a Modal outside the stack for that).
 * The finished stroke goes to `onStroke` in view points; the live stroke stays here so moves do not re-render
 * the editor.
 */
export function RouteDrawLayer({ color, onStroke }: { color: string; onStroke: (stroke: Point[], size: Size) => void }) {
  const [size, setSize] = useState<Size | null>(null);
  const [stroke, setStroke] = useState<Point[]>([]);
  // The end can arrive before the last move has rendered, so the stroke is also kept in a ref.
  const live = useRef<Point[]>([]);
  const update = (next: Point[]) => {
    live.current = next;
    setStroke(next);
  };

  function finish() {
    const done = live.current;
    if (done.length === 0) return;
    update([]);
    if (size) onStroke(done, size);
  }

  const pan = usePanGesture({
    minDistance: 0,
    maxPointers: 1,
    runOnJS: true,
    onBegin: (e) => update([{ x: e.x, y: e.y }]),
    onUpdate: (e) => update(addStrokePoint(live.current, { x: e.x, y: e.y })),
    // Finalize runs on every end: lift, cancel and failure. A cancelled stroke is still kept as drawn.
    onFinalize: () => finish(),
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        style={StyleSheet.absoluteFill}
        onLayout={(e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {stroke.length > 1 ? (
            <Polyline
              points={stroke.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : stroke.length === 1 ? (
            <Circle cx={stroke[0].x} cy={stroke[0].y} r={3} fill={color} />
          ) : null}
        </Svg>
      </View>
    </GestureDetector>
  );
}
