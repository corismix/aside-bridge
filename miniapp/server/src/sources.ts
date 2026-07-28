/**
 * The citation source catalog for a session.
 *
 * Assistant text carries `<citation refs="<source_id>">…</citation>` tags,
 * and the ids in them are only meaningful against the search results the
 * same session produced. Every `websearch` / `webfetch` toolResult writes
 * its catalog into `details.sources` as `{id, url, title, excerpt}`, so one
 * pass over the transcript resolves every ref the answers can name.
 *
 * Refs that resolve to nothing are not an error -- some models emit local
 * markers like `refs="s1"` -- and the client renders those as plain text
 * with no affordance rather than showing the raw tag.
 */
import type { FacadeMessage } from './facade.js';
import type { HistoryMessage } from './jsonl.js';

export interface CitationSource {
  id: string;
  url: string;
  title: string;
  /** Host, for the compact line under the title. */
  domain: string;
  /** Trimmed supporting passage, shown in the sources sheet. */
  excerpt: string;
}

/** Excerpts run to several KB each; the sheet shows a passage, not a page. */
const EXCERPT_LIMIT = 400;

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Collect every source the session has seen, newest definition winning.
 *
 * Keyed by source id, which is what a citation ref names.
 */
export function collectSources(
  messages: Array<FacadeMessage | HistoryMessage>,
): Record<string, CitationSource> {
  const out: Record<string, CitationSource> = {};

  for (const msg of messages) {
    if (msg.role !== 'toolResult') continue;
    const sources = (msg.details as { sources?: unknown } | undefined)?.sources;
    if (!Array.isArray(sources)) continue;

    for (const raw of sources) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = String(row.id ?? '').trim();
      if (!id) continue;
      const url = String(row.url ?? '').trim();
      out[id] = {
        id,
        url,
        title: String(row.title ?? '').trim() || url || id,
        domain: domainOf(url),
        excerpt: String(row.excerpt ?? '')
          .trim()
          .slice(0, EXCERPT_LIMIT),
      };
    }
  }

  return out;
}
