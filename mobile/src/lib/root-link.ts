/**
 * N-1: the bare app link `moment:///` must reset to the Rooms root instead of pushing a second
 * Rooms screen. Expo Router handles a link that arrives while the app runs as a navigate, which
 * pushes. `+native-intent` asks `rootLinkPlan` whether to take over; `+native-intent` has no auth
 * or navigation context, so the signed-in root navigator registers the handler that resets.
 *
 * P-3: a warm link that arrives while a modal (Invite, Become a host) is open must close the modal
 * first, like a reminder tap (C-3). Default handling navigates from the top of the root stack, so
 * the link's screen lands above the modal, never at the root. A root link then resets through
 * the modal; a join link is opened from the root instead of passing through.
 * Pure parts (no Expo imports) so they can be tested in Node.
 */

/** Root-stack routes presented as modals (`presentation: 'modal'` in `app/_layout.tsx`). */
export const MODAL_ROUTES: readonly string[] = ['upgrade', 'room/[id]/invite'];

/** Splits a link into its path after the scheme, without query or hash; null for a foreign URL. */
function linkPath(path: string): string | null {
  let rest = path.trim().replace(/[?#].*$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    // A custom-scheme URL keeps its first path segment in the host slot (moment://join/x).
    if (rest.startsWith('//')) rest = rest.slice(2);
    else return null;
  }
  return rest;
}

/** True for the app's root URL (`moment:///`, `moment://`, `/`), ignoring query and hash. */
export function isRootLink(path: string): boolean {
  const rest = linkPath(path);
  return rest !== null && /^\/*$/.test(rest);
}

/**
 * The in-app href for an invite link (`moment://join/<token>`, `moment:///join/<token>`,
 * `/join/<token>`), or null. The token is not validated here: `join/[token]` shows the invalid
 * invite message itself.
 */
export function joinLinkHref(path: string): string | null {
  const rest = linkPath(path);
  if (rest === null) return null;
  const match = /^\/*join\/([^/]+)\/?$/i.exec(rest);
  return match ? `/join/${match[1]}` : null;
}

type RouteState = { index?: number; routes: readonly { name: string; state?: RouteState }[] };

/**
 * True when an active route of the root stack is a modal (preloaded routes are ignored). The
 * container's root state wraps the app's root stack in a single `__root` route (expo-router), so
 * the check follows the focused route's nested state down through every level (P-3 qa log).
 */
export function hasOpenModal(state: RouteState | null | undefined, modalRoutes: readonly string[] = MODAL_ROUTES): boolean {
  if (!state || state.routes.length === 0) return false;
  const top = Math.min(state.index ?? state.routes.length - 1, state.routes.length - 1);
  const active = state.routes.slice(0, top + 1);
  if (active.some((route) => modalRoutes.includes(route.name))) return true;
  return hasOpenModal(state.routes[top].state, modalRoutes);
}

/**
 * 'reset' = the handler resets to the Rooms root (closing an open modal) and the link is dropped.
 * 'join' = a modal is open: the handler closes it and opens the invite from the root; the link is
 * dropped. 'pass' = default Expo Router handling (cold start, no modal, other links, signed out).
 */
export type RootLinkPlan = 'reset' | 'join' | 'pass';

export function rootLinkPlan(path: string, initial: boolean, hasHandler: boolean, modalOpen = false): RootLinkPlan {
  if (initial || !hasHandler) return 'pass';
  if (isRootLink(path)) return 'reset';
  if (modalOpen && joinLinkHref(path) !== null) return 'join';
  return 'pass';
}

export type RootLinkHandler = {
  /** Whether a modal is open in the root stack right now. */
  isModalOpen(): boolean;
  /** Back to Rooms; `modalOpen` says whether a modal has to be closed on the way. */
  reset(modalOpen: boolean): void;
  /** Close the open modal and open `href` from the Rooms root. */
  openFromRoot(href: string): void;
};

let linkHandler: RootLinkHandler | null = null;

/** Set by the signed-in root navigator; null when signed out. */
export function setRootLinkHandler(handler: RootLinkHandler | null) {
  linkHandler = handler;
}

/** Runs the handler for a link it takes over and returns true, or returns false to let it through. */
export function handleRootLink(path: string, initial: boolean): boolean {
  const handler = linkHandler;
  if (!handler || initial) return false;
  const modalOpen = handler.isModalOpen();
  const plan = rootLinkPlan(path, initial, true, modalOpen);
  if (plan === 'reset') {
    handler.reset(modalOpen);
    return true;
  }
  const href = plan === 'join' ? joinLinkHref(path) : null;
  if (href === null) return false;
  handler.openFromRoot(href);
  return true;
}
