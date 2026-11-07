// qrcode's core encoder has no Node or canvas dependencies, so it runs in React Native.
import { create } from 'qrcode/lib/core/qrcode';
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

type Props = { value: string; size: number; accessibilityLabel?: string };

/** Black-on-white QR (fixed colors so scanners read it in dark mode too), with a 4-module quiet zone. */
export function QrCode({ value, size, accessibilityLabel }: Props) {
  const { path, count } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.modules.get(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { path: d, count: n + 8 };
  }, [value]);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Rect width={count} height={count} fill="#FFFFFF" />
      <Path d={path} fill="#000000" />
    </Svg>
  );
}
