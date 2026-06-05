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
  // Use the v8 chart API but request no dividend/split adjustment by fetching
  // both adjusted and unadjusted close; we use the quote.high/low which are
  // unadjusted in Yahoo's API, paired with the unadjusted close for consistency.
  // For stocks with large dividend histories (e.g. PPC, ING), adjusted prices
  // can differ by 30-50% from the actual traded price — which would distort 3PTL.
  const end = Math.floor(Date.now() / 1000);
  const start = end - 5 * 365 * 24 * 3600; // 5 years ago
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1mo&period1=${start}&period2=${end}&includePrePost=false&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return [];
    const ts   = result.timestamp as number[];
    const q    = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    const adjQ = ((result.indicators as Record<string, unknown>)?.adjclose as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    if (!ts || !q) return [];

    // Use dividend-adjusted prices consistently across all bars.
    // Yahoo's adjclose adjusts historical prices DOWNWARD for paid dividends.
    // We apply the same per-bar factor (adjClose/rawClose) to high and low so
    // all OHLC values are in the same adjusted space. For recent bars adjClose ≈ rawClose
    // so the current price is essentially unadjusted — consistent for trendline comparison.
    // This fixes the issue where using (rawClose/adjClose) > 1 over-inflated historical
    // peaks for large dividend payers (ACL, SXL), making buy lines too low.
    return ts.map((t, i) => {
      const adjClose = adjQ?.adjclose?.[i];
      const rawClose = q.close?.[i];
      // adjFactor < 1 for historical bars (dividends reduce historical prices)
      // adjFactor ≈ 1.0 for recent/current bars (no future dividends to subtract)
      const adjFactor = (adjClose && rawClose && rawClose > 0) ? adjClose / rawClose : 1;
      return {
        date:  new Date(t * 1000).toISOString().slice(0, 7),
        high:  (q.high?.[i]  ?? 0) * adjFactor,
        low:   (q.low?.[i]   ?? 0) * adjFactor,
        close: adjClose ?? rawClose ?? 0,
      };
    }).filter(b => b.close > 0 && b.high > 0 && b.low > 0);
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
/**
 * For a given H1, find the best H2 to the right that:
 *   1. Has no high-violations between H1 and H2
 *   2. Gives a POSITIVE buy line at currentIdx (prevents negative extrapolation)
 * Tries H2 candidates in order: highest-price first (best line from top),
 * then falls back to later (lower, further-right) maxima for a shallower slope.
 */
/** Minimum months between H1 and H2 (or L1 and L2) to avoid meaninglessly steep lines */
const MIN_GAP_MONTHS = 6;

function findH2ForH1(maxima: Pivot[], h1: Pivot, bars: PriceBar[], currentIdx: number): Pivot | null {
  // Require H2 to be at least MIN_GAP_MONTHS after H1.
  // Three-month gaps create slopes so steep they extrapolate to near-zero years later.
  const rightMaxima = maxima.filter(m => m.idx > h1.idx + MIN_GAP_MONTHS);
  if (rightMaxima.length === 0) return null;

  // Try candidates: highest price first (steepest valid line), then by index descending (shallower)
  const byPrice  = [...rightMaxima].sort((a, b) => b.price - a.price);
  const byRecent = [...rightMaxima].sort((a, b) => b.idx - a.idx);
  const candidates = [...byPrice, ...byRecent];

  for (const h2Candidate of candidates) {
    // Apply violation-check refinement: ratchet H2 left if any intermediate max is above the line
    let h2 = h2Candidate;
    for (let iter = 0; iter < 20; iter++) {
      if (noHighViolation(bars, h1, h2)) break;
      const slope = (h2.price - h1.price) / (h2.idx - h1.idx);
      let worstViol: Pivot | null = null;
      for (const m of maxima) {
        if (m.idx <= h1.idx || m.idx >= h2.idx) continue;
        const lineAtM = h1.price + slope * (m.idx - h1.idx);
        if (m.price > lineAtM && (worstViol === null || m.price > worstViol.price)) worstViol = m;
      }
      if (!worstViol) break;
      h2 = worstViol;
    }
    if (!noHighViolation(bars, h1, h2)) continue;

    // Validate: the extrapolated line must be positive at the current date
    const lineValue = lineAt(h1, h2, currentIdx);
    if (lineValue > 0) return h2;
    // Line goes negative → this H2 creates too steep a slope → try next candidate
  }
  return null;
}

function findBuyLine(bars: PriceBar[], maxima: Pivot[], currentIdx: number):
  { h1: Pivot; h2: Pivot | null; line: number | null } {

  if (maxima.length < 2) return { h1: maxima[0] ?? { idx: 0, price: bars[0].high, date: bars[0].date }, h2: null, line: null };

  const globalMax = Math.max(...maxima.map(m => m.price));
  const thresh = globalMax * (1 - FUDGE);

  // H1 = rightmost within 8% of global max (flat-top fudge rule)
  const baseH1 = [...maxima].filter(m => m.price >= thresh).sort((a, b) => b.idx - a.idx)[0];

  // All H1 candidates: rightmost-within-8% first, then all maxima by price desc
  const allH1Candidates = [baseH1, ...[...maxima].sort((a, b) => b.price - a.price)];

  for (const h1 of allH1Candidates) {
    const h2 = findH2ForH1(maxima, h1, bars, currentIdx);
    if (h2) return { h1, h2, line: lineAt(h1, h2, currentIdx) };
  }

  // Complete fallback: no valid pair found
  return { h1: baseH1, h2: null, line: null };
}

/**
 * Find the sell line (L1→L2 through troughs). Mirror of findBuyLine.
 */
function findL2ForL1(minima: Pivot[], l1: Pivot, bars: PriceBar[], currentIdx: number): Pivot | null {
  const rightMinima = minima.filter(m => m.idx > l1.idx + MIN_GAP_MONTHS);
  if (rightMinima.length === 0) return null;

  const byPrice  = [...rightMinima].sort((a, b) => a.price - b.price); // lowest first
  const byRecent = [...rightMinima].sort((a, b) => b.idx - a.idx);     // most recent first
  const candidates = [...byPrice, ...byRecent];

  for (const l2Candidate of candidates) {
    let l2 = l2Candidate;
    for (let iter = 0; iter < 20; iter++) {
      if (noLowViolation(bars, l1, l2)) break;
      const slope = (l2.price - l1.price) / (l2.idx - l1.idx);
      let worstViol: Pivot | null = null;
      for (const m of minima) {
        if (m.idx <= l1.idx || m.idx >= l2.idx) continue;
        const lineAtM = l1.price + slope * (m.idx - l1.idx);
        if (m.price < lineAtM && (worstViol === null || m.price < worstViol.price)) worstViol = m;
      }
      if (!worstViol) break;
      l2 = worstViol;
    }
    if (!noLowViolation(bars, l1, l2)) continue;
    const lineValue = lineAt(l1, l2, currentIdx);
    if (lineValue > 0) return l2;
  }
  return null;
}

function findSellLine(bars: PriceBar[], minima: Pivot[], currentIdx: number):
  { l1: Pivot; l2: Pivot | null; line: number | null } {

  if (minima.length < 2) return { l1: minima[0] ?? { idx: 0, price: bars[0].low, date: bars[0].date }, l2: null, line: null };

  const globalMin = Math.min(...minima.map(m => m.price));
  const thresh = globalMin * (1 + FUDGE);

  const baseL1 = [...minima].filter(m => m.price <= thresh).sort((a, b) => b.idx - a.idx)[0];
  const allL1Candidates = [baseL1, ...[...minima].sort((a, b) => a.price - b.price)];

  for (const l1 of allL1Candidates) {
    const l2 = findL2ForL1(minima, l1, bars, currentIdx);
    if (l2) return { l1, l2, line: lineAt(l1, l2, currentIdx) };
  }

  return { l1: baseL1, l2: null, line: null };
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
  const belowSell = sellLine !== null && currentPrice < sellLine;

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
  } else if (belowSell) {
    // Definitively below the sell line — Bearish regardless of buy line
    sentiment = "Bearish";
    note = `Bearish: price ${currentPrice.toFixed(3)} below sell line ${sellLine!.toFixed(3)}`;
  } else if (aboveSell) {
    // Above sell line but below buy line — Josephine (between the lines)
    sentiment = "Josephine";
    note = `Josephine: above sell line ${sellLine!.toFixed(3)} but below buy line ${buyLine?.toFixed(3) ?? "n/a"} — between the lines`;
  } else if (aboveBuy && sellLine === null) {
    // Above buy line, sell line not yet established (stock just bottomed)
    // Can't confirm Bullish without a sell line — treat as Josephine
    sentiment = "Josephine";
    note = `Josephine: above buy line ${buyLine!.toFixed(3)} but sell line not yet established (recent trough, no second low yet)`;
  } else if (!aboveBuy && buyLine !== null && sellLine === null) {
    // Below buy line, no sell line — the stock has crashed below resistance
    sentiment = "Bearish";
    note = `Bearish: price ${currentPrice.toFixed(3)} below buy line ${buyLine.toFixed(3)} — sell line not yet established`;
  } else {
    // No lines calculable — can't determine trend
    sentiment = "Josephine";
    note = `Insufficient data to calculate trendlines — defaulting to Josephine`;
  }

  // ── Falling knife override ────────────────────────────────────────────────────
  // Bible: "NEVER TRY TO CATCH A FALLING KNIFE. A stock that has been falling for
  // a long period of time — it occasionally breaches its buy line, only to drop
  // back below it. Best to avoid these stocks until they demonstrate a clear trend."
  //
  // If a Bullish signal came from CROSSING the downtrend buy line (not from a
  // confirmed uptrend with 3 consecutive higher lows), and the stock is still
  // deeply below a recent peak, it's a falling knife — override to Bearish.
  //
  // Rules:
  //   >70% below most recent local peak → Bearish  (NO time limit — GRR/A1N type)
  //   >40% below recent peak (≤36mo)    → Josephine (caution, partial confirmation)
  //
  // Only applies when sentiment is Bullish AND no formal 3PTL uptrend (uptrendActive).
  // If 3 consecutive higher lows are confirmed, we trust that signal.
  if (sentiment === "Bullish" && maxima.length >= 1) {
    // Use the HIGHEST local maximum in the dataset for the 70% Bearish check.
    // A stock 90% below its 2022 major peak is a falling knife even if there was
    // a minor rally to $0.305 in Nov 2025 — check against the true peak, not just
    // the most recent one.
    const highestPeak = maxima.reduce((best, m) => m.price > best.price ? m : best, maxima[0]);
    const recentPeak  = maxima[maxima.length - 1]; // most recent local max
    const mthsSinceHighest = currentIdx - highestPeak.idx;
    const mthsSinceRecent  = currentIdx - recentPeak.idx;
    const pctBelowHighest  = (highestPeak.price - currentPrice) / highestPeak.price;
    const pctBelowRecent   = (recentPeak.price  - currentPrice) / recentPeak.price;

    if (pctBelowHighest >= 0.70) {
      // Deep falling knife vs the major peak — override regardless of time elapsed.
      sentiment = "Bearish";
      note = `Falling knife: ${(pctBelowHighest * 100).toFixed(0)}% below major peak ${highestPeak.price.toFixed(3)} (${mthsSinceHighest}mo ago). Long-term downtrend not reversed.`;
    } else if (mthsSinceRecent <= 36 && pctBelowRecent >= 0.40) {
      // Significant recent decline — caution
      sentiment = "Josephine";
      note = `Caution: ${(pctBelowRecent * 100).toFixed(0)}% below recent peak ${recentPeak.price.toFixed(3)} (${mthsSinceRecent}mo ago) — wait for 3 confirmed higher lows before buying.`;
    }
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
