// Qrew redesign R1 (supervisor ruling, 2026-11-09): which ink art a room shows, from its name only.
// Pure (no React Native imports): unit tested. No DB field: preview_room and rooms already return `name`,
// so old rooms get a theme too. There is no picker or override (human decision).

export type RoomTheme = 'motorcycle' | 'bike' | 'hike' | 'run' | 'gathering';

type Rule = { theme: Exclude<RoomTheme, 'gathering'>; words: string[]; korean: string[] };

/**
 * Checked in this order; the first match wins. Latin terms match whole words only (so "brunch", "Crunch Time"
 * and "trunk" are not runs). Korean terms are substrings, so particles and compounds match ("러닝크루").
 * Rulings: 바이크 alone, ride / riding / 라이딩 alone → gathering (ambiguous); "Motor Bike" → bike.
 * 모터사이클 contains 사이클, so motorcycle is checked before bike.
 */
const RULES: Rule[] = [
  { theme: 'motorcycle', words: ['motorcycle', 'motorcycles', 'motorbike', 'motorbikes'], korean: ['오토바이', '모터사이클'] },
  {
    theme: 'bike',
    words: ['bike', 'bikes', 'biking', 'bicycle', 'bicycles', 'cycling', 'cyclist', 'cyclists'],
    korean: ['자전거', '사이클'],
  },
  { theme: 'hike', words: ['hike', 'hikes', 'hiking', 'trek', 'trekking'], korean: ['등산', '하이킹', '산행'] },
  {
    theme: 'run',
    words: ['run', 'runs', 'running', 'runner', 'runners', 'marathon', 'jog', 'jogging'],
    korean: ['러닝', '런닝', '달리기', '마라톤'],
  },
];

/**
 * Supervisor F1: common Korean compounds that contain a theme term but are not that activity. They are
 * removed before the Korean substring check: 머신러닝 / 딥러닝 / 이러닝 / e러닝 (learning, not 러닝), 부산행
 * (to Busan, not 산행), 리사이클 (recycle, not 사이클).
 */
const KOREAN_EXCLUSIONS = ['머신러닝', '딥러닝', '이러닝', 'e러닝', '부산행', '리사이클'];

/** NFKC, trimmed, lower case (full-width "ＲＵＮ" and "  saturday RUN crew " read like "run"). */
export function normalizeRoomName(name: string) {
  return name.normalize('NFKC').trim().toLowerCase();
}

/** The room's art theme. Anything unmatched (including an empty or emoji-only name) is a gathering. */
export function roomTheme(name: string | null | undefined): RoomTheme {
  const text = normalizeRoomName(name ?? '');
  // Whole Latin words: split on everything that is not a Latin letter, so "run크루" still yields "run".
  const words = new Set(text.match(/\p{Script=Latin}+/gu) ?? []);
  const korean = KOREAN_EXCLUSIONS.reduce((t, x) => t.split(x).join(' '), text);
  for (const rule of RULES) {
    if (rule.words.some((w) => words.has(w)) || rule.korean.some((k) => korean.includes(k))) return rule.theme;
  }
  return 'gathering';
}
