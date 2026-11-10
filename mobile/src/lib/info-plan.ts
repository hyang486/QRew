// Pure helpers for Room info (Qrew unit 5, Q 03.03 "12 people · 8 arrived"). No React Native imports, so
// `npm test` can load them.

/**
 * How many current members arrived in the room's current activity. Arrival rows outlive membership (a member who
 * arrived and then left keeps the row), so only rows of people still in the room count, each once.
 */
export function arrivedMemberCount(memberIds: readonly string[], arrivedIds: readonly string[]): number {
  const members = new Set(memberIds);
  return new Set(arrivedIds.filter((id) => members.has(id))).size;
}
