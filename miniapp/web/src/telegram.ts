/**
 * Thin wrapper over Telegram's WebApp bridge.
 *
 * Every call is a no-op outside Telegram so the exact same build runs in a
 * plain desktop browser, where initData comes from a `#initData=` hash param
 * produced by scripts/dev-initdata.mjs.
 */

interface WebAppUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: WebAppUser };
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  isExpanded?: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
  disableVerticalSwipes?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  downloadFile?: (params: { url: string; file_name: string }) => void;
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp = (): TelegramWebApp | undefined => window.Telegram?.WebApp;

export const inTelegram = (): boolean => Boolean(webApp()?.initData);

/** Signed launch payload: Telegram first, then the dev hash param. */
export function readInitData(): string | null {
  const fromTelegram = webApp()?.initData;
  if (fromTelegram) return fromTelegram;

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromHash = hash.get('initData');
  if (fromHash) return fromHash;

  const stored = sessionStorage.getItem('miniapp.initData');
  return stored || null;
}

/**
 * Keep the dev payload across reloads, but get it out of the URL bar.
 *
 * `raw` is the whole `#initData=…` fragment, so the value has to be parsed
 * out before it is stored -- stashing the fragment itself would hand the
 * server a string with no `hash=` field on the next read.
 */
export function stashDevInitData(raw: string): void {
  if (inTelegram()) return;

  const value = new URLSearchParams(raw.replace(/^#/, '')).get('initData');
  if (!value) return;

  try {
    sessionStorage.setItem('miniapp.initData', value);
  } catch {
    // private mode: the hash param still works for this load
  }
  history.replaceState(null, '', location.pathname + location.search);
}

export function initTelegram(): void {
  const app = webApp();
  if (!app) return;
  app.ready();
  app.expand();
  app.disableVerticalSwipes?.();
}

export function colorScheme(): 'light' | 'dark' {
  const app = webApp();
  if (app?.colorScheme) return app.colorScheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * Telegram's themeParams override only the page backdrop, so the app still
 * reads as Aside inside a heavily themed client instead of inheriting a
 * stranger's palette wholesale.
 */
export function applyTheme(): 'light' | 'dark' {
  const scheme = colorScheme();
  document.documentElement.dataset.theme = scheme;
  const bg = webApp()?.themeParams?.bg_color;
  if (bg) document.documentElement.style.setProperty('--tg-bg', bg);
  return scheme;
}

export function onThemeChanged(handler: () => void): () => void {
  const app = webApp();
  if (app) {
    app.onEvent('themeChanged', handler);
    return () => app.offEvent('themeChanged', handler);
  }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', handler);
  return () => media?.removeEventListener('change', handler);
}

export const backButton = {
  show(handler: () => void): () => void {
    const button = webApp()?.BackButton;
    if (!button) return () => {};
    button.onClick(handler);
    button.show();
    return () => {
      button.offClick(handler);
      button.hide();
    };
  },
};

/**
 * Open a web page.
 *
 * Inside Telegram this must go through `openLink`: a plain `window.open`
 * from a Mini App webview is either blocked or opens a tab the user cannot
 * get back from. Outside it, `window.open` is the only option.
 */
export function openExternal(url: string): void {
  if (!url) return;
  const app = webApp();
  if (app?.openLink) app.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Hand a file to the client to save.
 *
 * `downloadFile` prompts the user in Telegram's own UI, which is what a
 * binary artifact should do; anywhere else the browser's own download
 * handling takes over.
 */
export function downloadFile(url: string, fileName: string): void {
  const app = webApp();
  if (app?.downloadFile) app.downloadFile({ url, file_name: fileName });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

type Haptic = 'light' | 'medium' | 'soft' | 'success' | 'error' | 'select';

export function haptic(kind: Haptic): void {
  const feedback = webApp()?.HapticFeedback;
  if (!feedback) return;
  if (kind === 'success' || kind === 'error') {
    feedback.notificationOccurred(kind);
  } else if (kind === 'select') {
    feedback.selectionChanged();
  } else {
    feedback.impactOccurred(kind);
  }
}
