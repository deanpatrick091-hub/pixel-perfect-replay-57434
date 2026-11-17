import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ServiceWaker, safeServiceUrl } from "./wake";

const okJson = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
const renderWaking = () => new Response("<html>SERVICE WAKING UP</html>", { status: 200, headers: { "content-type": "text/html" } });
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

afterEach(() => vi.useRealTimers());

describe("safeServiceUrl", () => {
  it("accepts https only, rejects credentials/query/other schemes", () => {
    const o = { allowLocalHttp: false };
    expect(safeServiceUrl("https://w.onrender.com/", o)).toBe("https://w.onrender.com");
    expect(safeServiceUrl("http://w.onrender.com", o)).toBeNull();
    expect(safeServiceUrl("https://u:p@w.onrender.com", o)).toBeNull();
    expect(safeServiceUrl("https://w.onrender.com?x=1", o)).toBeNull();
    expect(safeServiceUrl("javascript:alert(1)", o)).toBeNull();
    expect(safeServiceUrl("http://localhost:8787", o)).toBeNull();
    expect(safeServiceUrl("http://localhost:8787", { allowLocalHttp: true })).toBe("http://localhost:8787");
  });
});

describe("ServiceWaker", () => {
  let visible = true;
  beforeEach(() => { vi.useFakeTimers(); visible = true; });
  const make = (f: typeof fetch, delays = [1000, 2000]) => new ServiceWaker({ fetch: f, isVisible: () => visible, timeoutMs: 5000, delaysMs: delays }, () => {});

  it("Render's waking HTML and 503 are not healthy; ok JSON is ready", async () => {
    const f = vi.fn().mockResolvedValueOnce(renderWaking()).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(okJson());
    const w = make(f as any);
    w.wake("https://w.example");
    await tick();
    expect(w.state).toBe("waking"); expect(w.lastError).toMatch(/not JSON/);
    await tick(1000); expect(w.lastError).toBe("HTTP 503");
    await tick(2000); expect(w.state).toBe("ready"); expect(f).toHaveBeenCalledTimes(3);
  });

  it("times out a hung request and fails after the bounded attempts", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("abort")))));
    const w = make(f as any);
    w.wake("https://w.example");
    await tick(5000); expect(w.lastError).toBe("timed out");
    await tick(1000 + 5000 + 2000 + 5000);
    expect(w.state).toBe("failed"); expect(f).toHaveBeenCalledTimes(3);
    await tick(60_000); expect(f).toHaveBeenCalledTimes(3);
  });

  it("dedupes concurrent wakes for the same URL", async () => {
    const f = vi.fn(async () => okJson());
    const w = make(f as any);
    w.wake("https://w.example"); w.wake("https://w.example");
    await tick(); expect(f).toHaveBeenCalledTimes(1);
  });

  it("does nothing while hidden and stops retries when the tab hides", async () => {
    const f = vi.fn(async () => renderWaking());
    visible = false;
    const w = make(f as any);
    w.wake("https://w.example"); await tick();
    expect(f).not.toHaveBeenCalled(); expect(w.state).toBe("idle");
    visible = true; w.wake("https://w.example"); await tick(); expect(f).toHaveBeenCalledTimes(1);
    visible = false; await tick(5000); expect(f).toHaveBeenCalledTimes(1); expect(w.state).toBe("idle");
  });

  it("URL change cancels obsolete retries and ignores late responses", async () => {
    let resolveOld!: (r: Response) => void;
    const f = vi.fn((u: string) => u.startsWith("https://old") ? new Promise<Response>((r) => { resolveOld = r; }) : Promise.resolve(renderWaking()));
    const w = make(f as any);
    w.wake("https://old.example"); await tick();
    w.wake("https://new.example"); await tick();
    resolveOld(okJson()); await tick();
    expect(w.url).toBe("https://new.example"); expect(w.state).toBe("waking");
    await tick(10_000);
    expect(f.mock.calls.filter(([u]) => String(u).startsWith("https://old"))).toHaveLength(1);
  });
});
