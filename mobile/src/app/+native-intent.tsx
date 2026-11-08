import { handleRootLink } from '@/lib/root-link';

// Native-only URL hook (Expo Router). While signed in, a warm `moment:///` resets to the Rooms
// root (N-1, closing an open modal first), and a warm join link that arrives while a modal is open
// is opened from the root after the modal closes (P-3); see root-link.ts. A link the handler took
// is dropped (null) so it is not navigated a second time. Everything else (cold start, signed out,
// a join link with no modal open, other links) passes through unchanged.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (handleRootLink(path, initial)) return null;
  } catch (e) {
    console.warn('[root-link] handling failed', e);
  }
  return path;
}
