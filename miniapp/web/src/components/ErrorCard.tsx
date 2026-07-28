/**
 * A failed turn, drawn as Aside's own alert card.
 *
 * The mini app used to render nothing at all here: a rate-limited turn was
 * a blank response, because the failure lives on an assistant record with
 * `stopReason: "error"` and an EMPTY content array, and a renderer that
 * only reads content sees nothing to draw. The server now classifies it
 * (see `server/src/errors.ts`) and this is the card.
 *
 * The structure is the shipped component's, transcribed: a warning glyph, a
 * medium-weight title, a muted description, a `Details` button on the
 * right, and the raw provider message revealed underneath when it is
 * expanded -- indented to clear the icon, exactly as the desktop app does.
 */
import { useState } from 'react';
import { TriangleAlert } from './Icons';
import type { ErrorAlert } from '../types';

export function ErrorCard({ alert }: { alert: ErrorAlert }) {
  const [open, setOpen] = useState(false);
  // A detail identical to the description would just repeat the sentence
  // above it, so the button is only offered when it reveals something.
  const hasDetail = Boolean(
    alert.detail && alert.detail.trim() !== alert.description.trim(),
  );

  return (
    <div
      className={`alert-card ${alert.tone === 'destructive' ? 'is-destructive' : ''}`}
      role="status"
    >
      <div className="alert-head">
        <span className="alert-icon">
          <TriangleAlert size={15} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="alert-body">
          <p className="alert-title">{alert.title}</p>
          <p className="alert-description">{alert.description}</p>
        </div>
        {hasDetail ? (
          <button
            type="button"
            className="alert-details"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
          >
            Details
          </button>
        ) : null}
      </div>
      {open && hasDetail ? <p className="alert-detail">{alert.detail}</p> : null}
    </div>
  );
}
