/**
 * Name to show for a sender or uploader. During the 30-minute grace after an early end, a member can read only their
 * own room_members row (0027 members_select_own_grace), so the host is missing from the names map; the room row still
 * carries host_id, so the host shows as "Host" instead of "Former member". Anyone else missing stays "Former member".
 * `labels` is en.chat (pure module: no i18n import, so node tests can load it).
 */
export function memberName(
  names: ReadonlyMap<string, string> | undefined,
  userId: string,
  hostId: string | null | undefined,
  labels: { host: string; formerMember: string },
): string {
  return names?.get(userId) ?? (hostId && userId === hostId ? labels.host : labels.formerMember);
}
