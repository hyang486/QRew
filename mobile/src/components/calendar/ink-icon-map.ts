/**
 * Qrewing Calendar look (human final 2026-11-13 ~10:50): room and event marks are black-ink line icons in the
 * assets/art pen style, not color emoji. Items still store an emoji (server recap, editor grid); this maps it to a
 * line icon on the client, with a pin for anything unknown. Paths are drawn in a 24-unit box, stroked, unfilled.
 */
export type InkIconKey =
  | 'pin'
  | 'party'
  | 'coffee'
  | 'run'
  | 'meal'
  | 'cake'
  | 'bike'
  | 'ball'
  | 'music'
  | 'book'
  | 'plane'
  | 'beach'
  | 'hospital'
  | 'work'
  | 'cart'
  | 'heart'
  | 'hourglass'
  | 'chat';

export const INK_ICON_BOX = 24;

/** Each icon: its spoken word (VoiceOver says this, never the emoji) and its stroke paths. */
export const INK_ICONS: Record<InkIconKey, { label: string; paths: readonly string[] }> = {
  pin: { label: 'Pin', paths: ['M12 21C12 21 6 14.8 6 10A6 6 0 0 1 18 10C18 14.8 12 21 12 21Z', 'M14 10A2 2 0 1 1 10 10A2 2 0 1 1 14 10'] },
  party: {
    label: 'Party',
    paths: ['M4 20L8.5 8.5L15.5 15.5Z', 'M12 4.5Q14 2.5 15.5 4.5', 'M17 7L19.5 5.5', 'M18.5 11L21 11.5', 'M14 8L15 7'],
  },
  coffee: {
    label: 'Coffee',
    paths: ['M5 9L6 18Q10.5 20.5 15 18L16 9Q10.5 10 5 9', 'M16 11Q20 11 19.5 14Q19 16.5 15.5 16', 'M9 6.5Q7.5 5 9.5 3', 'M12.5 6.5Q11 4.5 13 2.5'],
  },
  run: { label: 'Run', paths: ['M3 16L4 9Q7 10 9 7L13 11Q18 12 21 15L21 17Q12 18.5 3 16', 'M8 9L10 11', 'M10 7.5L12 9.5'] },
  meal: {
    label: 'Meal',
    paths: ['M17 13A5 5 0 1 1 7 13A5 5 0 1 1 17 13', 'M3.5 4V9.5Q4.5 11 5.5 9.5V4', 'M4.5 10.5V20', 'M20.5 4Q18.5 7 19.5 12H20.5V20'],
  },
  cake: { label: 'Birthday', paths: ['M5 12H19V20H5Z', 'M5 15.5Q7.3 17 9.7 15.5Q12 14 14.3 15.5Q16.7 17 19 15.5', 'M12 12V8', 'M12 6Q10.8 4.7 12 3Q13.2 4.7 12 6'] },
  bike: {
    label: 'Bike',
    paths: [
      'M9.5 16A3.5 3.5 0 1 1 2.5 16A3.5 3.5 0 1 1 9.5 16',
      'M21.5 16A3.5 3.5 0 1 1 14.5 16A3.5 3.5 0 1 1 21.5 16',
      'M6 16L10 9H15L18 16',
      'M10 9L12.5 16L15 9',
      'M12.5 16H6',
      'M9 7H11.5',
      'M15 9L14.5 6.5H16.5',
    ],
  },
  ball: {
    label: 'Ball',
    paths: [
      'M20 12A8 8 0 1 1 4 12A8 8 0 1 1 20 12',
      'M12 8.5L15 10.7L13.9 14.2H10.1L9 10.7Z',
      'M12 8.5V4.2',
      'M15 10.7L19 9.5',
      'M13.9 14.2L16.3 17.6',
      'M10.1 14.2L7.7 17.6',
      'M9 10.7L5 9.5',
    ],
  },
  music: {
    label: 'Music',
    paths: ['M9 18V6L19 4V16', 'M9 18A2.5 2 0 1 1 4 18A2.5 2 0 1 1 9 18', 'M19 16A2.5 2 0 1 1 14 16A2.5 2 0 1 1 19 16'],
  },
  book: { label: 'Book', paths: ['M12 6.5Q8 4.5 3.5 5.5V18.5Q8 17.5 12 19.5Q16 17.5 20.5 18.5V5.5Q16 4.5 12 6.5Z', 'M12 6.5V19.5'] },
  plane: {
    label: 'Trip',
    paths: ['M3 12Q12 10 20 11Q22 12 20 13Q12 14 3 12', 'M10 11.4L7 5H9L14 11.1', 'M10 12.7L7 19H9L14 12.9', 'M4.5 11.8L3 8.5H4.5L7 11.3'],
  },
  beach: { label: 'Beach', paths: ['M4 11Q12 2 20 11Q16 9 12 11Q8 9 4 11', 'M12 11L14 19', 'M3 20Q12 17.5 21 20'] },
  hospital: { label: 'Hospital', paths: ['M5 20V7H19V20', 'M12 10V16', 'M9 13H15', 'M3 20H21'] },
  work: { label: 'Work', paths: ['M3.5 8H20.5V19H3.5Z', 'M9 8V5.5H15V8', 'M3.5 12.5Q12 14.5 20.5 12.5'] },
  cart: {
    label: 'Shopping',
    paths: [
      'M2.5 4H5.5L7.7 14.5H18L20 7H6.5',
      'M10 18.5A1.3 1.3 0 1 1 7.4 18.5A1.3 1.3 0 1 1 10 18.5',
      'M18 18.5A1.3 1.3 0 1 1 15.4 18.5A1.3 1.3 0 1 1 18 18.5',
    ],
  },
  heart: { label: 'Love', paths: ['M12 19.5C12 19.5 4 14.5 4 9.2A4 4 0 0 1 12 7.5A4 4 0 0 1 20 9.2C20 14.5 12 19.5 12 19.5Z'] },
  hourglass: {
    label: 'Waiting',
    paths: ['M6.5 3.5H17.5', 'M6.5 20.5H17.5', 'M7.5 3.5Q7.5 8.5 12 12Q7.5 15.5 7.5 20.5', 'M16.5 3.5Q16.5 8.5 12 12Q16.5 15.5 16.5 20.5', 'M10 18.5H14'],
  },
  chat: { label: 'Chat', paths: ['M4 6.5Q4 4.5 6 4.5H18Q20 4.5 20 6.5V13.5Q20 15.5 18 15.5H11L6.5 19.5V15.5H6Q4 15.5 4 13.5Z'] },
};

/**
 * Base emoji (no variation selector, skin tone or ZWJ tail) → icon. Covers the editor's 16-emoji grid, the
 * server's room-type fallbacks (sports 🏃, event 🎉, waiting ⏳, general 💬) and common diary picks.
 */
const BY_EMOJI: Record<string, InkIconKey> = {
  '📌': 'pin', '📍': 'pin', '🗺': 'pin',
  '🎉': 'party', '🎊': 'party', '🥳': 'party', '🎈': 'party', '🍻': 'party', '🍺': 'party', '🥂': 'party', '🍷': 'party',
  '☕': 'coffee', '🍵': 'coffee', '🧋': 'coffee',
  '🏃': 'run', '👟': 'run', '🏅': 'run', '🚶': 'run', '🥾': 'run',
  '🍽': 'meal', '🍴': 'meal', '🍕': 'meal', '🍔': 'meal', '🍜': 'meal', '🍣': 'meal', '🍱': 'meal', '🥘': 'meal', '🥗': 'meal', '🍝': 'meal',
  '🎂': 'cake', '🍰': 'cake', '🧁': 'cake', '🎁': 'cake',
  '🚴': 'bike', '🚲': 'bike', '🚵': 'bike',
  '⚽': 'ball', '🏀': 'ball', '⚾': 'ball', '🏈': 'ball', '🎾': 'ball', '🏐': 'ball',
  '🎵': 'music', '🎶': 'music', '🎤': 'music', '🎸': 'music', '🎧': 'music',
  '📚': 'book', '📖': 'book', '✏': 'book', '📝': 'book',
  '✈': 'plane', '🛫': 'plane', '🧳': 'plane',
  '🏖': 'beach', '🏝': 'beach', '🌊': 'beach', '⛱': 'beach',
  '🏥': 'hospital', '💊': 'hospital', '🩺': 'hospital',
  '💼': 'work', '💻': 'work', '🏢': 'work',
  '🛒': 'cart', '🛍': 'cart',
  '❤': 'heart', '💕': 'heart', '💖': 'heart', '🧡': 'heart', '💛': 'heart', '💚': 'heart', '💙': 'heart', '💜': 'heart',
  '⏳': 'hourglass', '⌛': 'hourglass', '⏰': 'hourglass',
  '💬': 'chat', '🗨': 'chat', '👋': 'chat',
};

/** The emoji's base: before any ZWJ, without variation selectors and skin tones. */
export function emojiBase(emoji: string): string {
  return (emoji.trim().split('‍')[0] ?? '').replace(/[︎️\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** The line icon for a stored emoji; the pin when it is unknown or empty. */
export function inkIconKey(emoji: string | null | undefined): InkIconKey {
  return (emoji ? BY_EMOJI[emojiBase(emoji)] : undefined) ?? 'pin';
}

/** The word VoiceOver reads for an emoji's icon. */
export function inkIconLabel(emoji: string | null | undefined): string {
  return INK_ICONS[inkIconKey(emoji)].label;
}
