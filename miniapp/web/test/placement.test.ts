/**
 * Popover placement.
 *
 * The bug these cover: the popover only ever opened upward, so the home
 * screen's composer pills -- which sit near the TOP of the viewport --
 * rendered almost entirely offscreen. Only the last row was visible
 * ("Settings" on the model picker, "Ultrabrowse" on Reasoning).
 *
 * The two anchor positions below are taken from the real layout at
 * 430x932: the home composer pill at y≈128 and the thread bottom-bar pill
 * at y≈880.
 */
import { describe, expect, it } from 'vitest';
import { placePopover } from '../src/utils/placement';

const VIEWPORT = { width: 430, height: 932 };
const HOME_PILL = { top: 128, left: 210, width: 96, height: 30 };
const BOTTOM_PILL = { top: 880, left: 300, width: 96, height: 30 };

describe('placePopover', () => {
  it('flips below for a top-anchored pill that cannot fit above', () => {
    const p = placePopover({
      anchor: HOME_PILL,
      viewport: VIEWPORT,
      width: 244,
      height: 320,
    });

    expect(p.placement).toBe('below');
    // Opens just under the pill and stays fully onscreen.
    expect(p.top).toBeGreaterThanOrEqual(HOME_PILL.top + HOME_PILL.height);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('keeps a bottom-anchored pill opening upward', () => {
    const p = placePopover({
      anchor: BOTTOM_PILL,
      viewport: VIEWPORT,
      width: 244,
      height: 320,
    });

    expect(p.placement).toBe('above');
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(BOTTOM_PILL.top);
  });

  it('never places content above the top edge', () => {
    // The regression: a tall menu on a top-anchored pill.
    for (const height of [200, 320, 600, 5000]) {
      const p = placePopover({
        anchor: HOME_PILL,
        viewport: VIEWPORT,
        width: 244,
        height,
      });
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it('caps height to the available room so the popover scrolls instead', () => {
    const p = placePopover({
      anchor: BOTTOM_PILL,
      viewport: VIEWPORT,
      width: 244,
      height: 5000,
    });
    expect(p.maxHeight).toBeLessThan(5000);
    expect(p.maxHeight).toBe(BOTTOM_PILL.top - 6 - 8);
  });

  it('does not cap a menu that already fits', () => {
    const p = placePopover({
      anchor: BOTTOM_PILL,
      viewport: VIEWPORT,
      width: 244,
      height: 180,
    });
    expect(p.maxHeight).toBe(180);
    expect(p.placement).toBe('above');
  });

  it('honours an explicit "below" preference when it fits', () => {
    const p = placePopover({
      anchor: HOME_PILL,
      viewport: VIEWPORT,
      width: 244,
      height: 200,
      prefer: 'below',
    });
    expect(p.placement).toBe('below');
  });

  it('does not flip when the other side is no roomier', () => {
    // Truly centred: the anchor's own height has to be taken out, so
    // top = (932 - 30) / 2 leaves identical room on both sides. Flipping
    // into an equally cramped side would just move the problem.
    const height = 30;
    const centre = {
      top: (VIEWPORT.height - height) / 2,
      left: 100,
      width: 96,
      height,
    };
    const p = placePopover({
      anchor: centre,
      viewport: VIEWPORT,
      width: 244,
      height: 5000,
    });
    expect(p.placement).toBe('above');
    expect(p.maxHeight).toBe(centre.top - 6 - 8);
  });

  describe('horizontal clamping', () => {
    it('centres on the anchor when there is room', () => {
      const p = placePopover({
        anchor: { top: 400, left: 150, width: 100, height: 30 },
        viewport: VIEWPORT,
        width: 200,
        height: 100,
      });
      expect(p.left).toBe(100); // 150 + 50 - 100
    });

    it('pulls back from the right edge', () => {
      const p = placePopover({
        anchor: { top: 400, left: 400, width: 96, height: 30 },
        viewport: VIEWPORT,
        width: 244,
        height: 100,
      });
      expect(p.left).toBe(VIEWPORT.width - 244 - 8);
      expect(p.left).toBeGreaterThanOrEqual(8);
    });

    it('pulls back from the left edge', () => {
      const p = placePopover({
        anchor: { top: 400, left: 0, width: 40, height: 30 },
        viewport: VIEWPORT,
        width: 244,
        height: 100,
      });
      expect(p.left).toBe(8);
    });

    it('pins to the left margin when wider than the viewport allows', () => {
      const p = placePopover({
        anchor: { top: 400, left: 10, width: 40, height: 30 },
        viewport: { width: 200, height: 932 },
        width: 244,
        height: 100,
      });
      // Clamp range inverts here; the start of each row must stay visible.
      expect(p.left).toBe(8);
    });
  });

  it('survives a zero-height viewport without going negative', () => {
    const p = placePopover({
      anchor: { top: 0, left: 0, width: 0, height: 0 },
      viewport: { width: 0, height: 0 },
      width: 244,
      height: 100,
    });
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });
});
