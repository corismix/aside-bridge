/**
 * Aside project icon + colour mapping.
 *
 * `aside.projects.list()` rows carry `icon` and `color` -- the same values
 * the desktop app renders. Icons map onto the lucide family this app
 * already uses; colours map onto the oklch tokens in theme/tokens.css so
 * light and dark themes both stay legible. Unknown values fall back to
 * the neutral folder, exactly like the desktop treats them.
 */
import type { LucideIcon } from 'lucide-react';
import { Terminal } from 'lucide-react';
import {
  BookOpen,
  Folder,
  Heart,
  Palette,
  PenLine,
  Sparkles,
  TriangleAlert,
} from '../components/Icons';

const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  'fountain-pen': PenLine,
  palette: Palette,
  heart: Heart,
  book: BookOpen,
  sparkles: Sparkles,
  warning: TriangleAlert,
  terminal: Terminal,
};

export interface ProjectTint {
  /** Glyph colour, from the theme's own palette tokens. */
  fg: string;
  /** Tinted chip background: the same hue at ~15%. */
  bg: string;
}

const PROJECT_COLORS: Record<string, ProjectTint> = {
  mono: {
    fg: 'var(--color-neutral-700)',
    bg: 'color-mix(in oklch, var(--color-neutral-400) 18%, transparent)',
  },
  red: {
    fg: 'var(--color-red-500)',
    bg: 'color-mix(in oklch, var(--color-red-500) 15%, transparent)',
  },
  pink: {
    fg: 'var(--color-pink-500)',
    bg: 'color-mix(in oklch, var(--color-pink-500) 15%, transparent)',
  },
  sky: {
    fg: 'var(--color-sky-500)',
    bg: 'color-mix(in oklch, var(--color-sky-500) 15%, transparent)',
  },
  emerald: {
    fg: 'var(--color-emerald-500)',
    bg: 'color-mix(in oklch, var(--color-emerald-500) 15%, transparent)',
  },
  yellow: {
    fg: 'var(--color-amber-500)',
    bg: 'color-mix(in oklch, var(--color-amber-500) 18%, transparent)',
  },
  lime: {
    fg: 'var(--color-green-500)',
    bg: 'color-mix(in oklch, var(--color-green-500) 15%, transparent)',
  },
};

const MONO_TINT = PROJECT_COLORS.mono;

export function projectIcon(icon?: string): LucideIcon {
  return (icon && PROJECT_ICONS[icon]) || Folder;
}

export function projectTint(color?: string): ProjectTint {
  return (color && PROJECT_COLORS[color]) || MONO_TINT;
}
