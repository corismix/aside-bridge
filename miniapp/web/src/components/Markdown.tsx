import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import {
  citationIndexFrom,
  dropPartialCitation,
  transformCitations,
  type CitationMark,
} from '../utils/citations';
import { localImagePath } from '../utils/images';
import { closeOpenFence } from '../utils/markdown';
import type { CitationSource } from '../types';

/**
 * An image inside rendered markdown.
 *
 * A src naming a local absolute path is pointed at the authenticated file
 * route -- see `localImagePath` for why only absolute paths qualify.
 * Anything the route refuses (outside the allowed roots, not an image, too
 * big) or that simply is not there any more collapses to a small caption
 * rather than the browser's broken-image icon, which is what the owner
 * was actually looking at.
 *
 * `loading="lazy"` matters here: these are individual HTTP fetches rather
 * than data URIs inlined in the thread payload, so an answer with a dozen
 * screenshots costs nothing until they scroll into view. The transcript
 * image budgets (per-image, per-step, per-thread) are about payload size
 * and do not apply; the route's own 10 MB cap does.
 */
function MarkdownImage({
  src,
  alt,
  sessionId,
}: {
  src: string;
  alt: string;
  sessionId?: string;
}) {
  const local = localImagePath(src);
  const resolved = local
    ? sessionId
      ? api.localFileUrl(sessionId, local)
      : ''
    : src;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resolved]);

  if (!resolved || failed) {
    return (
      <span className="image-unavailable">
        {alt ? `Image unavailable: ${alt}` : 'Image unavailable'}
      </span>
    );
  }
  return (
    <img
      className="md-image"
      src={resolved}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Assistant text as clean markdown.
 *
 * react-markdown does not render raw HTML unless rehype-raw is added, which
 * it deliberately is not -- transcript text is untrusted enough (tool output,
 * quoted web pages) that giving it HTML would be a mistake. That is also why
 * `<citation>` tags cannot simply be left in place: they arrive as literal
 * text. They are rewritten to `cite:` links first and drawn here as
 * superscript chips.
 *
 * `streaming` renders a buffer that is still arriving: the only guard it
 * needs is a temporary closing code fence, so the tail of a message does not
 * flicker in and out of a code block while it types.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
  sources,
  sessionId,
  onOpenCitation,
}: {
  text: string;
  streaming?: boolean;
  sources?: Record<string, CitationSource>;
  /** Needed to rewrite local image paths onto that session's file route. */
  sessionId?: string;
  onOpenCitation?: (mark: CitationMark) => void;
}) {
  const { markdown, marks } = useMemo(() => {
    const body = streaming
      ? closeOpenFence(dropPartialCitation(text))
      : text;
    return transformCitations(body, (ref) => Boolean(sources?.[ref]));
  }, [text, streaming, sources]);

  const imageRenderer = useMemo(
    () =>
      function MarkdownImageSlot({ src, alt }: { src?: unknown; alt?: unknown }) {
        return (
          <MarkdownImage
            src={typeof src === 'string' ? src : ''}
            alt={typeof alt === 'string' ? alt : ''}
            sessionId={sessionId}
          />
        );
      },
    [sessionId],
  );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown drops any href outside its safe-protocol list, so
        // `cite:` links arrive with an empty href and render as ordinary
        // text. Only our own scheme is let past; everything else still goes
        // through the default sanitiser, which is what blocks `javascript:`.
        // A local absolute path is let past for `src` only. The default
        // transform drops `file:` (not a safe protocol) and would otherwise
        // hand the image renderer an empty src, so the rewrite would never
        // get a chance to run. Scoping it to `src` keeps `file:` links out
        // of `href`, where nothing wants them.
        urlTransform={(url, key) => {
          if (url.startsWith('cite:')) return url;
          if (key === 'src' && localImagePath(url)) return url;
          return defaultUrlTransform(url);
        }}
        components={{
          // Memoised on purpose. react-markdown uses whatever is in this
          // map AS the element type, so an arrow function written inline
          // here is a new type on every render -- which unmounts and
          // remounts every image, losing the "this one failed" state and
          // re-requesting the file each time the streaming answer ticks.
          img: imageRenderer,
          a: ({ node: _node, href, children, ...props }) => {
            const index = citationIndexFrom(String(href || ''));
            if (index === null) {
              return (
                <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }
            const mark = marks[index - 1];
            return (
              <button
                type="button"
                className="cite-chip"
                onClick={() => mark && onOpenCitation?.(mark)}
              >
                {children}
              </button>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
      {streaming ? <span className="caret" aria-hidden /> : null}
    </div>
  );
});
