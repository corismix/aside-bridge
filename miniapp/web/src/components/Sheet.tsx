import { useEffect, type ReactNode } from 'react';
import { X } from './Icons';

/**
 * A modal panel that slides in from an edge, over a dimmed backdrop.
 *
 * Two edges, because Aside uses two: `bottom` for the transient sheets a
 * tap opens (sources, a file), `right` for the session sidebar. Both are
 * dismissed by the backdrop, by the close button, and by Escape.
 */
export function Sheet({
  side,
  title,
  subtitle,
  onClose,
  children,
}: {
  side: 'bottom' | 'right';
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-layer">
      <div className="sheet-backdrop" onClick={onClose} />
      <section className={`sheet sheet-${side}`} role="dialog" aria-label={title}>
        <header className="sheet-head">
          <div className="sheet-titles">
            <span className="sheet-title">{title}</span>
            {subtitle ? <span className="sheet-subtitle">{subtitle}</span> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}
