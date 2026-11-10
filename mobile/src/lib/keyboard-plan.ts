// QScreen keyboard rules (qa K1/K2 at 595f1cf). Pure (no React Native imports) so node --test can load them.
// revealScrollY compares rects from measureInWindow only with each other (one space, also inside a sheet).

export type Span = { top: number; bottom: number };

/**
 * How much the keyboard covers a Q screen: the bottom padding that keeps the pinned actions above it. It is the
 * part of the keyboard on screen (window height - keyboard top), never more than the keyboard itself.
 *
 * It does not use the root's measureInWindow: in a pageSheet (K2) Fabric reports that in the sheet's own space
 * (root y 0, height 797 on the 17e while the sheet sat 47 pt down), but the keyboard comes in screen coordinates,
 * so comparing the two left the pad 47 pt short. A Q screen always reaches the bottom of the window (pushed
 * screens and iPhone sheets are bottom-anchored), so the covered part is the keyboard's visible height.
 * `keyboard` null = hidden.
 */
export function keyboardOverlap(windowHeight: number, keyboard: { screenY: number; height: number } | null): number {
  if (!keyboard || keyboard.height <= 0) return 0;
  return Math.round(Math.min(keyboard.height, Math.max(0, windowHeight - keyboard.screenY)));
}

/**
 * The scroll offset that brings `target` into the `visible` part of the scroll view with `margin` around it, or
 * null when it is already in view. The focused field wins: `extra` (e.g. the form's submit button, K2) is
 * included only when field and extra fit together. A target taller than the view is aligned at its top.
 * The result is clamped to the scrollable range [0, maxY].
 */
export function revealScrollY(
  currentY: number,
  field: Span,
  visible: Span,
  maxY: number,
  extra?: Span | null,
  margin = 16,
): number | null {
  const room = visible.bottom - visible.top - 2 * margin;
  let target = field;
  if (extra) {
    const both = { top: Math.min(field.top, extra.top), bottom: Math.max(field.bottom, extra.bottom) };
    if (both.bottom - both.top <= room) target = both;
  }
  let delta = 0;
  if (target.bottom - target.top > room || target.top < visible.top + margin) {
    delta = target.top - (visible.top + margin);
  } else if (target.bottom > visible.bottom - margin) {
    delta = target.bottom - (visible.bottom - margin);
  }
  if (Math.abs(delta) < 1) return null;
  const next = Math.min(Math.max(0, currentY + delta), Math.max(0, maxY));
  return Math.abs(next - currentY) < 1 ? null : next;
}
