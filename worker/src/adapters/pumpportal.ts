import WebSocket from "ws";
import { config, tradeSubsEnabled } from "../config.ts";
import { log } from "../log.ts";
import { pumpCurveProgress, PUMP_CURVE } from "../../../src/lib/market/quote.ts";
import type { AdapterHandlers, MarketAdapter } from "./types.ts";

// PumpPortal data API: one upstream socket. Launch + migration streams work without a key;
// subscribeTokenTrade is metered and only used when a key (or explicit opt-in) is configured.
const URL_BASE = "wss://pumpportal.fun/api/data";

export class PumpPortalAdapter implements MarketAdapter {
  id = "pumpportal";
  private ws: WebSocket | null = null;
  private h!: AdapterHandlers;
  private subs = new Set<string>();
  private backoff = 1000;
  private s = {
    connected: false, connects: 0, reconnects: 0, lastEventAt: 0 as number, launches: 0,
    migrations: 0, tradeMessages: 0, duplicateOrBad: 0, connectedAt: 0 as number,
  };

  start(h: AdapterHandlers) {
    this.h = h;
    this.connect();
  }

  private connect() {
    const url = config.pumpPortalKey ? `${URL_BASE}?api-key=${encodeURIComponent(config.pumpPortalKey)}` : URL_BASE;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.s.connected = true;
      this.s.connects++;
      this.s.connectedAt = Date.now();
      this.backoff = 1000;
      log("info", "pumpportal connected", { authenticated: !!config.pumpPortalKey });
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      if (this.subs.size && tradeSubsEnabled()) {
        ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [...this.subs] }));
      }
      this.h.onStatus({ connected: true });
    });
    ws.on("message", (raw) => this.handle(raw.toString()));
    ws.on("close", (code) => {
      this.s.connected = false;
      this.h.onStatus({ connected: false, reason: `closed ${code}` });
      this.s.reconnects++;
      const wait = Math.min(this.backoff, 30_000);
      this.backoff *= 2;
      log("warn", "pumpportal disconnected", { code, retryInMs: wait });
      setTimeout(() => this.connect(), wait);
    });
    ws.on("error", (err) => log("error", "pumpportal socket error", { err: String(err) }));
  }

  private handle(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    const now = Date.now();
    this.s.lastEventAt = now;
    if (m.message || m.errors) {
      log("info", "pumpportal notice", { message: m.message ?? m.errors });
      return;
    }
    const tx = m.txType;
    if (tx === "create" && m.mint && m.bondingCurveKey) {
      this.s.launches++;
      const vTok = num(m.vTokensInBondingCurve);
      this.h.onLaunch({
        chain: "solana", venue: "pumpfun", marketKind: "curve", marketAddress: m.bondingCurveKey, mint: m.mint,
        name: m.name ?? null, symbol: m.symbol ?? null, imageUri: m.uri ?? null, quoteCcy: "SOL",
        reserveQuote: num(m.vSolInBondingCurve), reserveBase: vTok,
        totalSupply: PUMP_CURVE.TOTAL_SUPPLY, circulatingSupply: PUMP_CURVE.TOTAL_SUPPLY,
        curveProgress: vTok != null ? pumpCurveProgress(vTok) : null, receivedAt: now, signature: m.signature ?? null,
      });
      // The creator's initial buy is a real swap included in the create transaction.
      if (num(m.initialBuy) && num(m.solAmount) && m.signature) {
        this.h.onSwap({
          chain: "solana", venue: "pumpfun", marketAddress: m.bondingCurveKey, mint: m.mint, signature: m.signature,
          eventIndex: null, side: "buy", baseQty: num(m.initialBuy)!, quoteQty: num(m.solAmount)!, baseDecimals: 6,
          quoteCcy: "SOL", reserveQuoteAfter: num(m.vSolInBondingCurve), reserveBaseAfter: vTok, sourceTs: null,
          receivedAt: now, trader: m.traderPublicKey ?? null,
        });
      }
      return;
    }
    if (tx === "migrate" || (m.mint && m.pool && !tx && m.signature)) {
      this.s.migrations++;
      this.h.onMigration({ chain: "solana", fromVenue: "pumpfun", mint: m.mint, signature: m.signature ?? null, destinationHint: m.pool ?? null, receivedAt: now });
      return;
    }
    if ((tx === "buy" || tx === "sell") && m.mint && m.signature) {
      this.s.tradeMessages++;
      const amm = m.pool && m.pool !== "pump";
      const tokenAmount = num(m.tokenAmount), solAmount = num(m.solAmount);
      if (!tokenAmount || !solAmount) { this.s.duplicateOrBad++; return; }
      this.h.onSwap({
        chain: "solana", venue: amm ? (m.pool === "pump-amm" ? "pumpswap" : String(m.pool)) : "pumpfun",
        marketAddress: amm ? null : m.bondingCurveKey ?? null, mint: m.mint, signature: m.signature, eventIndex: null,
        side: tx, baseQty: tokenAmount, quoteQty: solAmount, baseDecimals: 6, quoteCcy: "SOL",
        reserveQuoteAfter: amm ? null : num(m.vSolInBondingCurve), reserveBaseAfter: amm ? null : num(m.vTokensInBondingCurve),
        sourceTs: typeof m.timestamp === "number" ? m.timestamp : null, receivedAt: now, trader: m.traderPublicKey ?? null,
      });
    }
  }

  subscribeTrades(mints: string[]) {
    const fresh = mints.filter((x) => !this.subs.has(x));
    if (!fresh.length || !tradeSubsEnabled()) return;
    fresh.forEach((x) => this.subs.add(x));
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: fresh }));
  }

  unsubscribeTrades(mints: string[]) {
    const gone = mints.filter((x) => this.subs.delete(x));
    if (gone.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: gone }));
  }

  isSubscribed(mint: string) { return this.subs.has(mint) && tradeSubsEnabled(); }
  get connected() { return this.s.connected; }
  stats() {
    return { ...this.s, activeTradeSubscriptions: this.subs.size, authenticated: !!config.pumpPortalKey, eventLagMs: this.s.lastEventAt ? Date.now() - this.s.lastEventAt : null };
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
