/** Time formatting for the session list and the work fold. */

/**
 * "13 hours ago" -- spelled out, as the sidepanel's session cards do,
 * rather than the abbreviated "13h ago".
 */
export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');

  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, 'day');

  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * "39m 8s" -- the exact form in the sidepanel's `Worked for …` row, which
 * always keeps the seconds component.
 */
export function workedFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
