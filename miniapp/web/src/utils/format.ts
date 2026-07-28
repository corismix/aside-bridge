/** Compact number formatting for the streaming footer and the file panel. */

/**
 * Token counts, as Aside prints them: `506`, `1.4k`, `12k`, `285k`.
 *
 * Exact under a thousand, one decimal up to ten thousand, whole thousands
 * above that -- so the footer's last digit never twitches while a long
 * answer streams.
 */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

/** `12 KB`, `1.4 MB` -- file sizes in the session panel. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
