// Pure defaults for the Create room screen (running-crew #11). No React Native imports, so `npm test` can run it.

/** Default room length in hours by room type. Sports is 3 h (human decision 2026-11-07); others keep 4 days. */
export function defaultRoomHours(type: string) {
  return type === 'sports' ? 3 : 96;
}

/** "Deleted at" preview without seconds, so a value refreshed every few seconds does not look stale. */
export function formatDeletedAt(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
