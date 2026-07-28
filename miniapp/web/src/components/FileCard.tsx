import { useState } from 'react';
import { Check, CopyIcon } from './Icons';
import type { FileEdit } from '../types';

/**
 * The diff card behind a `Writing …` / `Edited …` row.
 *
 * This replaces the generic tool card for file writes, which used to show
 * the absolute path and the daemon's "Successfully wrote …" line -- true,
 * and useless. What a reader wants is the content: numbered lines, added
 * ones tinted green and removed ones red, exactly as the desktop app draws
 * it.
 *
 * Markdown gets a light syntactic tint (headings, bold, emphasis, links,
 * inline code) by regex rather than by pulling in a highlighter: almost
 * every artifact these sessions write is a .md file, and a whole
 * tokenizer's worth of dependency for four accents is not a trade worth
 * making on a phone.
 */
export function FileCard({ file }: { file: FileEdit }) {
  const markdown = /\.(md|markdown)$/i.test(file.name);
  const added = file.lines.filter((line) => line.kind === 'add').length;
  const removed = file.lines.filter((line) => line.kind === 'del').length;

  return (
    <div className="file-card">
      <div className="file-card-head">
        <span className="file-card-name">{file.name}</span>
        <span className="diffstat">
          <span className="added">+{added}</span>{' '}
          <span className="removed">-{removed}</span>
        </span>
        <CopyButton text={file.lines.map((line) => line.text).join('\n')} />
      </div>
      <div className="file-card-body">
        {file.lines.map((line, index) => (
          <div key={index} className={`file-line is-${line.kind}`}>
            <span className="file-line-n">{line.n ?? ''}</span>
            <span className="file-line-text">
              {markdown ? tintMarkdown(line.text) : line.text}
            </span>
          </div>
        ))}
      </div>
      {file.truncated ? (
        <p className="tool-note">Only the first {file.lines.length} lines are shown.</p>
      ) : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button file-card-copy"
      aria-label="Copy file contents"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={14} strokeWidth={2} /> : <CopyIcon size={14} strokeWidth={1.75} />}
    </button>
  );
}

/** Ordered so the earliest match wins on any one character run. */
const MARKDOWN_TINTS: Array<[RegExp, string]> = [
  [/^(\s{0,3}#{1,6}\s.*)$/, 'md-heading'],
  [/(\*\*[^*]+\*\*)/, 'md-strong'],
  [/(`[^`]+`)/, 'md-code'],
  [/(_[^_]+_)/, 'md-em'],
  [/(\[[^\]]+\]\([^)]+\))/, 'md-link'],
];

/**
 * Split one line into tinted and plain spans.
 *
 * Deliberately single-pass and non-nesting: this is decoration, and a
 * "correct" recursive parse would be both slower and no more readable at
 * 12px.
 */
export function tintMarkdown(text: string): React.ReactNode {
  for (const [pattern, className] of MARKDOWN_TINTS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const start = match.index;
    const end = start + match[1].length;
    return (
      <>
        {text.slice(0, start)}
        <span className={className}>{match[1]}</span>
        {tintMarkdown(text.slice(end))}
      </>
    );
  }
  return text;
}
