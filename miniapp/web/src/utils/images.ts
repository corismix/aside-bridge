/**
 * Telling a local filesystem path in an answer apart from a real URL.
 *
 * The agent writes markdown for a reader sitting at the machine it runs
 * on, so `![shot](/Users/…/artifacts/2026-07-26/shot.png)` is a perfectly
 * good image reference from where it stands. In a phone webview it is a
 * broken-image icon: there is no filesystem to fetch from. Those srcs are
 * rewritten onto the authenticated `/api/sessions/:id/file` route; every
 * other src -- `https:`, `data:`, `blob:` -- is left exactly as written.
 *
 * A relative path is deliberately NOT treated as local. It would resolve
 * against the SPA's own origin, and guessing a base directory for it on
 * the agent's behalf is how a rewrite starts naming files nobody asked
 * for. It stays as-is and renders as unavailable, which is honest.
 */

/** `https:`, `data:`, `blob:`, `cid:` … -- anything with a scheme. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The absolute local path a src names, or null if it is not one.
 *
 * `file://` URLs are accepted because some tools emit them, and are
 * reduced to the plain path they wrap.
 */
export function localImagePath(src: unknown): string | null {
  const value = String(src ?? '').trim();
  // `//host/path` is protocol-relative, not a POSIX absolute path.
  if (!value || value.startsWith('//')) return null;

  let candidate = value;
  if (/^file:\/\//i.test(value)) {
    try {
      candidate = decodeURI(value.replace(/^file:\/\/(localhost)?/i, ''));
    } catch {
      return null;
    }
  } else if (SCHEME.test(value)) {
    return null;
  }

  if (!candidate.startsWith('/') || candidate.includes('\0')) return null;
  return candidate;
}
