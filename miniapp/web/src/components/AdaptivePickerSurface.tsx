import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Popover, PopoverTitle } from './Popover';
import { Sheet } from './Sheet';

const PickerPresentation = createContext<'menu' | 'sheet'>('menu');

/** Shared responsive surface for composer selectors. */
export function AdaptivePickerSurface({
  anchor,
  title,
  onClose,
  children,
  width = 264,
}: {
  anchor: HTMLElement | null;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia?.('(max-width: 639px)').matches ?? window.innerWidth < 640),
  );

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 639px)');
    if (!query) {
      const updateFromWidth = () => setPhone(window.innerWidth < 640);
      window.addEventListener('resize', updateFromWidth);
      updateFromWidth();
      return () => window.removeEventListener('resize', updateFromWidth);
    }
    const updateFromQuery = () => setPhone(query.matches);
    updateFromQuery();
    query.addEventListener('change', updateFromQuery);
    return () => query.removeEventListener('change', updateFromQuery);
  }, []);

  if (phone) {
    return (
      <Sheet side="bottom" title={title} onClose={onClose} className="picker-sheet">
        <PickerPresentation.Provider value="sheet">
          <div className="picker-content">{children}</div>
        </PickerPresentation.Provider>
      </Sheet>
    );
  }

  return (
    <Popover anchor={anchor} onClose={onClose} width={width}>
      <PopoverTitle>{title}</PopoverTitle>
      <PickerPresentation.Provider value="menu">
        <div className="picker-content">{children}</div>
      </PickerPresentation.Provider>
    </Popover>
  );
}

/** Shared flat row used in anchored menus and phone sheets. */
export function PickerRow({
  title,
  subtitle,
  leading,
  trailing,
  selected = false,
  className = '',
  selection = true,
  disabled = false,
  onClick,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  className?: string;
  selection?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const presentation = useContext(PickerPresentation);
  return (
    <button
      type="button"
      role={presentation === 'menu' ? (selection ? 'menuitemradio' : 'menuitem') : undefined}
      aria-checked={presentation === 'menu' && selection ? selected : undefined}
      aria-pressed={presentation === 'sheet' && selection ? selected : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={`picker-row ${selected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
      onClick={onClick}
    >
      {leading ? <span className="picker-row-leading">{leading}</span> : null}
      <span className="picker-row-copy">
        <span className="picker-row-title">{title}</span>
        {subtitle ? <span className="picker-row-subtitle">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="picker-row-trailing">{trailing}</span> : null}
    </button>
  );
}

export function PickerGroup({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`picker-group ${className}`}>
      {title ? <div className="picker-group-title">{title}</div> : null}
      {children}
    </div>
  );
}
