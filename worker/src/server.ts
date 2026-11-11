import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { INTERVALS } from "../../src/lib/market/candles.ts";
import { config } from "./config.ts";
import { solUsd, solUsdFresh } from "./solusd.ts";
import type { Market, Store } from "./store.ts";
import { history } from "./history/service.ts";

const PUMP_INITIAL_VIRTUAL_SOL = 30;

export function summary(store: Store, m: Market) {
  const st = store.stats(m.id);
  return {
    id: m.id, chain: m.chain, kind: m.kind, address: m.address, mint: m.mint, venue: m.venue, quoteCcy: m.quoteCcy,
    name: m.name, symbol: m.symbol, imageUri: m.imageUri, launchedAt: m.launchedAt, status: m.status, stage: m.stage,
    curveProgress: m.curveProgress, priceQuote: m.priceQuote, reserveQuote: m.reserveQuote, reserveBase: m.reserveBase,
    totalSupply: m.totalSupply, circulatingSupply: m.circulatingSupply,
    liquidityQuote: m.kind === "curve" && m.reserveQuote != null ? Math.max(0, m.reserveQuote - PUMP_INITIAL_VIRTUAL_SOL) : null,
    liquidityUsd: m.liquidityUsd, liquidityAt: m.liquidityAt, tradeFeed: m.tradeFeed, quoteModel: m.quoteModel,
    stateUpdatedAt: m.stateUpdatedAt, migratedTo: m.migratedTo, migratedFrom: m.migratedFrom, lastTradeAt: m.lastTradeAt,
    stats: st,
  };
}

export function reference() {
  return { "SOL/USD": { price: solUsd.price, updatedAt: solUsd.updatedAt || null, source: solUsd.source, fresh: solUsdFresh() } };
}

type Client = { ws: WebSocket; topics: Set<string>; pending: Map<string, unknown>; trades: unknown[] };

export function startServer(store: Store, statusFn: () => Record<string, unknown>, onViewing: (ids: Set<string>) => void) {
  const cors = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && (config.allowedOrigins.includes(origin) || config.allowedOrigins.includes("*"))) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
  };
  const json = (req: http.IncomingMessage, res: http.ServerResponse, code: number, body: unknown) => {
    cors(req, res);
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const p = u.pathname;
    if (p === "/health") return json(req, res, 200, { ok: true, t: Date.now() });
    if (p === "/status") return json(req, res, 200, statusFn());
    if (p === "/api/snapshot") {
      const list = [...store.markets.values()].sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 600).map((m) => summary(store, m));
      return json(req, res, 200, { seq: store.seq, reference: reference(), markets: list });
    }
    if (p === "/api/search") {
      const q = (u.searchParams.get("q") ?? "").trim().toLowerCase();
      const list = [...store.markets.values()].filter((m) => !q || m.mint.toLowerCase() === q || m.address.toLowerCase() === q ||
        (m.symbol ?? "").toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)).slice(0, 200).map((m) => summary(store, m));
      return json(req, res, 200, { seq: store.seq, reference: reference(), markets: list });
    }
    const mm = p.match(/^\/api\/markets\/(.+)$/);
    if (mm) {
      const m = store.markets.get(decodeURIComponent(mm[1]));
      if (!m) return json(req, res, 404, { error: "market not tracked by this worker" });
      const siblings = (store.byMint.get(m.mint) ?? []).map((i) => store.markets.get(i)).filter(Boolean).map((x) => summary(store, x!));
      return json(req, res, 200, { seq: store.seq, reference: reference(), market: summary(store, m), siblings, tape: store.tapes.get(m.id) ?? [] });
    }
    if (p === "/api/candles") {
      const id = u.searchParams.get("market") ?? "";
      const tf = u.searchParams.get("tf") ?? "1m";
      const sec = INTERVALS[tf];
      if (!sec) return json(req, res, 400, { error: "unsupported timeframe" });
      const cb = store.candles.get(id);
      const m = store.markets.get(id);
      return json(req, res, 200, {
        market: id, tf, quoteCcy: m?.quoteCcy ?? null, candles: cb ? cb.candles(sec) : [],
        historyFrom: m ? Math.floor(m.launchedAt / 1000) : null,
        note: "Built only from swaps observed live by this worker since it started tracking the market. Earlier history is not shown.",
      });
    }
    if (p === "/api/history") {
      // Read-only chart history from public Solana RPC; never used for quotes or paper execution.
      const id = u.searchParams.get("market") ?? "";
      const tf = u.searchParams.get("tf") ?? "1m";
      const sec = INTERVALS[tf];
      if (!sec) return json(req, res, 400, { error: "unsupported timeframe" });
      const h = history(store.markets.get(id), id, sec);
      return json(req, res, 200, { market: id, tf, quoteCcy: "SOL", source: "solana-rpc:pump-trade-event", delivery: "polled", ...h });
    }
    json(req, res, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<Client>();
  const viewing = () => {
    const s = new Set<string>();
    for (const c of clients) for (const t of c.topics) if (t.startsWith("market:")) s.add(t.slice(7));
    onViewing(s);
  };

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin) && !config.allowedOrigins.includes("*")) {
      ws.close(1008, "origin not allowed");
      return;
    }
    const c: Client = { ws, topics: new Set(), pending: new Map(), trades: [] };
    clients.add(c);
    ws.send(JSON.stringify({ type: "hello", seq: store.seq, reference: reference() }));
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const topics: string[] = Array.isArray(msg.topics) ? msg.topics.filter((t: unknown) => typeof t === "string").slice(0, 20) : [];
      if (msg.op === "sub") topics.forEach((t) => c.topics.add(t));
      if (msg.op === "unsub") topics.forEach((t) => c.topics.delete(t));
      viewing();
    });
    ws.on("close", () => { clients.delete(c); viewing(); });
  });

  store.on("event", (e: { seq: number; type: string; marketId: string; data: any }) => {
    const m = store.markets.get(e.marketId);
    if (!m) return;
    for (const c of clients) {
      if (c.topics.has("discovery")) c.pending.set(m.id, summary(store, m));
      if (c.topics.has(`market:${m.id}`)) {
        c.pending.set(m.id, summary(store, m));
        if (e.type === "trade") c.trades.push(e.data);
        if (e.type === "migration") c.trades.push({ migration: e.data });
      }
    }
  });

  // Batched fan-out keeps busy feeds cheap for browsers.
  setInterval(() => {
    for (const c of clients) {
      if (c.ws.readyState !== WebSocket.OPEN || (!c.pending.size && !c.trades.length)) continue;
      c.ws.send(JSON.stringify({ type: "batch", seq: store.seq, markets: [...c.pending.values()], trades: c.trades }));
      c.pending.clear();
      c.trades = [];
    }
  }, 300).unref();
  setInterval(() => {
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: "ref", seq: store.seq, reference: reference(), status: statusFn().feed }));
  }, 5000).unref();

  server.listen(config.port, () => console.log(`worker listening on :${config.port}`));
  return { clientCount: () => clients.size };
}
