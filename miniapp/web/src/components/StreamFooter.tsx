import { useEffect, useState } from 'react';
import { AsideSymbol } from './Icons';
import { formatTokens } from '../utils/format';

/**
 * `◈ 15s · ↓ 506 tokens`, under the message area while a turn is running.
 *
 * This is where "the agent is working" lives -- the ring next to the model
 * pill is a context meter, not a spinner. The clock ticks locally from the
 * turn's start; the token count is the real usage of every assistant
 * message completed this turn, plus a rough estimate of whatever is still
 * streaming, which snaps to the true figure as each message lands.
 *
 * Two things about WHEN it renders, both of which were wrong before:
 *
 *  - It appears the moment the turn starts, at `0s`, not when the first
 *    token arrives. The server now dates a turn from its USER message
 *    rather than from the first assistant record (see `threadStats`), which
 *    on a slow model is tens of seconds earlier -- and until then there was
 *    no start time at all, so the footer simply did not render. That is the
 *    whole "appears late or never" report.
 *  - `startedAt` is optional. A turn this client just started has no
 *    transcript timestamp for a moment; rather than hiding, the footer
 *    falls back to its own mount time, so the clock starts at 0 and is
 *    corrected the instant the real figure arrives.
 *
 * The token count shows as soon as it is known and reads `—` before that,
 * because claiming `0 tokens` during a turn that is plainly producing them
 * is a worse lie than admitting we do not know yet.
 */
export function StreamFooter({
  startedAt,
  tokens,
}: {
  /** Turn start in epoch ms; falls back to mount time when unknown. */
  startedAt: number | null;
  tokens: number;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const from = startedAt && startedAt > 0 ? startedAt : mountedAt;
  const seconds = Math.max(0, Math.round((now - from) / 1000));

  return (
    <div className="stream-footer">
      <AsideSymbol size={13} />
      <span>{seconds}s</span>
      <span className="stream-footer-dot">·</span>
      <span>↓ {tokens > 0 ? `${formatTokens(tokens)} tokens` : '—'}</span>
    </div>
  );
}

/**
 * Tokens for the currently streaming text, before its usage is reported.
 *
 * Four characters per token is the standard rough ratio; it only has to
 * keep the counter moving until the real number arrives.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
