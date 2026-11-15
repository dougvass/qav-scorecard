/**
 * Total return — price plus distributions reinvested — from Yahoo's
 * dividend-adjusted closes, the same kind of series TradingView calls ADJ.
 *
 * Doug, 2026-11-15: "Is there a way we could measure and track 1YR, 3YR, and
 * 5YR returns all in Total return including dividends and capital returns?
 * Could we use the ADJ in trading view equivalent somewhere to help track our
 * QAV stocks?" The ETF page already measured its funds this way; this file is
 * that arithmetic, shared, so the stock route can do the same from the monthly
 * fetch it already makes for the 3PTL.
 *
 * WHAT THE SERIES COVERS. Cash dividends (as if reinvested on the ex-date) and
 * splits / consolidations. NOT franking credits, so a fully franked payer's
 * true return to an Australian holder is higher than shown. A capital return is
 * included only where Yahoo records it as a distribution — not verified case by
 * case. Measured on BHP, 15 Nov 2026: 5-year total return +128% against +68%
 * on price alone; NHC +322% against +154%; FMG +32% against −13%.
 */

/** One adjusted close, tagged with its calendar month as year*12 + month. */
export interface AdjPoint { m: number; adj: number }

export interface TotalReturns {
  r1y: number | null;
  r3y: number | null;
  r5y: number | null;
}

/**
 * Total return over a horizon, in percent to one decimal. `base` is the latest
 * point on or before the target month; more than two months short of it means
 * the security has not existed that long, and the horizon is null rather than a
 * flattering partial number.
 */
export function totalReturn(series: AdjPoint[], months: number): number | null {
  if (series.length < 2) return null;
  const now = series[series.length - 1];
  const targetM = now.m - months;
  let base: AdjPoint | null = null;
  for (const p of series) {
    if (p.m <= targetM) base = p;   // latest point on or before the target month
    else break;
  }
  if (!base || base.adj <= 0 || now.adj <= 0) return null;
  if (targetM - base.m > 2) return null; // not enough history to reach this horizon
  return Math.round((now.adj / base.adj - 1) * 1000) / 10;
}

export function totalReturns(series: AdjPoint[]): TotalReturns {
  return { r1y: totalReturn(series, 12), r3y: totalReturn(series, 36), r5y: totalReturn(series, 60) };
}
