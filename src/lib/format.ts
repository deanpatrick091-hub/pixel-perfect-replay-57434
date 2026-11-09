const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Compact price: 0.0000028 → 0.0₅28 */
export function fmtPrice(v: number | null | undefined, prefix = "$"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return `${prefix}0`;
  const a = Math.abs(v);
  if (a >= 1000) return prefix + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return prefix + v.toFixed(a >= 100 ? 2 : 4);
  if (a >= 0.001) return prefix + v.toFixed(6).replace(/0+$/, "");
  const s = a.toFixed(20);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return prefix + v.toExponential(2);
  const zeros = m[1]!.length;
  const digits = m[2]!.replace(/0+$/, "") || "0";
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `${v < 0 ? "-" : ""}${prefix}0.0${sub}${digits}`;
}

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined, prefix = "$"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}${prefix}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${prefix}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${prefix}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${prefix}${a.toFixed(a < 10 ? 2 : 0)}`;
}

export function fmtQty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return fmtCompact(v, "");
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
}

export function fmtAge(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const shortAddr = (a: string, n = 4) => (a.length > n * 2 + 2 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
