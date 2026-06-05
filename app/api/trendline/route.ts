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
 * Find local maxima: bars where high is strictly the highest in a window.
 * lookback=2 means bar[i].high must be ≥ all bars in [i-2 .. i+2].
 */
function localMaxima(bars: PriceBar[], lookback = 2): Pivot[] {
  const n = bars.length;
  const out: Pivot[] = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isMax = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j].high > bars[i].high) { isMax = false; break; }
    }
    if (isMax) out.push({ idx: i, price: bars[i].high, date: bars[i].date });
  }
  return out;
}

/** Find local minima: bars where low is strictly the lowest in a window. */
function localMinima(bars: PriceBar[], lookback = 2): Pivot[] {
  const n = bars.length;
  const out: Pivot[] = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isMin = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j].low < bars[i].low) { isMin = false; break; }
    }
    if (isMin) out.push({ idx: i, price: bars[i].low, date: bars[i].date });
  }
  return out;
}

/** Check that no bar's high between fromIdx and toIdx is above the P1→P2 line */
function noHighViolation(bars: PriceBar[], p1: Pivot, p2: Pivot): boolean {
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  for (let k = p1.idx + 1; k < p2.idx; k++) {
    if (bars[k].high > p1.price + slope * (k - p1.idx) + 1e-9) return false;
  }
  return true;
}

/** Check that no bar's low between fromIdx and toIdx is below the P1→P2 line */
function noLowViolation(bars: PriceBar[], p1: Pivot, p2: Pivot): boolean {
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  for (let k = p1.idx + 1; k < p2.idx; k++) {
    if (bars[k].low < p1.price + slope * (k - p1.idx) - 1e-9) return false;
  }
  return true;
}

/** Extrapolate P1→P2 line to targetIdx */
function lineAt(p1: Pivot, p2: Pivot, targetIdx: number): number {
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  return p1.price + slope * (targetIdx - p1.idx);
}

/**
 * Find the buy line (H1→H2 through peaks).
 *
 * Algorithm:
 * 1. Find all local maxima in the dataset.
 * 2. Apply 8% flat-top fudge: H1 = rightmost maximum within 8% of the global max.
 * 3. Find H2 = the highest local maximum to the RIGHT of H1 such that the
 *    H1→H2 line has no intermediate bar above it.
 *    If a violation exists, the violating maximum becomes the new H2 candidate.
 * 4. If no valid H2 exists to the right (H1 is the rightmost significant peak),
 *    try the next highest local maximum as H1 until we find a pair.
 */
function findBuyLine(bars: PriceBar[], maxima: Pivot[], currentIdx: number):
  { h1: Pivot; h2: Pivot | null; line: number | null } {

  if (maxima.length < 2) return { h1: maxima[0] ?? { idx: 0, price: bars[0].high, date: bars[0].date }, h2: null, line: null };

  const globalMax = Math.max(...maxima.map(m => m.price));
  const thresh = globalMax * (1 - FUDGE);

  // Candidates for H1 sorted by price descending (highest first), applying 8% fudge
  const h1Candidates = maxima
    .filter(m => m.price >= thresh)
    .sort((a, b) => b.price - a.price || b.idx - a.idx); // highest price, rightmost if tied

  // H1 = rightmost within 8% of global max
  const fudgeH1s = maxima.filter(m => m.price >= thresh).sort((a, b) => b.idx - a.idx);
  const baseH1 = fudgeH1s[0];

  // Try each candidate for H1 starting from the highest
  for (const h1 of [baseH1, ...h1Candidates]) {
    const rightMaxima = maxima.filter(m => m.idx > h1.idx).sort((a, b) => b.price - a.price);
    if (rightMaxima.length === 0) continue;

    // Find H2: highest right maximum with valid (no-violation) H1→H2 line
    // Iterative: start with highest right maximum, ratchet toward H1 on violations
    let h2 = rightMaxima[0];

    for (let iter = 0; iter < 20; iter++) {
      if (noHighViolation(bars, h1, h2)) break; // Valid!
      // Find the maximum between h1 and h2 that's above the current line
      const slope = (h2.price - h1.price) / (h2.idx - h1.idx);
      let worstViol: Pivot | null = null;
      for (const m of maxima) {
        if (m.idx <= h1.idx || m.idx >= h2.idx) continue;
        const lineAtM = h1.price + slope * (m.idx - h1.idx);
        if (m.price > lineAtM && (worstViol === null || m.price > worstViol.price)) {
          worstViol = m;
        }
      }
      if (!worstViol) break;
      h2 = worstViol;
    }

    if (noHighViolation(bars, h1, h2)) {
      return { h1, h2, line: lineAt(h1, h2, currentIdx) };
    }
  }

  // Fallback: just use the two highest maxima
  const sorted = [...maxima].sort((a, b) => b.price - a.price);
  const h1 = sorted[0];
  const h2 = maxima.filter(m => m.idx > h1.idx).sort((a, b) => b.price - a.price)[0] ?? null;
  return { h1, h2, line: h2 ? lineAt(h1, h2, currentIdx) : null };
}

/**
 * Find the sell line (L1→L2 through troughs). Mirror of findBuyLine.
 */
function findSellLine(bars: PriceBar[], minima: Pivot[], currentIdx: number):
  { l1: Pivot; l2: Pivot | null; line: number | null } {

  if (minima.length < 2) return { l1: minima[0] ?? { idx: 0, price: bars[0].low, date: bars[0].date }, l2: null, line: null };

  const globalMin = Math.min(...minima.map(m => m.price));
  const thresh = globalMin * (1 + FUDGE);

  const fudgeL1s = minima.filter(m => m.price <= thresh).sort((a, b) => b.idx - a.idx);
  const baseL1 = fudgeL1s[0];

  const l1Candidates = [baseL1, ...minima.filter(m => m.price <= thresh).sort((a, b) => a.price - b.price)];

  for (const l1 of l1Candidates) {
    const rightMinima = minima.filter(m => m.idx > l1.idx).sort((a, b) => a.price - b.price);
    if (rightMinima.length === 0) continue;

    let l2 = rightMinima[0];

    for (let iter = 0; iter < 20; iter++) {
      if (noLowViolation(bars, l1, l2)) break;
      const slope = (l2.price - l1.price) / (l2.idx - l1.idx);
      let worstViol: Pivot | null = null;
      for (const m of minima) {
        if (m.idx <= l1.idx || m.idx >= l2.idx) continue;
        const lineAtM = l1.price + slope * (m.idx - l1.idx);
        if (m.price < lineAtM && (worstViol === null || m.price < worstViol.price)) {
          worstViol = m;
        }
      }
      if (!worstViol) break;
      l2 = worstViol;
    }

    if (noLowViolation(bars, l1, l2)) {
      return { l1, l2, line: lineAt(l1, l2, currentIdx) };
    }
  }

  const sorted = [...minima].sort((a, b) => a.price - b.price);
  const l1 = sorted[0];
  const l2 = minima.filter(m => m.idx > l1.idx).sort((a, b) => a.price - b.price)[0] ?? null;
  return { l1, l2, line: l2 ? lineAt(l1, l2, currentIdx) : null };
}

/**
 * Main 3PTL classification.
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
  const currentIdx = n;

  const maxima = localMaxima(bars, 2);
  const minima = localMinima(bars, 2);

  // ── BUY LINE ──────────────────────────────────────────────────────────────
  const { h1, h2, line: buyLine } = findBuyLine(bars, maxima, currentIdx);

  // ── SELL LINE ─────────────────────────────────────────────────────────────
  const { l1, l2, line: sellLine } = findSellLine(bars, minima, currentIdx);

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
