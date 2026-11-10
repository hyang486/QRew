// Pure helpers for the Qrew chat screen (unit 3; no React Native imports, so `npm test` can load them).

import type { LatLng } from './location-plan';

/** Which day the room ends on, relative to now, in local time (Q 03.01 "Ends today at 10:00 PM"). */
export function endsDay(expiresMs: number, nowMs: number): 'today' | 'tomorrow' | 'later' {
  const end = new Date(expiresMs);
  const start = new Date(nowMs);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(end) - day(start)) / 86_400_000);
  if (diff <= 0) return 'today';
  return diff === 1 ? 'tomorrow' : 'later';
}

/**
 * Q 03.02: the icon of a status card, chosen by keyword in its (host-defined) label. Latin terms match whole
 * words, Korean terms are listed explicitly; anything else gets the generic tag icon. Emergency is fixed.
 */
const STATUS_SYMBOLS: { symbol: string; words: string[]; korean: string[] }[] = [
  { symbol: 'bed.double', words: ['rest', 'resting', 'tired'], korean: ['휴식', '쉬는', '쉬어'] },
  { symbol: 'flag.slash', words: ['giving', 'give', 'quit', 'quitting', 'dnf'], korean: ['포기'] },
  { symbol: 'drop', words: ['water', 'thirsty', 'drink'], korean: ['물', '목말'] },
  { symbol: 'ellipsis.bubble', words: ['help'], korean: ['도움', '도와'] },
  { symbol: 'bandage', words: ['hurt', 'injured', 'injury', 'cramp'], korean: ['부상', '다쳤', '쥐'] },
  { symbol: 'clock', words: ['late', 'wait', 'waiting', 'delayed'], korean: ['늦', '대기'] },
  { symbol: 'questionmark.circle', words: ['lost'], korean: ['길을'] },
  { symbol: 'figure.walk', words: ['way', 'coming', 'walking', 'omw'], korean: ['가는 중', '이동'] },
];

export function statusSymbol(label: string, isEmergency: boolean): string {
  if (isEmergency) return 'exclamationmark.triangle';
  const text = label.trim().toLowerCase();
  const words = new Set(text.split(/[^a-z]+/).filter(Boolean));
  for (const s of STATUS_SYMBOLS) {
    if (s.words.some((w) => words.has(w))) return s.symbol;
    if (s.korean.some((k) => (k.length === 1 ? text.split(/\s+/).includes(k) : text.includes(k)))) return s.symbol;
  }
  return 'tag';
}

export type EmergencyLocation =
  | { kind: 'none' }
  | { kind: 'shared'; updatedAt: string; coordinates: LatLng };

/**
 * Q 04.03 "Last location shared · 4 min ago": the sender's live position row, if the room still has one (RLS
 * returns rows only while an activity runs with location allowed).
 */
export function emergencyLocation(
  row: { lat: number; lng: number; updated_at: string } | undefined,
): EmergencyLocation {
  if (!row || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return { kind: 'none' };
  if (Math.abs(row.lat) > 90 || Math.abs(row.lng) > 180) return { kind: 'none' };
  return { kind: 'shared', updatedAt: row.updated_at, coordinates: { latitude: row.lat, longitude: row.lng } };
}
