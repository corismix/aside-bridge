import { useEffect, useState } from 'react';
import { AsideMark } from './Icons';
import { formatTokens } from '../utils/format';

/**
 * `⊘ 15s · ↓ 506 tokens`, under the message area while a turn is running.
 *
 * This is where "the agent is working" now lives -- the ring next to the
 * model pill is a context meter, not a spinner. The clock ticks locally
 * from the turn's start; the token count is the real usage of every
 * assistant message completed this turn, plus a rough estimate of whatever
 * is still streaming, which snaps to the true figure as each message lands.
 */
export function StreamFooter({
  startedAt,
  tokens,
}: {
  startedAt: number;
  tokens: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));

  return (
    <div className="stream-footer">
      <AsideMark size={13} />
      <span>{seconds}s</span>
      <span className="stream-footer-dot">·</span>
      <span>↓ {formatTokens(tokens)} tokens</span>
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
