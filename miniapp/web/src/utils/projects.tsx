import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Atom, Banknote, Bell, BookOpen, Bookmark, Brush, Camera, ChartColumn, Flame,
  Circle, Cloud, Contrast, Diamond, Flag, Flower, Folder, GitBranch, Glasses, Heart,
  Headphones, Hourglass, Image, Info, Languages, LockKeyhole, Luggage, Mail,
  MapPin, Megaphone, MessageCircle, Moon, MousePointer2, Music2, NotebookPen,
  Paperclip, Palette, Pencil, Pentagon, PieChart, Pin, Presentation, Repeat,
  Rocket, Scissors, Send, ShoppingBag, Smile, Sparkles, Square, Sun,
  Table, Tag, Telescope, Terminal, ThumbsUp, Ticket, TriangleAlert, Trophy,
  WandSparkles, Zap,
} from 'lucide-react';
import type { AsideProject } from '../types';
import { AsideSymbol, ProviderMark } from '../components/Brand';

const PROJECT_ICONS: Record<string, LucideIcon> = {
  attachment: Paperclip,
  bookmark: Bookmark,
  bubble: MessageCircle,
  terminal: Terminal,
  'magic-book': BookOpen,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  lightning: Zap,
  heart: Heart,
  fire: Flame,
  slime: Sparkles,
  stars: Sparkles,
  'magic-wand': WandSparkles,
  'thumbs-up': ThumbsUp,
  diamond: Diamond,
  book: BookOpen,
  skill: BookOpen,
  hourglass: Hourglass,
  clock: Hourglass,
  smile: Smile,
  lock: LockKeyhole,
  'marker-pin': MapPin,
  pin: Pin,
  tag: Tag,
  flag: Flag,
  'shopping-bag': ShoppingBag,
  luggage: Luggage,
  'bank-note': Banknote,
  telescope: Telescope,
  trophy: Trophy,
  rocket: Rocket,
  ticket: Ticket,
  camera: Camera,
  folder: Folder,
  'fountain-pen': Pencil,
  brush: Brush,
  palette: Palette,
  contrast: Contrast,
  bell: Bell,
  mail: Mail,
  info: Info,
  warning: TriangleAlert,
  'form-circle': Circle,
  'form-square': Square,
  'form-diamond': Diamond,
  'form-pentagon': Pentagon,
  'form-flower': Flower,
  announcement: Megaphone,
  cursor: MousePointer2,
  annotation: MessageCircle,
  glasses: Glasses,
  send: Send,
  'presentation-chart': Presentation,
  'pie-chart': PieChart,
  'bar-chart': ChartColumn,
  sparkles: Sparkles,
  image: Image,
  atom: Atom,
  note: NotebookPen,
  scissors: Scissors,
  headphone: Headphones,
  'musical-note': Music2,
  repeat: Repeat,
  table: Table,
  summary: NotebookPen,
  translate: Languages,
  github: GitBranch,
};

const PROJECT_COLORS: Record<string, string> = {
  mono: 'var(--project-mono)',
  red: 'var(--project-red)',
  orange: 'var(--project-orange)',
  amber: 'var(--project-amber)',
  yellow: 'var(--project-yellow)',
  lime: 'var(--project-lime)',
  green: 'var(--project-green)',
  emerald: 'var(--project-emerald)',
  cyan: 'var(--project-cyan)',
  sky: 'var(--project-sky)',
  blue: 'var(--project-blue)',
  indigo: 'var(--project-indigo)',
  violet: 'var(--project-violet)',
  fuchsia: 'var(--project-fuchsia)',
  pink: 'var(--project-pink)',
  slate: 'var(--project-slate)',
};

export function projectIcon(icon?: string): LucideIcon {
  return (icon && PROJECT_ICONS[icon]) || Folder;
}

export function projectTint(color?: string): string {
  return (color && PROJECT_COLORS[color]) || 'var(--project-mono)';
}

/** Aside project icons include six provider marks as well as Lucide glyphs. */
export function ProjectGlyph({
  icon,
  color,
  size = 17,
}: {
  icon?: string;
  color?: string;
  size?: number;
}) {
  const style: CSSProperties = { color: projectTint(color) };
  if (icon === 'aside') return <span style={style}><AsideSymbol size={size} /></span>;
  if (icon === 'openai') return <span style={style}><ProviderMark id="openai" size={size} /></span>;
  if (icon === 'codex') return <span style={style}><ProviderMark id="openai-codex" size={size} /></span>;
  if (icon === 'claude') return <span style={style}><ProviderMark id="claude-code" size={size} /></span>;
  if (icon === 'google') return <span style={style}><ProviderMark id="google" size={size} /></span>;
  const Icon = projectIcon(icon);
  return <Icon size={size} strokeWidth={1.75} style={style} aria-hidden />;
}

export function ProjectGlyphForProject({
  project,
  size = 17,
}: {
  project: Pick<AsideProject, 'icon' | 'color'>;
  size?: number;
}) {
  return <ProjectGlyph icon={project.icon} color={project.color} size={size} />;
}
