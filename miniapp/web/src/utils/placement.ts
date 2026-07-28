/**
 * Popover placement.
 *
 * Kept as a pure function so the flip/clamp rules can be tested without a
 * DOM. The original version only ever opened upward, which works for the
 * thread's bottom-bar pills but pushed the home screen's composer pills --
 * which sit near the TOP of the viewport -- almost entirely offscreen.
 *
 * The rules, in order:
 *   1. Prefer the requested side (above, matching Aside's bottom bar).
 *   2. Flip to the other side when the preferred one cannot fit the
 *      content and the other side has more room.
 *   3. Never exceed the space actually available: cap the height and let
 *      the popover scroll internally.
 *   4. Clamp horizontally into the viewport with a margin.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PlacementInput {
  anchor: Rect;
  viewport: Viewport;
  /** Desired popover width. */
  width: number;
  /** Natural (unconstrained) content height. */
  height: number;
  /** Side to try first. */
  prefer?: 'above' | 'below';
  /** Gap between anchor and popover. */
  gap?: number;
  /** Minimum distance from any viewport edge. */
  margin?: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Height cap; the popover scrolls internally beyond this. */
  maxHeight: number;
  placement: 'above' | 'below';
}

export function placePopover({
  anchor,
  viewport,
  width,
  height,
  prefer = 'above',
  gap = 6,
  margin = 8,
}: PlacementInput): Placement {
  const anchorBottom = anchor.top + anchor.height;

  // Room between the anchor and each viewport edge, once the gap and the
  // edge margin are taken out.
  const roomAbove = Math.max(0, anchor.top - gap - margin);
  const roomBelow = Math.max(0, viewport.height - anchorBottom - gap - margin);

  const preferredRoom = prefer === 'above' ? roomAbove : roomBelow;
  const otherRoom = prefer === 'above' ? roomBelow : roomAbove;

  // Only flip when the preferred side genuinely cannot show the content
  // AND the other side is roomier -- flipping into an equally cramped
  // side just moves the problem.
  const flip = height > preferredRoom && otherRoom > preferredRoom;
  const placement: 'above' | 'below' = flip
    ? prefer === 'above'
      ? 'below'
      : 'above'
    : prefer;

  const room = placement === 'above' ? roomAbove : roomBelow;
  const maxHeight = Math.max(0, Math.min(height, room));

  const top =
    placement === 'above'
      ? anchor.top - gap - maxHeight
      : anchorBottom + gap;

  return {
    left: clampHorizontally(anchor, viewport, width, margin),
    // A zero-room edge case can still push `top` negative; keep it onscreen.
    top: Math.max(margin, top),
    maxHeight,
    placement,
  };
}

/**
 * Centre on the anchor, then pull back inside the viewport.
 *
 * When the popover is wider than the viewport allows, the clamp range
 * inverts; pinning to the left margin keeps the start of each row visible
 * rather than letting Math.min win and pushing it off the left edge.
 */
function clampHorizontally(
  anchor: Rect,
  viewport: Viewport,
  width: number,
  margin: number,
): number {
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const maxLeft = viewport.width - width - margin;
  if (maxLeft <= margin) return margin;
  return Math.min(Math.max(margin, centred), maxLeft);
}
