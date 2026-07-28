/**
 * Iconography.
 *
 * Aside's sidepanel uses one monochrome line-icon family at a small size,
 * always inheriting `currentColor` -- no colour, no emoji. lucide is that
 * same family, so step icons come straight from it.
 *
 * Provider marks are the exception: those are brand glyphs, drawn here as
 * minimal monochrome shapes rather than pulled from a library.
 */
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  Globe,
  ListTodo,
  Plus,
  Search,
  Settings,
  Shield,
  Terminal,
  Users,
  ArrowUp,
  ArrowUpRight,
  LayoutGrid,
  List as ListIcon,
  ArrowDownUp,
  BookOpen,
  CircleCheck,
  ShieldCheck,
  X,
  File as FileIcon,
  Copy as CopyIcon,
  PanelRight,
  Download,
} from 'lucide-react';
import type { StepIcon } from '../types';

export {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Settings,
  Shield,
  ArrowUp,
  ArrowUpRight,
  LayoutGrid,
  ListIcon,
  ArrowDownUp,
  BookOpen,
  CircleCheck,
  ShieldCheck,
  X,
  FileIcon,
  CopyIcon,
  PanelRight,
  Download,
};

/**
 * The glyph on each row of the Permission popover, matching Aside's:
 * a book for read-only, a shield for guard, a circled check for full
 * access.
 */
export function PermissionGlyph({
  mode,
  size = 15,
}: {
  mode: string;
  size?: number;
}) {
  const props = { size, strokeWidth: 1.75, 'aria-hidden': true } as const;
  if (mode === 'read-only') return <BookOpen {...props} />;
  if (mode === 'full-access') return <CircleCheck {...props} />;
  return <ShieldCheck {...props} />;
}

const STEP_ICONS: Record<StepIcon, typeof Terminal> = {
  terminal: Terminal,
  globe: Globe,
  file: FileText,
  search: Search,
  list: ListTodo,
  agent: Users,
  clock: Clock,
  bell: Bell,
  shield: Shield,
  dot: Circle,
};

export function StepGlyph({
  icon,
  size = 14,
}: {
  icon: StepIcon;
  size?: number;
}) {
  const Glyph = STEP_ICONS[icon] || Circle;
  return <Glyph size={size} strokeWidth={1.75} aria-hidden />;
}

/**
 * The eight-point asterisk Aside puts before the model name.
 *
 * Drawn inline rather than taken from lucide, whose asterisk has six arms
 * -- a difference that is visible at pill size.
 */
export function ModelMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
    </svg>
  );
}

/** The small indeterminate ring the sidepanel shows while a turn runs. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-label="working"
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.25"
      />
      <path
        d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Aside's own mark, used for the "Aside" provider row. */
export function AsideMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M4.2 11.8 11.8 4.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A provider's glyph in the model picker.
 *
 * Kept deliberately simple and monochrome -- these sit at 15px next to the
 * provider name and only need to be distinguishable at a glance.
 */
export function ProviderMark({ id, size = 15 }: { id: string; size?: number }) {
  if (id === 'claude-code') return <ModelMark size={size} />;
  if (id === 'aside') return <AsideMark size={size} />;

  if (id === 'openai-codex') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        aria-hidden
      >
        <path d="M8 2.4a2.6 2.6 0 0 1 4.6 1.7 2.6 2.6 0 0 1 0 4.5 2.6 2.6 0 0 1-4.6 3.4 2.6 2.6 0 0 1-4.6-1.7 2.6 2.6 0 0 1 0-4.5A2.6 2.6 0 0 1 8 2.4Z" />
      </svg>
    );
  }

  if (id === 'xai-grok-oauth') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M3 13 13 3M6.5 13 13 6.5M3 8.5 8.5 3" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="5" cy="5" r="1.5" />
      <circle cx="11" cy="5" r="1.5" />
      <circle cx="5" cy="11" r="1.5" />
      <circle cx="11" cy="11" r="1.5" />
    </svg>
  );
}
