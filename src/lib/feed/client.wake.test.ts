import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  readyState = 0; closed = false;
  constructor(public url: string) { FakeWS.all.push(this); }
  send() {}
  close() { this.closed = true; }
}

const URL_ = "https://w.onrender.com";
const hb = (ageMs: number, url = URL_) => ({ data: [{ last_heartbeat_at: new Date(Date.now() - ageMs).toISOString(), status: "ok", public_url: url }], error: null });
const okJson = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

let visibility: "visible" | "hidden" = "visible";
beforeEach(() => {
  vi.useFakeTimers(); FakeWS.all = []; rpc.mockReset(); visibility = "visible";
  vi.stubGlobal("WebSocket", FakeWS as any);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function client() {
  const { FeedClient } = await import("./client");
  return new FeedClient();
}

describe("FeedClient cold-start wake", () => {
  it("stale heartbeat: shows Starting, wakes the host, then is Live only after websocket data", async () => {
    rpc.mockResolvedValue(hb(4 * 3600_000));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("<html>waking</html>", { status: 200, headers: { "content-type": "text/html" } }))
      .mockImplementation(async (u: string) => (u.endsWith("/health") ? okJson() : new Response(JSON.stringify({ markets: [], seq: 0, reference: null }), { headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick();
    expect(c.setupKind).toBe("waking"); expect(c.setupReason).toMatch(/about a minute/);
    expect(FakeWS.all).toHaveLength(0);
    await tick(3000);
    expect(FakeWS.all).toHaveLength(1);
    expect(c.status).toBe("connecting");
    FakeWS.all[0]!.onopen!(); await tick();
    expect(c.status).not.toBe("connected");
    FakeWS.all[0]!.onmessage!({ data: JSON.stringify({ type: "batch", seq: 1, markets: [], trades: [] }) });
    expect(c.status).toBe("connected");
    await tick(15_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("failed wake is reported truthfully and Retry now starts again", async () => {
    rpc.mockResolvedValue(hb(4 * 3600_000));
    const fetchMock = vi.fn(async (_u: string) => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick(200_000);
    expect(c.setupKind).toBe("offline"); expect(c.setupReason).toMatch(/did not respond.*Retry now/);
    const n = fetchMock.mock.calls.length;
    expect(n).toBe(6);
    await tick(60_000); expect(fetchMock.mock.calls.length).toBe(n);
    c.retry(); await tick();
    expect(c.setupKind).toBe("waking"); expect(fetchMock.mock.calls.length).toBe(n + 1);
    expect(FakeWS.all).toHaveLength(0);
  });

  it("hidden tab never contacts the host; becoming visible starts the wake", async () => {
    visibility = "hidden";
    rpc.mockResolvedValue(hb(4 * 3600_000));
    const fetchMock = vi.fn(async () => okJson()); vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick(30_000);
    expect(fetchMock).not.toHaveBeenCalled(); expect(c.setupKind).toBe("offline");
    visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); await tick();
    expect(fetchMock).toHaveBeenCalledWith(`${URL_}/health`, expect.anything());
  });

  it("unsafe heartbeat URL is never contacted", async () => {
    rpc.mockResolvedValue(hb(4 * 3600_000, "http://w.onrender.com"));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick(20_000);
    expect(fetchMock).not.toHaveBeenCalled(); expect(c.setupKind).toBe("no_url");
  });

  it("URL change while waking drops obsolete retries", async () => {
    rpc.mockResolvedValueOnce(hb(4 * 3600_000, "https://old.onrender.com")).mockResolvedValue(hb(4 * 3600_000, "https://new.onrender.com"));
    const fetchMock = vi.fn(async (_u: string) => new Response("", { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick();
    await tick(15_000);
    const oldCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("old")).length;
    await tick(60_000);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("old")).length).toBe(oldCalls);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("new"))).toBe(true);
  });

  it("existing live path: fresh heartbeat connects directly without a wake request", async () => {
    rpc.mockResolvedValue(hb(5_000));
    const fetchMock = vi.fn(async (_u: string) => new Response(JSON.stringify({ markets: [], seq: 0, reference: null }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await client();
    c.start(); await tick();
    expect(FakeWS.all).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/health"))).toBe(false);
    FakeWS.all[0]!.onopen!(); await tick();
    FakeWS.all[0]!.onmessage!({ data: JSON.stringify({ type: "batch", seq: 1, markets: [], trades: [] }) });
    expect(c.status).toBe("connected");
  });

  it("a socket that opens but is closed before any data is not Live and becomes unreachable", async () => {
    rpc.mockResolvedValue(hb(5_000));
    vi.stubGlobal("fetch", vi.fn(async (_u: string) => new Response("{}", { status: 403 })));
    const c = await client();
    c.start(); await tick();
    for (let i = 0; i < 3; i++) {
      const ws = FakeWS.all.at(-1)!;
      ws.onopen!(); await tick();
      expect(c.status).not.toBe("connected");
      ws.onclose!(); await tick(20_000);
    }
    expect(c.setupKind).toBe("unreachable");
  });

  it("late messages from a replaced socket are ignored", async () => {
    rpc.mockResolvedValueOnce(hb(5_000, "https://a.onrender.com")).mockResolvedValue(hb(5_000, "https://b.onrender.com"));
    vi.stubGlobal("fetch", vi.fn(async (_u: string) => new Response("{}", { status: 500 })));
    const c = await client();
    c.start(); await tick();
    const oldWs = FakeWS.all[0]!;
    await tick(15_000);
    expect(FakeWS.all).toHaveLength(2); expect(oldWs.closed).toBe(true);
    oldWs.onopen!(); oldWs.onmessage!({ data: JSON.stringify({ type: "batch", seq: 9, markets: [{ id: "old" }], trades: [] }) });
    expect(c.status).not.toBe("connected"); expect(c.markets.has("old")).toBe(false); expect(c.seq).toBe(0);
  });

  it("malformed or unknown messages never mark Live", async () => {
    rpc.mockResolvedValue(hb(5_000));
    vi.stubGlobal("fetch", vi.fn(async (_u: string) => new Response("{}", { status: 500 })));
    const c = await client();
    c.start(); await tick();
    const ws = FakeWS.all[0]!; ws.onopen!(); await tick();
    for (const data of ["not json", "{}", JSON.stringify({ type: "evil", seq: 1 }), JSON.stringify({ type: "batch", seq: 1 }), JSON.stringify({ type: "hello" })]) ws.onmessage!({ data });
    expect(c.status).not.toBe("connected");
    ws.onmessage!({ data: JSON.stringify({ type: "hello", seq: 3, reference: null }) });
    expect(c.status).toBe("connected");
  });

  it("an older slow heartbeat response cannot restore an old URL", async () => {
    let resolveOld!: (v: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; })).mockResolvedValue(hb(5_000, "https://new.onrender.com"));
    vi.stubGlobal("fetch", vi.fn(async (_u: string) => new Response("{}", { status: 500 })));
    const c = await client();
    c.start(); await tick();
    c.retry(); await tick();
    expect(c.workerUrl).toBe("https://new.onrender.com");
    resolveOld(hb(5_000, "https://old.onrender.com")); await tick();
    expect(c.workerUrl).toBe("https://new.onrender.com");
    expect(FakeWS.all.every((w) => w.url.includes("new"))).toBe(true);
  });

  it("URL removed while a wake health check is in flight: late ok never connects", async () => {
    rpc.mockResolvedValueOnce(hb(4 * 3600_000)).mockResolvedValue({ data: [{ last_heartbeat_at: new Date(Date.now() - 4 * 3600_000).toISOString(), status: "ok", public_url: null }], error: null });
    let resolveHealth!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_u: string) => new Promise<Response>((r) => { resolveHealth = r; })));
    const c = await client();
    c.start(); await tick();
    expect(c.setupKind).toBe("waking");
    await tick(15_000); // periodic discovery sees the URL removed while /health is still pending
    resolveHealth(okJson()); await tick(30_000);
    expect(FakeWS.all).toHaveLength(0); expect(c.setupKind).toBe("no_url");
  });

  it("hiding the tab while waking shows the paused state", async () => {
    rpc.mockResolvedValue(hb(4 * 3600_000));
    vi.stubGlobal("fetch", vi.fn(async (_u: string) => new Response("", { status: 503 })));
    const c = await client();
    c.start(); await tick();
    expect(c.setupKind).toBe("waking");
    visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); await tick();
    expect(c.setupKind).toBe("offline"); expect(c.setupReason).toMatch(/Paused/);
  });
});

describe("FeedClient chart requests across worker URL changes", () => {
  it("history() and candles() drop a reply that arrives after the worker URL changed", async () => {
    const c = await client();
    c.workerUrl = URL_;
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    const h = c.history("M", "1m");
    c.workerUrl = "https://other.onrender.com";
    release(new Response(JSON.stringify({ market: "M", tf: "1m", candles: [] }), { status: 200 }));
    expect(await h).toBeNull();
    c.workerUrl = URL_;
    const k = c.candles("M", "1m");
    c.workerUrl = null;
    release(new Response(JSON.stringify({ candles: [], note: "" }), { status: 200 }));
    expect(await k).toBeNull();
  });

  it("history() with an already-aborted signal sends nothing", async () => {
    const c = await client();
    c.workerUrl = URL_;
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const ac = new AbortController(); ac.abort();
    expect(await c.history("M", "1m", ac.signal)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
