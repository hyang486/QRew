// The Ask Qrewing button's footprint, in one place: the button, every screen that pads its scroll content for
// it, and QScreen's `floating` slot read these (UI audit 2026-11-13 item 1). Plain numbers, no imports, so a
// shared component can use them without pulling in the button.
export const QREWING_FAB_SIZE = 56;
/** Gap between the button and the bottom (and right) edge of the area it floats in. */
export const QREWING_FAB_MARGIN = 12;
/**
 * Bottom padding for a scroll area under the button: margin + button + the same gap above it, so the last row
 * scrolls fully clear. Add the home-indicator inset too when the area reaches the bottom of the screen.
 */
export const QREWING_FAB_CLEARANCE = QREWING_FAB_MARGIN + QREWING_FAB_SIZE + QREWING_FAB_MARGIN;
