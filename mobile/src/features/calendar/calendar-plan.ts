/**
 * Qrewing Calendar date math (Plus, human FINAL 2026-11-13). Pure: no React, no storage.
 * Dates are local calendar days as 'YYYY-MM-DD' keys. Day arithmetic runs on UTC midnights, so DST never
 * shifts a day; timestamps become keys through Intl in the given time zone.
 */

export type DateKey = string;

export type CalItem = {
  id: string;
  kind: 'room' | 'event';
  title: string;
  start: DateKey;
  end: DateKey; // inclusive
  emoji: string;
};

export type Segment = {
  itemId: string;
  row: number;
  colStart: number;
  colEnd: number; // inclusive
  /** False where the range is cut: it continues into the previous/next week row or month. */
  capStart: boolean;
  capEnd: boolean;
  lane: number;
  /** The segment that holds the item's middle date (clipped to the month) carries the emoji. */
  emoji: boolean;
};

export const MAX_LANES = 3;

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(v: unknown): v is DateKey {
  if (typeof v !== 'string') return false;
  const m = KEY.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toUtc(key: DateKey): number {
  const m = KEY.exec(key);
  if (!m) throw new Error(`bad date key ${key}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function fromUtc(ms: number): DateKey {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(key: DateKey, n: number): DateKey {
  return fromUtc(toUtc(key) + n * 86_400_000);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: DateKey, b: DateKey): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function keyOf(year: number, month0: number, day: number): DateKey {
  return fromUtc(Date.UTC(year, month0, day));
}

/** The local calendar day of an instant in `timeZone` (default: the device zone). */
export function localDateKey(instant: string | number | Date, timeZone?: string): DateKey {
  const d = new Date(instant);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Month shift with year carry: shiftMonth(2026, 11, 1) = { year: 2027, month0: 0 }. */
export function shiftMonth(year: number, month0: number, by: number): { year: number; month0: number } {
  const total = year * 12 + month0 + by;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

export type MonthGrid = {
  year: number;
  month0: number;
  rows: number;
  /** Column of day 1 (0..6), counted from weekStartsOn. */
  offset: number;
  days: number;
};

export function monthGrid(year: number, month0: number, weekStartsOn = 0): MonthGrid {
  const weekday = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const offset = (weekday - weekStartsOn + 7) % 7;
  const days = daysInMonth(year, month0);
  return { year, month0, rows: Math.ceil((offset + days) / 7), offset, days };
}

/** Grid cell of a day of the month. */
export function cellOf(grid: MonthGrid, day: number): { row: number; col: number } {
  const i = grid.offset + day - 1;
  return { row: Math.floor(i / 7), col: i % 7 };
}

/** Items that touch the month, earliest first, longer first on ties (stable lanes). */
export function itemsInMonth(items: readonly CalItem[], year: number, month0: number): CalItem[] {
  const first = keyOf(year, month0, 1);
  const last = keyOf(year, month0, daysInMonth(year, month0));
  return items
    .filter((it) => it.start <= last && it.end >= first)
    .sort((a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : b.end.localeCompare(a.end) || a.id.localeCompare(b.id)));
}

/**
 * The shown month's items as week-row segments. Ranges are clipped to the month and wrapped per row; each row
 * stacks its segments in lanes (an item keeps one lane within a row unless it is split at full days). Segments in lane >= MAX_LANES are
 * returned too, and the screen shows them as "+N" (see overflowByDay).
 */
export function layoutMonth(items: readonly CalItem[], grid: MonthGrid): Segment[] {
  const first = keyOf(grid.year, grid.month0, 1);
  const out: Segment[] = [];
  const taken: Map<number, number[][]> = new Map(); // row -> lane -> occupied [colStart, colEnd] pairs flattened
  for (const it of itemsInMonth(items, grid.year, grid.month0)) {
    const startDay = Math.max(1, daysBetween(first, it.start) + 1);
    const endDay = Math.min(grid.days, daysBetween(first, it.end) + 1);
    const span = daysBetween(it.start, it.end);
    const midKey = addDays(it.start, Math.floor(span / 2));
    const midDay = Math.min(endDay, Math.max(startDay, daysBetween(first, midKey) + 1));
    let day = startDay;
    while (day <= endDay) {
      const { row, col } = cellOf(grid, day);
      const rowEndDay = Math.min(endDay, day + (6 - col));
      const colEnd = cellOf(grid, rowEndDay).col;
      const lanes = taken.get(row) ?? [];
      taken.set(row, lanes);
      const busy = (lane: number, a: number, b: number) =>
        lanes[lane]?.some((v, i) => i % 2 === 0 && !(b < v || a > lanes[lane][i + 1])) ?? false;
      const lowest = (a: number, b: number) => {
        let lane = 0;
        while (busy(lane, a, b)) lane++;
        return lane;
      };
      // One lane for the whole row when a drawn lane is free; otherwise split at the full days, so the room is
      // hidden ("+N") only where all drawn lanes are taken (draw test F1).
      const runs: [number, number, number][] = [];
      const whole = lowest(col, colEnd);
      if (whole < MAX_LANES) runs.push([col, colEnd, whole]);
      else {
        let c = col;
        while (c <= colEnd) {
          const lane = lowest(c, c);
          let e = c;
          if (lane < MAX_LANES) while (e < colEnd && !busy(lane, e + 1, e + 1)) e++;
          else while (e < colEnd && lowest(e + 1, e + 1) >= MAX_LANES) e++;
          runs.push([c, e, lane < MAX_LANES ? lane : lowest(c, e)]);
          c = e + 1;
        }
      }
      for (const [a, b, lane] of runs) {
        (lanes[lane] ??= []).push(a, b);
        const aDay = day + (a - col);
        const bDay = day + (b - col);
        out.push({
          itemId: it.id,
          row,
          colStart: a,
          colEnd: b,
          capStart: aDay === startDay && it.start >= first,
          capEnd: bDay === endDay && daysBetween(first, it.end) + 1 <= grid.days,
          lane,
          emoji: midDay >= aDay && midDay <= bDay,
        });
      }
      day = rowEndDay + 1;
    }
  }
  return out;
}

/** Per day of the month, how many items sit in hidden lanes (>= MAX_LANES). */
export function overflowByDay(segments: readonly Segment[], grid: MonthGrid): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of segments) {
    if (s.lane < MAX_LANES) continue;
    for (let col = s.colStart; col <= s.colEnd; col++) {
      const day = s.row * 7 + col - grid.offset + 1;
      out.set(day, (out.get(day) ?? 0) + 1);
    }
  }
  return out;
}

/** Items on one day, for the day's VoiceOver label and the day sheet. */
export function itemsOnDay(items: readonly CalItem[], key: DateKey): CalItem[] {
  return items.filter((it) => it.start <= key && it.end >= key);
}

/** A room's calendar range: start (starts_at, else created_at) to its end (an early end wins over expires_at). */
export function roomRange(
  room: { starts_at: string | null; created_at: string; expires_at: string; deleted_at?: string | null },
  timeZone?: string,
): { start: DateKey; end: DateKey } {
  const start = localDateKey(room.starts_at ?? room.created_at, timeZone);
  const expires = Date.parse(room.expires_at);
  const ended = room.deleted_at ? Date.parse(room.deleted_at) : NaN;
  const endMs = ended < expires ? ended : expires;
  // An end exactly at local midnight belongs to the day before (a room until 00:00 is over by then).
  let end = localDateKey(endMs - 1, timeZone);
  if (end < start) end = start;
  return { start, end };
}

/**
 * Past = the room is over: its end instant (endAt) has passed. qa 2026-11-13: this parsed the end DateKey, which
 * Date.parse reads as UTC midnight, so a room still open in Los Angeles counted as past and Plus showed "No recap
 * was saved". A snapshot with an unreadable endAt falls back to the local midnight after its (inclusive) end day.
 */
export function isPastRoom(room: { end: DateKey; endAt?: string }, now: number): boolean {
  const at = typeof room.endAt === 'string' ? Date.parse(room.endAt) : NaN;
  if (Number.isFinite(at)) return at <= now;
  const [y, m, d] = room.end.split('-').map(Number);
  const after = new Date(y, m - 1, d + 1).getTime();
  return Number.isFinite(after) && after <= now;
}

/**
 * Calendar tiers (human FINAL 2026-11-13 PM): what tapping a bar, icon or "+N" sheet row does. A room opens the
 * diary card on Plus and the Plus upsell on Free (never the diary text, even one saved earlier); my own event opens
 * the editor on both. While the Plus flag is unread, a room tap waits (null) instead of guessing the tier.
 */
export type ItemAction = 'diary' | 'upsell' | 'edit';

export function itemAction(kind: CalItem['kind'], plus: boolean | null): ItemAction | null {
  if (kind === 'event') return 'edit';
  if (plus === null) return null;
  return plus ? 'diary' : 'upsell';
}

/** The VoiceOver action word for a bar: what a tap does, with Free rooms named as a Plus feature. */
export function barAction(kind: CalItem['kind'], plus: boolean | null): 'diary' | 'plus' | 'edit' {
  if (kind === 'event') return 'edit';
  return plus ? 'diary' : 'plus';
}
