// Destination pool choice after a verified migration. DEX Screener also lists the bonding curve itself as a
// "pumpfun" pair whose address is the curve, which must never become a pool market (it collides on chain+address).
export interface DexPairLike { chainId?: string; dexId?: string; pairAddress: string; baseToken?: { address?: string }; quoteToken?: { symbol?: string }; liquidity?: { usd?: number } }

export function pickDestination<P extends DexPairLike>(pairs: P[], curve: { mint: string; address: string }, addressTaken: (a: string) => boolean): P | undefined {
  return pairs
    .filter((x) => x.chainId === "solana" && x.baseToken?.address === curve.mint && !!x.quoteToken?.symbol?.toUpperCase().includes("SOL")
      && x.dexId !== "pumpfun" && x.pairAddress !== curve.address && !addressTaken(x.pairAddress))
    .sort((a, b) => (a.dexId === "pumpswap" ? -1 : 0) - (b.dexId === "pumpswap" ? -1 : 0) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}
