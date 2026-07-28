/**
 * Citations, as Aside's transcripts carry them.
 *
 * Assistant text embeds `<citation refs="<id>[,<id>]">supporting text
 * </citation>`, sometimes with the supporting text wrapped in `<quote>`.
 * Rendered naively, the reader sees the raw tag -- which is exactly what
 * the mini app was doing.
 *
 * The transform here rewrites each tag into ordinary markdown plus a link
 * with a private `cite:` scheme, which the markdown renderer draws as a
 * tappable superscript chip. Doing it as a link rather than as a custom
 * remark plugin keeps inline formatting inside the quoted span working and
 * keeps this file testable on its own.
 *
 * Two rules that matter:
 *
 *  - A ref that resolves to no known source gets NO chip. Some models emit
 *    local markers (`refs="s1"`); a chip that opens an empty sheet is worse
 *    than plain prose.
 *  - A trailing, still-incomplete tag is dropped rather than shown. During
 *    streaming the buffer routinely ends mid-`<citation`, and flashing the
 *    raw markup for one frame is the bug this feature exists to fix.
 */

export interface CitationMark {
  /** 1-based, matching the superscript the reader taps. */
  index: number;
  /** Source ids in the tag that we could resolve. */
  refs: string[];
  /** The `<quote>` body, when the tag carried one. */
  quote: string;
}

export interface CitationResult {
  /** Markdown with the tags replaced by text plus `cite:` links. */
  markdown: string;
  /** One entry per rendered chip, indexed by the chip's number. */
  marks: CitationMark[];
}

const CITATION_RE = /<citation\s+refs="([^"]*)"\s*>([\s\S]*?)<\/citation>/g;
const QUOTE_RE = /<quote>([\s\S]*?)<\/quote>/g;

const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/** `12` -> `¹²`, so the chip stays one line tall at any count. */
export function superscript(n: number): string {
  return String(n)
    .split('')
    .map((digit) => SUPERSCRIPTS[Number(digit)] ?? digit)
    .join('');
}

/** The href a chip carries; parsed back out by the renderer. */
export function citationHref(index: number): string {
  return `cite:${index}`;
}

export function citationIndexFrom(href: string): number | null {
  const match = /^cite:(\d+)$/.exec(href);
  return match ? Number(match[1]) : null;
}

/**
 * Rewrite every citation tag in `text`.
 *
 * `isKnown` decides whether a ref resolves; callers pass a lookup over the
 * session's collected search sources.
 */
export function transformCitations(
  text: string,
  isKnown: (ref: string) => boolean,
): CitationResult {
  const marks: CitationMark[] = [];

  const markdown = String(text || '').replace(
    CITATION_RE,
    (_match, rawRefs: string, body: string) => {
      const refs = rawRefs
        .split(',')
        .map((ref) => ref.trim())
        .filter((ref) => ref && isKnown(ref));

      // `<quote>` marks the passage the source actually said; the sheet
      // shows it, and the prose keeps whatever sat outside it.
      const quotes: string[] = [];
      const inline = body
        .replace(QUOTE_RE, (_q, quoted: string) => {
          quotes.push(quoted.trim());
          return '';
        })
        .trim();

      if (!refs.length) return inline;

      marks.push({ index: marks.length + 1, refs, quote: quotes.join(' ') });
      const chip = `[${superscript(marks.length)}](${citationHref(marks.length)})`;
      return inline ? `${inline}${chip}` : chip;
    },
  );

  return { markdown, marks };
}

/**
 * Drop a citation tag that has not finished arriving.
 *
 * Only applied to a streaming buffer: on completed text an unmatched tag is
 * genuinely malformed, and cutting the rest of the message off to hide it
 * would lose real content.
 */
export function dropPartialCitation(text: string): string {
  const open = text.lastIndexOf('<');
  if (open === -1) return text;
  const tail = text.slice(open);
  // A whole opening tag with no closer after it: the body is still coming.
  if (tail.startsWith('<citation')) {
    return tail.includes('</citation>') ? text : text.slice(0, open);
  }
  // Fewer characters than the tag name, but everything so far matches it --
  // `<cit` is one delta away from being a tag and must not flash on screen.
  return '<citation'.startsWith(tail) ? text.slice(0, open) : text;
}
