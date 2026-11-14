/** Qrewing Calendar labels (dates are local 'YYYY-MM-DD' keys, formatted as UTC so the key's day never shifts). */
import type { DateKey } from './calendar-plan';

function utcDate(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function monthTitle(year: number, month0: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month0, 1)));
}

/** The diary card's lines: up to 3 non-empty recap lines, or the "no recap" line so the card is never blank. */
export function diaryText(diary: readonly unknown[] | null | undefined, none: string): string[] {
  const lines = (diary ?? []).filter((l): l is string => typeof l === 'string' && l.trim() !== '').slice(0, 3);
  return lines.length ? lines : [none];
}

/** "Sunday, November 15" */
export function dayTitle(key: DateKey, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utcDate(key));
}

/** "Nov 15" or "Nov 15 – 17" or "Nov 30 – Dec 2" (year added when it differs from `thisYear`). */
export function rangeLabel(start: DateKey, end: DateKey, thisYear: number, locale?: string): string {
  const ys = +start.slice(0, 4);
  const ye = +end.slice(0, 4);
  const withYear = ys !== thisYear || ye !== thisYear;
  const f = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  if (start === end) return f.format(utcDate(start));
  // Hermes (the app's engine) has no Intl.DateTimeFormat.formatRange: build the range by hand there.
  if (typeof f.formatRange === 'function') return f.formatRange(utcDate(start), utcDate(end));
  if (!withYear && start.slice(0, 7) === end.slice(0, 7)) return `${f.format(utcDate(start))} – ${+end.slice(8, 10)}`;
  return `${f.format(utcDate(start))} – ${f.format(utcDate(end))}`;
}

/** Short weekday names from `weekStartsOn` (0 = Sunday). */
export function weekdayLabels(weekStartsOn = 0, locale?: string): string[] {
  const f = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
  // 2026-11-01 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2026, 10, 1 + ((i + weekStartsOn) % 7)))));
}

/** A DateKey as a local Date at noon (date pickers), and back. Noon keeps DST changes away from the day edge. */
export function keyToLocalDate(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function localDateToKey(date: Date): DateKey {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** VoiceOver text from parts: ". " between them, but no period after a part that already ends in . ! ? or …. */
export function spokenJoin(parts: readonly string[]): string {
  const kept = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return kept.map((p, i) => (i < kept.length - 1 && !/[.!?…]$/.test(p) ? `${p}.` : p)).join(' ');
}
