/**
 * Fraction done (0..1) from native transfer byte counts, or null when the total is unknown.
 *
 * expo-file-system emits `bytesSent`/`bytesWritten`/`totalBytes` from Swift `Int64`, which
 * expo-modules-core encodes as a JS BigInt even though the TS types say `number`. Its final
 * JS-emitted event uses plain numbers. Arithmetic that mixes a BigInt with a number throws
 * (e.g. "Cannot convert 0.97 to BigInt"), so always convert with Number() first.
 */
export function progressFraction(done: number | bigint, total: number | bigint | null | undefined): number | null {
  if (total == null) return null;
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = Number(done);
  if (!Number.isFinite(d)) return null;
  return Math.min(1, Math.max(0, d / t));
}
