/**
 * The anchored popover the pills open.
 *
 * Aside's pickers are popovers anchored to their trigger, not bottom
 * sheets. They open upward from the thread's bottom bar, but the home
 * screen's composer pills sit near the top of the viewport, so the popover
 * has to flip below rather than render offscreen. All of that logic lives
 * in `placePopover`; this component only measures and applies it.
 *
 * This is one of the few surfaces where Aside does use glass, at blur-xl.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placePopover, type Placement } from '../utils/placement';

export interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  /** Popover width in px; menus in Aside are a fixed, narrow column. */
  width?: number;
  /** Side to try first. Bottom-bar pills keep opening upward. */
  prefer?: 'above' | 'below';
}

export function Popover({
  anchor,
  onClose,
  children,
  width = 232,
  prefer = 'above',
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return undefined;

    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const rect = anchor.getBoundingClientRect();

      // scrollHeight is the natural content height even while the element
      // is capped by a previous pass's maxHeight -- measuring offsetHeight
      // instead would ratchet the popover smaller on every reflow.
      const next = placePopover({
        anchor: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        width,
        height: el.scrollHeight,
        prefer,
      });
      setPos((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };

    measure();

    // The on-screen keyboard resizes the visual viewport rather than
    // firing a plain resize, so both are watched.
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [anchor, width, prefer, children]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // `capture` so a tap that also lands on a button behind the scrim still
    // closes the popover first.
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  // Rendered even before the first measurement -- the element has to be in
  // the document to have a height to measure. It stays invisible (but
  // laid out) for that one pass so nothing flashes at the wrong place.
  return (
    <div
      ref={ref}
      className={`popover ${pos ? `is-${pos.placement}` : ''}`}
      role="menu"
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight, width }
          : { left: 0, top: 0, width, visibility: 'hidden' }
      }
    >
      {children}
    </div>
  );
}

export function PopoverTitle({ children }: { children: React.ReactNode }) {
  return <div className="popover-title">{children}</div>;
}

export function PopoverRow({
  children,
  onClick,
  selected,
  trailing,
  leading,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  trailing?: React.ReactNode;
  leading?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`popover-row ${selected ? 'is-selected' : ''} ${className}`}
      onClick={onClick}
    >
      {leading ? <span className="popover-row-lead">{leading}</span> : null}
      <span className="popover-row-label">{children}</span>
      {trailing ? <span className="popover-row-trail">{trailing}</span> : null}
    </button>
  );
}
