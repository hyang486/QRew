// Qrewing Calendar: pure geometry for the hand-drawn pieces (unit tested in tests/calendar-sketch.test.mjs).
// Every texture variation comes from a seeded generator, so the same seed draws the same path on every render.

export type Cap = 'round' | 'flat';

/** FNV-1a hash of the seed, then mulberry32: a stable stream of numbers in [0, 1). */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (v: number) => +v.toFixed(1);
/** A value in [-amp, amp]. */
const jitter = (rand: () => number, amp: number) => (rand() * 2 - 1) * amp;

/** One pass of pencil: many short pieces (subpaths) that share an opacity and a width, drawn as one SVG path. */
export type PencilPass = { d: string; opacity: number; width: number };

export const PRESSURE_OPACITY = [0.65, 0.75, 0.85, 0.95];
const PRESSURE_WIDTH = [1.2, 1.4, 1.6];
const GRAIN = { opacity: 0.35, width: 0.6 };
/** Largest sideways drift of the core stroke; the grain pass adds at most GRAIN_OFFSET more (≤ 1 px total). */
export const PENCIL_DRIFT = 0.5;
const GRAIN_OFFSET = 0.45;

/**
 * Straight pencil lines with a pencil texture only: each line is cut into 3-7 px pieces whose pressure (opacity and
 * width) drifts slowly, with rare tiny breaks, plus a thin broken grain pass beside it for the grainy edge. The line
 * itself stays straight (sideways drift ≤ 1 px) and ends exactly at its endpoints. Pieces are bucketed by opacity
 * and width so a whole grid is about a dozen paths. Seeded, so it is the same on every render.
 */
export function pencilStrokes(lines: readonly (readonly [number, number, number, number])[], seed: string): PencilPass[] {
  const rand = seededRandom(`pencil:${seed}`);
  const buckets = new Map<string, PencilPass>();
  const add = (opacity: number, width: number, piece: string) => {
    const key = `${opacity}|${width}`;
    const b = buckets.get(key);
    if (b) b.d += piece;
    else buckets.set(key, { d: piece, opacity, width });
  };
  for (const [x1, y1, x2, y2] of lines) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len === 0) continue;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const at = (along: number, across: number) => `${n(x1 + ux * along - uy * across)} ${n(y1 + uy * along + ux * across)}`;
    let pressure = rand();
    let drift = 0;
    let t = 0;
    while (t < len) {
      const step = Math.min(len - t, 3 + rand() * 4);
      pressure = Math.min(1, Math.max(0, pressure + jitter(rand, 0.25)));
      // The last piece lands back on the line, so both ends are exact.
      const next = t + step >= len ? 0 : Math.min(PENCIL_DRIFT, Math.max(-PENCIL_DRIFT, drift + jitter(rand, 0.2)));
      // A rare break in the lead (never at the very ends, so corners still meet).
      const gap = t > 4 && t + step < len - 4 && rand() < 0.05 ? 0.8 + rand() * 0.8 : 0;
      const o = PRESSURE_OPACITY[Math.min(3, Math.floor(pressure * 4))];
      const w = PRESSURE_WIDTH[Math.min(2, Math.floor(rand() * 0.6 + pressure * 2.4))];
      add(o, w, `M${at(t, drift)} L${at(t + step - gap, next)}`);
      if (rand() < 0.45) {
        const side = rand() < 0.5 ? -1 : 1;
        const g0 = t + rand() * step * 0.5;
        add(GRAIN.opacity, GRAIN.width, `M${at(g0, drift + side * GRAIN_OFFSET)} L${at(g0 + 1 + rand() * 2, drift + side * GRAIN_OFFSET)}`);
      }
      drift = next;
      t += step;
    }
  }
  return [...buckets.values()].sort((a, b) => a.opacity - b.opacity || a.width - b.width);
}

/**
 * The month grid's pencil: weeks + 1 horizontal and 8 vertical straight lines over a 7 × weeks grid of cells
 * (offset by `pad` so the grain at the outer edge is not clipped).
 */
export function gridPencil(weeks: number, cellWidth: number, cellHeight: number, seed: string, pad = 0): PencilPass[] {
  const w = cellWidth * 7;
  const h = cellHeight * weeks;
  const lines: [number, number, number, number][] = [];
  for (let r = 0; r <= weeks; r++) lines.push([pad, pad + r * cellHeight, pad + w, pad + r * cellHeight]);
  for (let c = 0; c <= 7; c++) lines.push([pad + c * cellWidth, pad, pad + c * cellWidth, pad + h]);
  return pencilStrokes(lines, `grid:${seed}:${weeks}:${cellWidth}:${cellHeight}`);
}

/** A marker bar: its body (filled at the highlighter opacity) and grain streaks along it (stroked in the same color). */
export type MarkerBar = { body: string; streaks: { d: string; opacity: number }[] };

const STREAK_OPACITY = [0.12, 0.22, 0.32];

/**
 * A straight highlighter bar filling 0..width × 0..height, not a pill: a real start or end ('round' cap) is a
 * slightly slanted chisel tip (up to 1.5 px in from the edge); a week-wrap or month cut ('flat') is an exact
 * straight cut at 0 or width. Marker grain: thin horizontal streaks every ~2 px across the bar, broken in places,
 * bucketed into three opacities. Seeded per bar.
 */
export function markerBar(width: number, height: number, startCap: Cap, endCap: Cap, seed: string): MarkerBar | null {
  if (width <= 0 || height <= 0) return null;
  const rand = seededRandom(`hl:${seed}:${width}:${height}`);
  const tip = Math.min(1.5, width / 4);
  const inset = (cap: Cap) => (cap === 'round' ? rand() * tip : 0);
  const [lt, lb] = [inset(startCap), inset(startCap)];
  const [rt, rb] = [inset(endCap), inset(endCap)];
  const body = `M${n(lt)} 0 L${n(width - rt)} 0 L${n(width - rb)} ${n(height)} L${n(lb)} ${n(height)} Z`;
  const rows = Math.max(1, Math.round(height / 2));
  const lanes = STREAK_OPACITY.map((opacity) => ({ d: '', opacity }));
  for (let i = 0; i < rows; i++) {
    const y = n(((i + 0.5) * height) / rows);
    const left = Math.max(lt, lb) + (startCap === 'round' ? rand() * tip : 0);
    const right = width - Math.max(rt, rb) - (endCap === 'round' ? rand() * tip : 0);
    let x = left;
    while (x < right) {
      const run = Math.min(right - x, 6 + rand() * 24);
      lanes[Math.floor(rand() * 3)].d += `M${n(x)} ${y} L${n(x + run)} ${y}`;
      x += run + (rand() < 0.5 ? rand() * 3 : 0);
    }
  }
  return { body, streaks: lanes.filter((l) => l.d) };
}

export type MonthInfo = { firstCol: number; daysInMonth: number; weeks: number };

/** Where day 1 sits (0 = first column) and how many week rows the month needs; month0 is 0-11. */
export function monthInfo(year: number, month0: number, weekStartsOn = 0): MonthInfo {
  const firstCol = (new Date(year, month0, 1).getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  return { firstCol, daysInMonth, weeks: Math.ceil((firstCol + daysInMonth) / 7) };
}

export type WeekSegment = { row: number; colStart: number; colEnd: number; startCap: Cap; endCap: Cap; emoji: boolean };

/**
 * A day range split into one segment per week row of the shown month. Days outside 1..daysInMonth (a room that
 * began last month, -2, or runs into next month, 33) are clamped, and the clamped side gets a flat cap, as does
 * every week-wrap cut. `emoji` marks the one segment that holds the range's middle day (of the shown part).
 * Null-safe: a range entirely outside the month, or with end < start, gives [].
 */
export function weekSegments(info: MonthInfo, startDay: number, endDay: number): WeekSegment[] {
  if (endDay < startDay) return [];
  const s = Math.max(1, startDay);
  const e = Math.min(info.daysInMonth, endDay);
  if (e < s) return [];
  const mid = Math.floor((s + e) / 2);
  const pos = (day: number) => info.firstCol + day - 1;
  const out: WeekSegment[] = [];
  let day = s;
  while (day <= e) {
    const row = Math.floor(pos(day) / 7);
    const last = Math.min(e, day + (6 - (pos(day) % 7)));
    out.push({
      row,
      colStart: pos(day) % 7,
      colEnd: pos(last) % 7,
      startCap: day === startDay ? 'round' : 'flat',
      endCap: last === endDay ? 'round' : 'flat',
      emoji: mid >= day && mid <= last,
    });
    day = last + 1;
  }
  return out;
}

/**
 * One VoiceOver element per room: keys (`itemId:row`) of each item's first visible week-row segment. Pass only the
 * segments that are drawn, so a room whose first row is hidden still gets one element.
 */
export function primarySegments(segments: readonly { itemId: string; row: number }[]): Set<string> {
  const first = new Map<string, number>();
  for (const s of segments) {
    const r = first.get(s.itemId);
    if (r == null || s.row < r) first.set(s.itemId, s.row);
  }
  return new Set([...first].map(([id, row]) => `${id}:${row}`));
}

/** Accessibility props for one stroke segment: the primary one is a labelled button; the rest stay tappable but are hidden from VoiceOver. */
export function strokeA11y(primary: boolean, label: string | undefined) {
  return primary
    ? { accessible: true, accessibilityRole: 'button' as const, accessibilityLabel: label }
    : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
}
