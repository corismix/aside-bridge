/**
 * Iconography.
 *
 * Aside's sidepanel uses one monochrome line-icon family at a small size,
 * always inheriting `currentColor` -- no colour, no emoji. lucide is that
 * same family, so step icons come straight from it.
 *
 * Brand marks are NOT here. They live in `Brand.tsx`, recreated from
 * Aside's own shipped path data -- the approximations that used to sit in
 * this file (a circle-and-slash for Aside, four dots for "some provider")
 * were placeholders and read as placeholders.
 */
import {
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
  TriangleAlert,
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
  Folder,
  PenLine,
  Palette,
  Heart,
  Sparkles,
} from 'lucide-react';
import type { StepIcon } from '../types';

export {
  AsideSymbol,
  ProviderMark,
  hasProviderMark,
} from './Brand';

export {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Plus,
  Search,
  Settings,
  Shield,
  TriangleAlert,
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
  Folder,
  PenLine,
  Palette,
  Heart,
  Sparkles,
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

/**
 * The stop control shown in place of Send while a turn is streaming.
 *
 * A filled rounded square, which is what the desktop composer draws: see
 * the reference screenshot, where a small black rounded-square sits
 * immediately left of the Steer button during a run.
 */
export function StopSquare({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

/**
 * A todo's status circle.
 *
 * Empty ring for pending, a part-drawn green ring for in-progress (the
 * desktop app animates this one), a filled green check for completed, and a
 * dimmed ring for cancelled -- matching the task-list screenshots.
 */
export function TodoCircle({
  status,
  size = 15,
}: {
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  size?: number;
}) {
  if (status === 'completed') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="7" fill="var(--success)" />
        <path
          d="M4.8 8.2 7 10.4l4.2-4.4"
          stroke="var(--background)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg
        className="todo-spin"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <circle cx="8" cy="8" r="6.6" stroke="var(--border)" strokeWidth="1.5" />
        <path
          d="M8 1.4a6.6 6.6 0 0 1 6.6 6.6"
          stroke="var(--success)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6.6"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity={status === 'cancelled' ? 0.3 : 0.55}
      />
    </svg>
  );
}
