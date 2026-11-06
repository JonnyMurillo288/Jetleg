/**
 * A length of time, as short as it can be said: `42 sec`, `12 min`, `1 h 05 min`.
 *
 * Spelled out rather than `12m`: these sit beside distances, and in metric
 * "12m" is twelve metres.
 */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** A share of something, as a whole percentage that never rounds a little to nothing. */
export function formatShare(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  if (share > 0.99 && share < 1) return '99%';
  return `${Math.round(share * 100)}%`;
}

/** Time left on something measured in days: `2 d 4 h`, `5 h 12 min`, `12 min`. */
export function formatTimeLeft(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}
