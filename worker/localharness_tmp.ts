import { Store, type Market } from "./src/store.ts";
import { startServer } from "./src/server.ts";
import { historyStats } from "./src/history/index.ts";
const store = new Store();
const ms: any[] = JSON.parse(process.env.SEED!);
for (const s of ms) {
  const m = { ...s, stateSource: "seed", launchSignature: null } as Market;
  store.markets.set(m.id, m);
  store.byMint.set(m.mint, [...(store.byMint.get(m.mint) ?? []), m.id]);
}
startServer(store, () => ({ chartHistory: historyStats(), feed: {} }), () => {});
