/** Retry-After as delta-seconds or HTTP-date (RFC 9110). Returns ms from `now`, or null when absent/invalid. */
export function parseRetryAfter(v: string | null, now: number): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) { const n = Number(t); return n > 0 ? n * 1000 : null; }
  const d = Date.parse(t);
  return Number.isFinite(d) && d > now ? d - now : null;
}
