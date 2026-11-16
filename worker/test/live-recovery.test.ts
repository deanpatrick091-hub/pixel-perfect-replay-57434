import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveLogs } from "../src/history/liveLogs.ts";

function socket() {
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const sent: any[] = [];
  let closes = 0;
  const emit = (event: string, ...args: any[]) => handlers.get(event)?.forEach((f) => f(...args));
  const ws = {
    readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), ping() {},
    close() { closes++; emit("close"); }, terminate() { closes++; emit("close"); },
    on(event: string, handler: (...args: any[]) => void) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  };
  return { ws, emit, sent, closed: () => closes };
}

test("live recovery: healthy quiet sockets stay connected while pongs arrive", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
  const s = socket();
  const live = createLiveLogs({ url: "wss://test", maxSubs: 1, pingMs: 1_000, onHint() {}, connect: () => s.ws });
  try {
    live.setWanted(["CurveA"]); s.emit("open");
    s.emit("message", JSON.stringify({ id: s.sent[0].id, result: 11 }));
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(900); s.emit("pong"); }
    assert.equal(s.closed(), 0, "valid pong responses must refresh the liveness watchdog");
    assert.equal(live.state("CurveA"), "streaming");
  } finally { live.stop(); }
});

test("live recovery: rejected subscriptions are retried with backoff while still wanted", () => {
  let clock = 100_000;
  const s = socket();
  const live = createLiveLogs({ url: "wss://test", maxSubs: 1, pingMs: 1_000_000, now: () => clock, onHint() {}, connect: () => s.ws });
  try {
    live.setWanted(["CurveA"]); s.emit("open");
    s.emit("message", JSON.stringify({ id: s.sent[0].id, error: { code: -32005, message: "temporarily unavailable" } }));
    live.setWanted(["CurveA"]);
    assert.equal(s.sent.filter((x) => x.method === "logsSubscribe").length, 1, "no immediate retry loop");
    clock += 1_001; live.setWanted(["CurveA"]);
    const requests = s.sent.filter((x) => x.method === "logsSubscribe");
    assert.equal(requests.length, 2, "the unchanged wanted set must retry a failed subscription");
    s.emit("message", JSON.stringify({ id: requests[1].id, result: 12 }));
    assert.equal(live.state("CurveA"), "streaming");
  } finally { live.stop(); }
});

test("live recovery: missing subscription acknowledgements do not hang forever", () => {
  let clock = 100_000;
  const s = socket();
  const live = createLiveLogs({ url: "wss://test", maxSubs: 1, pingMs: 1_000_000, now: () => clock, onHint() {}, connect: () => s.ws });
  try {
    live.setWanted(["CurveA"]); s.emit("open");
    clock += 15_001; live.setWanted(["CurveA"]);
    clock += 1_001; live.setWanted(["CurveA"]);
    assert.equal(s.sent.filter((x) => x.method === "logsSubscribe").length, 2, "an unacknowledged request must time out and retry");
  } finally { live.stop(); }
});

test("live recovery: a late acknowledgement for an unwatched market is unsubscribed", () => {
  const s = socket();
  const live = createLiveLogs({ url: "wss://test", maxSubs: 2, pingMs: 1_000_000, onHint() {}, connect: () => s.ws });
  try {
    live.setWanted(["CurveA", "CurveB"]); s.emit("open");
    const oldId = s.sent[0].id;
    live.setWanted(["CurveB"]);
    s.emit("message", JSON.stringify({ id: oldId, result: 99 }));
    assert.ok(s.sent.some((x) => x.method === "logsUnsubscribe" && x.params[0] === 99), "the server-side orphan must not consume a live subscription slot");
  } finally { live.stop(); }
});
