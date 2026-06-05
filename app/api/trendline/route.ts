/**
 * 3PTL (3-Point Trendline) — Tony Kynaston's QAV method, correctly implemented.
 *
 * BUY LINE (through peaks/resistance):
 *   H1 = globally highest bar in 5yr dataset, with 8% flat-top fudge
 *        (if multiple bars within 8% of the max, use the RIGHTMOST)
 *   H2 = next highest bar to the RIGHT of H1 such that no intermediate
 *        bar's high violates (rises above) the H1→H2 line
 *        If H1 is the rightmost peak, shift left to find a new H1 that has H2 to its right.
 *   BUY line = H1→H2 extended to today
 *
 * SELL LINE (through troughs/support):
 *   L1 = globally lowest bar in 5yr dataset, with 8% flat-bottom fudge
 *        (if multiple bars within 8% of the min, use the RIGHTMOST)
 *   L2 = next lowest bar to the RIGHT of L1 such that no intermediate
 *        bar's low violates (dips below) the L1→L2 line
 *   SELL line = L1→L2 extended to today
 *
 * Classification:
 *   price > BUY line AND > SELL line → Bullish (above both lines)
 *   price > SELL line AND < BUY line → Josephine (between lines)
 *   price < SELL line               → Bearish (below support)
 *
 * POST /api/trendline { codes: string[] }   — batch ≤25
 * GET  /api/trendline?code=FEX              — debug single ticker
 */

export const runtime = "edge";

const FUDGE        = 0.08;  // 8% flat top/bottom fudge (Bible rule)
const BREAKOUT_BUF = 1.02;  // price must be 2% above BUY line for confirmed breakout

// ── Data types ─────────────────────────────────────────────────────────────────

interface PriceBar { date: string; high: number; low: number; close: number }
interface Pivot    { idx: number; price: number; date: string }
type Sentiment = "Bullish" | "Josephine" | "Bearish";

// ── Yahoo Finance ──────────────────────────────────────────────────────────────

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchMonthly(code: string): Promise<PriceBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1mo&range=5y&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return [];
    const ts = result.timestamp as number[];
    const q  = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    if (!ts || !q) return [];
    return ts.map((t, i) => ({
      date:  new Date(t * 1000).toISOString().slice(0, 7),
      high:  q.high?.[i]  ?? 0,
      low:   q.low?.[i]   ?? 0,
      close: q.close?.[i] ?? 0,
    })).filter(b => b.close > 0 && b.high > 0 && b.low > 0);
  } catch { return []; }
}

async function fetchCurrentPrice(code: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1d&range=5d&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return null;
    const closes = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!closes) return null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && !isNaN(closes[i]) && closes[i] > 0) return closes[i];
    }
    return null;
  } catch { return null; }
}

// ── Core 3PTL algorithm ────────────────────────────────────────────────────────

/**
 * Find H1: the globally highest bar, with 8% flat-top fudge.
 * Among all bars within 8% of the absolute maximum, use the RIGHTMOST.
 */
function findH1(bars: PriceBar[]): Pivot {
  const maxHigh = Math.max(...bars.map(b => b.high));
  const thresh  = maxHigh * (1 - FUDGE);
  // Rightmost bar at or above threshold
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].high >= thresh) {
      return { idx: i, price: bars[i].high, date: bars[i].date };
    }
  }
  return { idx: 0, price: bars[0].high, date: bars[0].date };
}

/**
 * Find H2: next highest valid point to the RIGHT of H1.
 * The H1→H2 line must not have any intermediate bar's high above it.
 * Uses iterative refinement: start with highest bar to the right, then
 * ratchet left whenever a violation is found.
 */
function findH2(bars: PriceBar[], h1: Pivot): Pivot | null {
  const n = bars.length;
  if (h1.idx >= n - 1) return null;

  // Seed: highest bar to the right of H1
  let h2Idx = -1, h2Price = -1;
  for (let i = h1.idx + 1; i < n; i++) {
    if (bars[i].high > h2Price) { h2Price = bars[i].high; h2Idx = i; }
  }
  if (h2Idx === -1) return null;

  // Iterative refinement: if any bar between H1 and H2 is above the line → it becomes H2
  for (let iter = 0; iter < 30; iter++) {
    const slope = (h2Price - h1.price) / (h2Idx - h1.idx);
    let worstViolIdx = -1, worstViolPrice = -Infinity;
    for (let k = h1.idx + 1; k < h2Idx; k++) {
      const lineAtK = h1.price + slope * (k - h1.idx);
      if (bars[k].high > lineAtK && bars[k].high > worstViolPrice) {
        worstViolIdx = k; worstViolPrice = bars[k].high;
      }
    }
    if (worstViolIdx === -1) break; // No violations → H2 confirmed
    h2Idx = worstViolIdx; h2Price = worstViolPrice;
  }

  return { idx: h2Idx, price: h2Price, date: bars[h2Idx].date };
}

/**
 * Find L1: the globally lowest bar, with 8% flat-bottom fudge.
 * Among all bars within 8% of the absolute minimum, use the RIGHTMOST.
 */
function findL1(bars: PriceBar[]): Pivot {
  const minLow  = Math.min(...bars.map(b => b.low));
  const thresh  = minLow * (1 + FUDGE);
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].low <= thresh) {
      return { idx: i, price: bars[i].low, date: bars[i].date };
    }
  }
  return { idx: 0, price: bars[0].low, date: bars[0].date };
}

/**
 * Find L2: next lowest valid point to the RIGHT of L1.
 * The L1→L2 line must not have any intermediate bar's low below it.
 */
function findL2(bars: PriceBar[], l1: Pivot): Pivot | null {
  const n = bars.length;
  if (l1.idx >= n - 1) return null;

  let l2Idx = -1; let l2Price = Infinity;
  for (let i = l1.idx + 1; i < n; i++) {
    if (bars[i].low < l2Price) { l2Price = bars[i].low; l2Idx = i; }
  }
  if (l2Idx === -1) return null;

  for (let iter = 0; iter < 30; iter++) {
    const slope = (l2Price - l1.price) / (l2Idx - l1.idx);
    let worstViolIdx = -1; let worstViolPrice = Infinity;
    for (let k = l1.idx + 1; k < l2Idx; k++) {
      const lineAtK = l1.price + slope * (k - l1.idx);
      if (bars[k].low < lineAtK && bars[k].low < worstViolPrice) {
        worstViolIdx = k; worstViolPrice = bars[k].low;
      }
    }
    if (worstViolIdx === -1) break;
    l2Idx = worstViolIdx; l2Price = worstViolPrice;
  }

  return { idx: l2Idx, price: l2Price, date: bars[l2Idx].date };
}

/** Extrapolate a line from P1→P2 to the given index */
function lineAt(p1: Pivot, p2: Pivot, targetIdx: number): number {
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  return p1.price + slope * (targetIdx - p1.idx);
}

/**
 * Main 3PTL classification.
 * Returns buy line, sell line, and Bullish / Josephine / Bearish sentiment.
 */
function classify3PTL(bars: PriceBar[], currentPrice: number): {
  sentiment: Sentiment;
  buyLine: number | null;
  sellLine: number | null;
  h1: Pivot; h2: Pivot | null;
  l1: Pivot; l2: Pivot | null;
  note: string;
} {
  const n = bars.length;
  const currentIdx = n; // one step past the last bar (today)

  // ── BUY LINE ──────────────────────────────────────────────────────────────
  let h1 = findH1(bars);
  let h2 = findH2(bars, h1);

  // If H1 is at or near the right edge (no room for H2), shift H1 leftwards:
  // find the next-highest bar that DOES have room for H2 to its right.
  if (h2 === null || h2.idx <= h1.idx) {
    // Try each bar in descending price order as a new H1 candidate
    const candidates = bars
      .map((b, i) => ({ idx: i, price: b.high, date: b.date }))
      .sort((a, b) => b.price - a.price);

    for (const cand of candidates) {
      if (cand.idx === h1.idx) continue; // skip the original H1 we already tried
      const tentativeH2 = findH2(bars, cand);
      if (tentativeH2 && tentativeH2.idx > cand.idx) {
        h1 = cand; h2 = tentativeH2; break;
      }
    }
  }

  const buyLine = h2 ? lineAt(h1, h2, currentIdx) : null;

  // ── SELL LINE ─────────────────────────────────────────────────────────────
  let l1 = findL1(bars);
  let l2 = findL2(bars, l1);

  if (l2 === null || l2.idx <= l1.idx) {
    const candidates = bars
      .map((b, i) => ({ idx: i, price: b.low, date: b.date }))
      .sort((a, b) => a.price - b.price); // ascending (lowest first)

    for (const cand of candidates) {
      if (cand.idx === l1.idx) continue;
      const tentativeL2 = findL2(bars, cand);
      if (tentativeL2 && tentativeL2.idx > cand.idx) {
        l1 = cand; l2 = tentativeL2; break;
      }
    }
  }

  const sellLine = l2 ? lineAt(l1, l2, currentIdx) : null;

  // ── CLASSIFY ─────────────────────────────────────────────────────────────
  let sentiment: Sentiment = "Josephine";
  let note = "";

  const aboveBuy  = buyLine  !== null && currentPrice >= buyLine  * BREAKOUT_BUF;
  const aboveSell = sellLine !== null && currentPrice >= sellLine;

  if (aboveBuy && aboveSell) {
    // Above both lines — check for Josephine (month-on-month decline)
    const lastClose = bars[n - 1].close;
    const prevClose = bars[n - 2]?.close ?? lastClose;
    if (lastClose < prevClose) {
      sentiment = "Josephine";
      note = `Josephine ↗: above both lines but current month (${lastClose.toFixed(3)}) < previous (${prevClose.toFixed(3)}) — wait for uptick`;
    } else {
      sentiment = "Bullish";
      note = `Bullish: price ${currentPrice.toFixed(3)} above buy line ${buyLine?.toFixed(3)} and sell line ${sellLine?.toFixed(3)}`;
    }
  } else if (aboveSell) {
    // Between lines (above sell, below buy) — Josephine / Schrodinger
    sentiment = "Josephine";
    note = `Josephine: above sell line ${sellLine?.toFixed(3)} but below buy line ${buyLine?.toFixed(3)} — between the lines`;
  } else {
    sentiment = "Bearish";
    note = `Bearish: price ${currentPrice.toFixed(3)} below sell line ${sellLine?.toFixed(3)}`;
  }

  return { sentiment, buyLine, sellLine, h1, h2, l1, l2, note };
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

async function processCode(code: string) {
  const [bars, currentPrice] = await Promise.all([fetchMonthly(code), fetchCurrentPrice(code)]);
  if (bars.length < 12) return { sentiment: "Josephine" as Sentiment, error: "insufficient data", months: bars.length };
  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify3PTL(bars, price);
  return { ...result, months: bars.length };
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { codes } = (await request.json()) as { codes?: string[] };
  const batch = (codes ?? []).slice(0, 25);
  if (!batch.length) return Response.json({ error: "codes required" }, { status: 400 });
  const results = await Promise.all(batch.map(processCode));
  const out: Record<string, object> = {};
  batch.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}

// ── GET — debug ────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "FEX").toUpperCase();
  const [bars, currentPrice] = await Promise.all([fetchMonthly(code), fetchCurrentPrice(code)]);
  const base = { code, runtime: "edge", monthly_bars: bars.length, current_price: currentPrice };
  if (bars.length < 12) return Response.json({ ...base, error: "insufficient data" });

  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify3PTL(bars, price);

  return Response.json({
    ...base,
    ...result,
    oldest: bars[0]?.date,
    newest: bars[bars.length - 1]?.date,
    last_4: bars.slice(-4).map(b => ({ date: b.date, high: b.high, low: b.low, close: b.close })),
    h1_detail: result.h1 ? `${result.h1.date} @ ${result.h1.price.toFixed(3)}` : null,
    h2_detail: result.h2 ? `${result.h2.date} @ ${result.h2.price.toFixed(3)}` : null,
    l1_detail: result.l1 ? `${result.l1.date} @ ${result.l1.price.toFixed(3)}` : null,
    l2_detail: result.l2 ? `${result.l2.date} @ ${result.l2.price.toFixed(3)}` : null,
  });
}
