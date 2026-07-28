import { Sheet } from './Sheet';
import { ArrowUpRight } from './Icons';
import { openExternal } from '../telegram';
import type { CitationMark } from '../utils/citations';
import type { CitationSource } from '../types';

/**
 * The sheet behind a citation chip.
 *
 * One row per source the tag named, each opening the page it came from.
 * The quoted passage, when the tag carried one, sits above the list --
 * that is the sentence the answer is standing behind.
 */
export function CitationSheet({
  mark,
  sources,
  onClose,
}: {
  mark: CitationMark;
  sources: Record<string, CitationSource>;
  onClose: () => void;
}) {
  const resolved = mark.refs
    .map((ref) => sources[ref])
    .filter((source): source is CitationSource => Boolean(source));

  return (
    <Sheet
      side="bottom"
      title={resolved.length === 1 ? 'Source' : 'Sources'}
      onClose={onClose}
    >
      {mark.quote ? <blockquote className="cite-quote">{mark.quote}</blockquote> : null}
      <ul className="cite-list">
        {resolved.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className="cite-source"
              onClick={() => openExternal(source.url)}
            >
              <span className="cite-source-title">{source.title}</span>
              <span className="cite-source-domain">
                {source.domain}
                <ArrowUpRight size={12} strokeWidth={1.75} />
              </span>
              {source.excerpt ? (
                <span className="cite-source-excerpt">{source.excerpt}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
