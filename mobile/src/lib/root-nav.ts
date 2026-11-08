/**
 * C-3: a screen opened from outside the current flow (a tapped expiry reminder, or a warm invite
 * link while a modal is open, P-3) must not be pushed on top of a presented modal (Invite,
 * Upgrade): native-stack presents a screen with no `presentation` above a modal as one more sheet
 * on that modal. Every screen lives in the root stack, so returning to its first screen (Rooms)
 * dismisses any modal; the target is then pushed from the root. Pure (takes the router) so it can
 * be tested.
 */
export type RootRouter<Href> = {
  canDismiss(): boolean;
  dismissAll(): void;
  push(href: Href): void;
};

export function pushFromRoot<Href>(router: RootRouter<Href>, href: Href) {
  if (router.canDismiss()) router.dismissAll();
  router.push(href);
}

export type ResetRouter<Href> = {
  canDismiss(): boolean;
  dismissAll(): void;
  dismissTo(href: Href): void;
};

/**
 * N-1 + P-3: back to Rooms for a warm `moment:///`. With a modal open, first return to the stack's
 * first screen the way C-3 does (dismissAll, which closes the modal); `dismissTo` then pops to
 * Rooms, or replaces the first screen with it when Rooms is not in the stack. Without a modal this
 * is exactly N-1 (`dismissTo` only).
 */
export function resetToRoot<Href>(router: ResetRouter<Href>, rootHref: Href, modalOpen: boolean) {
  if (modalOpen && router.canDismiss()) router.dismissAll();
  router.dismissTo(rootHref);
}
