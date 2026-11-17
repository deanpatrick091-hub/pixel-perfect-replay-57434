// Browser-initiated wake of a sleeping free-tier market host (e.g. Render spins idle services down).
// Only the authenticated heartbeat's public_url is contacted, only while the page is visible, with a
// bounded number of attempts. A host is "ready" only when /health answers 2xx JSON { ok: true };
// Render's "waking up" HTML page or a 503 is never treated as healthy.

export type WakeState = "idle" | "waking" | "ready" | "failed";

/** Accepts only plain public http(s) origins: https always, http only for localhost outside production. */
export function safeServiceUrl(raw: string | null | undefined, opts: { allowLocalHttp: boolean }): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "https:") { /* ok */ }
  else if (u.protocol === "http:" && local && opts.allowLocalHttp) { /* dev only */ }
  else return null;
  if (u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

export interface WakeDeps {
  fetch: typeof fetch;
  isVisible: () => boolean;
  timeoutMs?: number;
  /** Delay before each retry after a failed attempt; its length bounds the attempts. */
  delaysMs?: number[];
}

export const DEFAULT_WAKE_DELAYS = [3_000, 5_000, 8_000, 12_000, 15_000];

export class ServiceWaker {
  state: WakeState = "idle";
  url: string | null = null;
  attempts = 0;
  lastError: string | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctl: AbortController | null = null;
  private inflight = false;
  constructor(private deps: WakeDeps, private onChange: () => void) {}

  get maxAttempts() { return (this.deps.delaysMs ?? DEFAULT_WAKE_DELAYS).length + 1; }

  /** Start (or keep) waking `url`. Deduped: a second call for the same URL while waking/ready/failed is a no-op. */
  wake(url: string) {
    if (this.url === url && this.state !== "idle") return;
    this.cancel();
    this.url = url; this.state = "waking"; this.attempts = 0; this.lastError = null;
    this.onChange();
    this.attempt(this.gen);
  }

  /** Stop pending work (URL change, socket connected, page hidden). Late responses are ignored. */
  cancel() {
    this.gen++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.ctl?.abort(); this.ctl = null; this.inflight = false;
    this.state = "idle"; this.url = null; this.attempts = 0;
  }

  private async attempt(gen: number) {
    if (gen !== this.gen || this.inflight || !this.url) return;
    if (!this.deps.isVisible()) { this.cancel(); this.onChange(); return; }
    this.inflight = true; this.attempts++;
    const ctl = new AbortController(); this.ctl = ctl;
    const t = setTimeout(() => ctl.abort(), this.deps.timeoutMs ?? 20_000);
    let ok = false; let err = "no response";
    try {
      const r = await this.deps.fetch(`${this.url}/health`, { signal: ctl.signal, cache: "no-store", credentials: "omit" });
      if (!r.ok) err = `HTTP ${r.status}`;
      else if (!(r.headers.get("content-type") ?? "").includes("application/json")) err = "host still starting (not JSON)";
      else { const j = await r.json().catch(() => null); ok = j?.ok === true; if (!ok) err = "unexpected health reply"; }
    } catch (e) { err = ctl.signal.aborted ? "timed out" : "network error"; }
    finally { clearTimeout(t); }
    if (gen !== this.gen) return; // superseded
    this.inflight = false; this.ctl = null;
    if (ok) { this.state = "ready"; this.lastError = null; this.onChange(); return; }
    this.lastError = err;
    const delays = this.deps.delaysMs ?? DEFAULT_WAKE_DELAYS;
    if (this.attempts > delays.length) { this.state = "failed"; this.onChange(); return; }
    this.onChange();
    this.timer = setTimeout(() => { this.timer = null; void this.attempt(gen); }, delays[this.attempts - 1]);
  }
}
