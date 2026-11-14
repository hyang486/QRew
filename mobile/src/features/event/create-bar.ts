/**
 * Create room's bottom bar (E2E finding i): a tap meant for a switch clipped at the scroll edge landed on Create.
 * The bar gets a full-width hairline at the scroll boundary and a non-tappable gap above the button. QScreen's
 * actions container already pads by these values (q-screen.tsx `actions`); the test checks they still match.
 */
export const QSCREEN_ACTIONS = { paddingTop: 12, side: 24 } as const;

/** Space between the hairline (scroll boundary) and the first thing in the bar; nothing in it is tappable. */
export const CREATE_BAR_GAP = 16;

export const createBarLayout = {
  // Pull the wrapper to the bar's top and side edges, so the hairline spans the screen at the scroll boundary.
  marginTop: -QSCREEN_ACTIONS.paddingTop,
  marginHorizontal: -QSCREEN_ACTIONS.side,
  paddingHorizontal: QSCREEN_ACTIONS.side,
  paddingTop: CREATE_BAR_GAP,
  gap: 12,
} as const;
