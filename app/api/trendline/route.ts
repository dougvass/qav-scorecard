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
  // Fetch 6 years (not 5): localMaxima/localMinima use a ±2-bar lookback window,
  // so genuine pivots in the FIRST/LAST `lookback` bars of the fetched series can
  // never be detected (there's no room to confirm them as the local extreme).
  // CONFIRMED bug, found via BRK: Tony's chart anchor H1 = $1.75 @ "01 Jul 2021"
  // (≈ Yahoo's 2021-06 bar, close=high=$1.75) sits at idx 0-1 in a 5-year window
  // — and the true all-time high ($2.05, 2021-07) at idx 1 — both UNDETECTABLE
  // as local maxima, forcing the algorithm onto a much-lower H1 ($1.35, 2022-02)
  // that produces a buy line far below Tony's, wrongly converging with the sell
  // line into "Josephine" instead of the correct "Bullish". One extra year of
  // buffer pushes these bars to idx ~12-13 — comfortably confirmable — without
  // materially changing which RECENT pivots end up driving the live H1/H2/L1/L2
  // selection (CONFIRM_MONTHS=9 + most-recent-first search already favour recent
  // anchors; the extra year only rescues genuinely-significant edge-of-window highs).
  const start = end - 6 * 365 * 24 * 3600; // 6 years ago
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

    // Use RAW (unadjusted) OHLC throughout — this is what TradingView displays
    // and what Tony's chart-anchor prices are read off. CONFIRMED Jun-2026 via
    // live Yahoo data against the user's exact chart coordinates: BFL's raw
    // close for 2021-07 is $5.60 — an EXACT match to Tony's stated H1 anchor
    // price ($5.60) — while the dividend-adjusted value for that same bar is
    // only ~$3.49 (adjFactor 0.623, due to ~10 dividend payments since 2021).
    // Likewise BRK's raw 2021-07 high/close ($2.05 / $1.65) brackets Tony's
    // H1 of $1.75, while BRK's adjusted series tops out around $1.35 — nowhere
    // near Tony's anchor. (BRK pays no dividends, so adjFactor≈1.0 there —
    // the cached/previous mismatch came from BFL/other dividend-payers' factors
    // contaminating the comparison, not BRK's own adjustment.)
    // For BOL — our one fully chart-verified reference — adjFactor is ≈0.96-1.0
    // throughout its history (it's a low/no-dividend payer), so raw ≈ adjusted
    // there and this switch does not disturb its verified anchor match.
    // Net effect: raw prices are unambiguously the correct basis for matching
    // a chartist's reading of a TradingView chart — adjustment was actively
    // WRONG for dividend-heavy stocks (BFL, and presumably JYC, CGF, etc.),
    // silently shrinking historical peaks/troughs by 30-60% and producing
    // anchor points that don't exist anywhere on the chart a human sees.
    return ts.map((t, i) => {
      const rawClose = q.close?.[i];
      return {
        date:  new Date(t * 1000).toISOString().slice(0, 7),
        high:  q.high?.[i] ?? 0,
        low:   q.low?.[i]  ?? 0,
        close: rawClose ?? adjQ?.adjclose?.[i] ?? 0,
      };
    }).filter(b => b.close > 0 && b.high > 0 && b.low > 0);
  } catch { return []; }
}

/**
 * Derives the TRUE close of the last FULLY-COMPLETED calendar month from daily
 * data — needed for the Bible's "Josephine" rule ("today's price is lower than
 * the price at the end of the previous month").
 *
 * CONFIRMED BUG (found via KAR on 2026-06-08): `fetchMonthly`'s second-to-last
 * bar — which `classify3PTL` used to treat as "last month's close" — is NOT
 * reliable near a month boundary. Yahoo's `interval=1mo` endpoint backfills the
 * live/current price into BOTH of the trailing two monthly bars once the new
 * month has only a few trading days of data (confirmed across all 8 reference
 * stocks: every one of them had `bars[n-2].close === regularMarketPrice`,
 * exactly equal to the current live quote — not the prior month's actual close).
 * For KAR specifically this masked a real signal: true May-2026 close = $1.955,
 * live price = $1.945 (price IS below last month's close → Josephine per the
 * Bible), but the corrupted monthly bar reported May's close as $1.945 too,
 * making the two look identical (no decline detected → wrongly "Bullish").
 *
 * Fix: fetch ~2 months of DAILY bars and take the close of the last trading
 * day whose calendar month is strictly before the current one — i.e. the
 * genuine last trading day of the previous month.
 */
async function fetchLastCompletedMonthClose(code: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1d&range=2mo&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return null;
    const ts = result.timestamp as number[];
    const closes = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!ts || !closes) return null;
    const now = new Date();
    const curYear = now.getUTCFullYear(), curMonth = now.getUTCMonth();
    let lastClose: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null || isNaN(closes[i]) || closes[i] <= 0) continue;
      const d = new Date(ts[i] * 1000);
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      // keep the LATEST bar that falls strictly before the current calendar month
      if (y < curYear || (y === curYear && m < curMonth)) lastClose = closes[i];
    }
    return lastClose;
  } catch { return null; }
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
 * Tolerance for treating near-identical highs/lows as TIES when detecting
 * pivots. Even with raw (unadjusted) OHLC — see `fetchMonthly` — Yahoo's feed
 * can still return near-but-not-quite-identical floats for what a chartist
 * reads as one flat level (e.g. a run of "$1.05" lows landing 1.0500000001 vs
 * 1.0499999998 a few bars apart from rounding/feed noise on the order of 1e-6
 * to 1e-8). Without this tolerance, only ONE of a flat-bottom/flat-top trio registers
 * as a pivot — and it's effectively arbitrary WHICH one (whichever happens to
 * be a few billionths lower/higher) — instead of the chartist's natural
 * choice of "the rightmost of the tied extremes" (exactly the logic the 8%
 * flat-top/flat-bottom fudge already applies once candidates exist).
 * 0.01% (1e-4) comfortably swallows float noise while still being far tighter
 * than any genuine distinct price level (which differ by ≥0.5-1% in practice).
 */
const PIVOT_TIE_TOL = 1e-4;

/** Minimum months between H1 and H2 (or L1 and L2) to avoid meaninglessly steep lines */
const MIN_GAP_MONTHS = 6;

/**
 * Minimum months of subsequent price action before a peak/trough is "confirmed"
 * as a stable chart anchor (see `isConfirmed` below). Deliberately a SEPARATE,
 * LARGER constant than MIN_GAP_MONTHS: a brand-new high/low needs more time to
 * prove itself than the minimum spacing we'd ever want between two anchors.
 *
 * Verified by sweeping this value across all 7 reference stocks (BOL, BFL, BRK,
 * AMI, CGF, JYC, AQZ — Tony's published buy list, Jun-2026): 9 months is the
 * smallest value that (a) still reproduces BOL's exact chart anchors (H1=Apr-22,
 * H2=Mar-25) and (b) stops AMI/CGF/AQZ's very-recent spikes (5-7mo old) from
 * hijacking H1/H2 selection — AMI and CGF were wrongly landing in "Josephine"
 * and AQZ in "Josephine" instead of "Bearish" with the old 6-month bar because
 * their freshest peaks (un-confirmed in a chartist's eyes) were skewing the
 * "highest confirmed peak" choice and the falling-knife "major peak" check.
 * Raising to 12-15 months changes nothing further for these 7 — 9 is the
 * minimal, least-disruptive value that fixes the cases it needs to.
 */
const CONFIRM_MONTHS = 9;

/**
 * Find local maxima: bars where high is the highest (or tied-highest) in a window.
 * lookback=2 means bar[i].high must be ≥ all bars in [i-2 .. i+2] (within tie tolerance).
 */
function localMaxima(bars: PriceBar[], lookback = 2): Pivot[] {
  const n = bars.length;
  const out: Pivot[] = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isMax = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j].high > bars[i].high * (1 + PIVOT_TIE_TOL)) { isMax = false; break; }
    }
    if (isMax) out.push({ idx: i, price: bars[i].high, date: bars[i].date });
  }
  return out;
}

/** Find local minima: bars where low is the lowest (or tied-lowest) in a window. */
function localMinima(bars: PriceBar[], lookback = 2): Pivot[] {
  const n = bars.length;
  const out: Pivot[] = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isMin = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j !== i && bars[j].low < bars[i].low * (1 - PIVOT_TIE_TOL)) { isMin = false; break; }
    }
    if (isMin) out.push({ idx: i, price: bars[i].low, date: bars[i].date });
  }
  return out;
}

/**
 * A pivot is "confirmed" only once at least MIN_GAP_MONTHS of price action has
 * unfolded AFTER it — mirroring the existing H1→H2 gap rule. A peak/trough
 * that formed only weeks ago hasn't yet been validated as a genuine turning
 * point; a chartist wouldn't anchor a live trendline on it yet.
 *
 * CONFIRMED against Tony's actual BOL chart: as of Jun-2026, BOL had just
 * printed a fresh $1.94 high in Jan-2026 (only 5 months of data behind it) —
 * within the 8% flat-top band of the all-time high, and more recent than
 * Apr-2022's $1.92. A naive "rightmost peak within 8%" pick would anchor H1
 * there. But Tony's live chart STILL anchors on Apr-2022 — because Jan-2026
 * isn't "confirmed" yet. This filter is what reproduces that exact choice.
 *
 * (currentIdx === bars.length, i.e. one slot past the last real bar — so a
 * pivot at `idx` has `(bars.length - 1) - idx` real bars after it; requiring
 * that to be ≥ CONFIRM_MONTHS is `idx <= currentIdx - CONFIRM_MONTHS - 1`.)
 */
function isConfirmed(p: Pivot, currentIdx: number): boolean {
  return p.idx <= currentIdx - CONFIRM_MONTHS - 1;
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

/** Tolerance for "touching" a trendline ray — small buffer to avoid float noise. */
const TOUCH_EPS = 1e-9;

/**
 * Has any CONFIRMED peak after H2 retested (touched or crossed up through) the
 * H1→H2 ray extended forward? Returns the earliest such peak, or null if the
 * ray has held untouched all the way to the most recent confirmed maximum.
 *
 * IMPORTANT DISTINCTION (confirmed against Tony's actual BOL chart — H1=Apr-22
 * @$1.92, H2=Mar-25 @$1.63 — the line he STILL has live today even though price
 * has been crossing above it every month since Oct-25):
 *
 *   A later peak crossing the line is NOT automatically a "retest" that
 *   invalidates it — that crossing might just BE the breakout/buy signal.
 *   The line is only stale if that breakout FAILED — i.e. price crossed above
 *   it and then fell back BELOW it again at some later point (a whipsaw/failed
 *   breakout means the old level is still the real resistance, redraw from
 *   there). If price crosses and then STAYS above all the way to today, that's
 *   a confirmed, sustained breakout — the original line remains the live buy
 *   line and the stock is now (correctly) trading above it.
 */
function rayRetestedAbove(maxima: Pivot[], h1: Pivot, h2: Pivot): Pivot | null {
  const slope = (h2.price - h1.price) / (h2.idx - h1.idx);
  const after = maxima.filter(m => m.idx > h2.idx).sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < after.length; i++) {
    const m = after[i];
    const lineAtM = h1.price + slope * (m.idx - h1.idx);
    if (m.price < lineAtM - TOUCH_EPS) continue; // hasn't reached the line yet
    // Crossed/touched at m — failed breakout only if a LATER peak falls back below.
    for (let j = i + 1; j < after.length; j++) {
      const n = after[j];
      const lineAtN = h1.price + slope * (n.idx - h1.idx);
      if (n.price < lineAtN - TOUCH_EPS) return m; // whipsaw — redraw from the failed-breakout peak
    }
    return null; // crossed and held through to the most recent peak — confirmed breakout, line stays live
  }
  return null;
}

/** Mirror of rayRetestedAbove for the sell (support) line through troughs. */
function rayRetestedBelow(minima: Pivot[], l1: Pivot, l2: Pivot): Pivot | null {
  const slope = (l2.price - l1.price) / (l2.idx - l1.idx);
  const after = minima.filter(m => m.idx > l2.idx).sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < after.length; i++) {
    const m = after[i];
    const lineAtM = l1.price + slope * (m.idx - l1.idx);
    if (m.price > lineAtM + TOUCH_EPS) continue; // hasn't reached the line yet
    for (let j = i + 1; j < after.length; j++) {
      const n = after[j];
      const lineAtN = l1.price + slope * (n.idx - l1.idx);
      if (n.price > lineAtN + TOUCH_EPS) return m; // whipsaw — redraw from the failed-breakdown trough
    }
    return null; // broke down and held — confirmed breakdown, line stays live
  }
  return null;
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
/**
 * For a fixed H1, find the best H2: search CONFIRMED peaks to its right
 * (≥ MIN_GAP_MONTHS away from H1, and themselves ≥ MIN_GAP_MONTHS "old" —
 * see isConfirmed) from MOST RECENT backward, and take the first one whose
 * line is (a) clean between H1 and H2, (b) not subsequently subject to a
 * FAILED breakout (rayRetestedAbove), and (c) still positive when extrapolated
 * to today.
 *
 * This direct most-recent-confirmed-first search replaces an earlier
 * iterative ratchet that started from the EARLIEST valid H2 candidate and
 * "walked forward" only when it detected a retest. That approach got stuck:
 * for BOL (H1=Apr-2022 @ $1.92) the earliest candidate (Dec-2022, only 8mo
 * later) produced such a steep declining slope that it extrapolated NEGATIVE
 * by today — and a negative line never counts as "retested" by later peaks
 * (they're trivially above a negative number), so the ratchet never moved
 * past it and the search died. Searching newest-first lands directly on the
 * CORRECT pair (Apr-2022 → Mar-2025 @ $1.63 — confirmed against Tony's actual
 * live chart) without ever visiting the dead-end steep-decline candidates.
 */
function findH2ForH1(maxima: Pivot[], h1: Pivot, bars: PriceBar[], currentIdx: number): Pivot | null {
  const candidates = maxima
    .filter(m => m.idx > h1.idx + MIN_GAP_MONTHS && isConfirmed(m, currentIdx))
    .sort((a, b) => b.idx - a.idx); // most recent confirmed peak first

  for (const h2 of candidates) {
    if (!noHighViolation(bars, h1, h2)) continue;
    if (rayRetestedAbove(maxima, h1, h2)) continue; // failed breakout since — stale, skip
    if (lineAt(h1, h2, currentIdx) > 0) return h2;
  }
  return null;
}

function findBuyLine(bars: PriceBar[], maxima: Pivot[], currentIdx: number):
  { h1: Pivot; h2: Pivot | null; line: number | null } {

  if (maxima.length < 2) return { h1: maxima[0] ?? { idx: 0, price: bars[0].high, date: bars[0].date }, h2: null, line: null };

  // H1 must itself be CONFIRMED (≥ MIN_GAP_MONTHS old) — see isConfirmed.
  // Without this, a brand-new spike to a fresh near-ATH would hijack H1 the
  // moment it printed (BOL's Jan-2026 $1.94 — only 5mo old when checked
  // against Tony's live chart — would otherwise outrank Apr-2022's $1.92 as
  // "rightmost peak within 8% of the max"). Tony's chart proves he doesn't
  // redraw onto an unconfirmed fresh high — he keeps riding the older,
  // already-broken-out line. The threshold itself is still set from the full
  // (unfiltered) peak set so a fresh ATH still tightens the flat-top band
  // correctly; only the final candidate-pool is restricted to confirmed peaks.
  const confirmedMaxima = maxima.filter(m => isConfirmed(m, currentIdx));
  const globalMax = Math.max(...maxima.map(m => m.price));
  const thresh = globalMax * (1 - FUDGE);
  const baseH1 =
    [...confirmedMaxima].filter(m => m.price >= thresh).sort((a, b) => b.idx - a.idx)[0]
    ?? [...confirmedMaxima].sort((a, b) => b.price - a.price)[0]
    ?? [...maxima].sort((a, b) => b.price - a.price)[0];

  // ── Primary search: anchor on H1 = highest CONFIRMED peak, rightmost-within-8% ─
  // CONFIRMED CORRECT against Tony's actual BOL chart: he drew his live buy
  // line from H1 = Apr-2022 @ $1.92 (the rightmost CONFIRMED peak within 8% of
  // the all-time-high $2.06 from Jan-2022 — exactly what baseH1 now picks,
  // skipping the too-fresh Jan-2026 $1.94 spike) through H2 = Mar-2025 @ $1.63.
  // That line sits at ~$1.49 today — well below the $1.85 current price —
  // correctly flagging BOL as Bullish (matching Tony's BL2_Status = Y), even
  // though the raw extrapolated dollar value differs slightly from Tony's
  // $1.71 (immaterial — what matters is above/below).
  const allH1Candidates = [baseH1, ...[...confirmedMaxima].sort((a, b) => b.price - a.price)];
  for (const h1 of allH1Candidates) {
    const h2 = findH2ForH1(maxima, h1, bars, currentIdx);
    if (h2) return { h1, h2, line: lineAt(h1, h2, currentIdx) };
  }

  // ── Fallback: most-recent-confirmed-pair-first search ────────────────────
  // Covers edge cases where no clean line exists from any "highest peak"
  // anchor (e.g. the all-time-high region is too choppy/violated throughout).
  const h2Candidates = [...confirmedMaxima].sort((a, b) => b.idx - a.idx);
  for (const h2 of h2Candidates) {
    const h1Candidates = confirmedMaxima
      .filter(m => m.idx <= h2.idx - MIN_GAP_MONTHS)
      .sort((a, b) => b.idx - a.idx);
    for (const h1 of h1Candidates) {
      if (!noHighViolation(bars, h1, h2)) continue;
      if (rayRetestedAbove(maxima, h1, h2)) continue;
      const lineValue = lineAt(h1, h2, currentIdx);
      if (lineValue > 0) return { h1, h2, line: lineValue };
    }
  }

  // Complete fallback: no valid pair found
  return { h1: baseH1, h2: null, line: null };
}

/**
 * Find the sell line (L1→L2 through troughs). Mirror of findBuyLine.
 */
/** Mirror of findH2ForH1 — see its comment for the rationale of the direct,
 *  most-recent-confirmed-first search (replacing the old earliest-first ratchet
 *  that died on steep, soon-negative early candidates). */
function findL2ForL1(minima: Pivot[], l1: Pivot, bars: PriceBar[], currentIdx: number): Pivot | null {
  const candidates = minima
    .filter(m => m.idx > l1.idx + MIN_GAP_MONTHS && isConfirmed(m, currentIdx))
    .sort((a, b) => b.idx - a.idx); // most recent confirmed trough first

  for (const l2 of candidates) {
    if (!noLowViolation(bars, l1, l2)) continue;
    if (rayRetestedBelow(minima, l1, l2)) continue; // failed breakdown since — stale, skip
    if (lineAt(l1, l2, currentIdx) > 0) return l2;
  }
  return null;
}

function findSellLine(bars: PriceBar[], minima: Pivot[], currentIdx: number):
  { l1: Pivot; l2: Pivot | null; line: number | null } {

  if (minima.length < 2) return { l1: minima[0] ?? { idx: 0, price: bars[0].low, date: bars[0].date }, l2: null, line: null };

  // L1 must itself be CONFIRMED — mirror of findBuyLine's H1 fix (see its
  // comment). CONFIRMED against Tony's BOL chart: L1 = Nov-2023 (idx29) is
  // the RIGHTMOST of a near-identical flat-bottom trio (Sep/Oct/Nov-2023 all
  // ≈$1.05) — exactly the chartist's natural "rightmost of the tied lows"
  // pick, which the 8% flat-bottom band + isConfirmed reproduce together.
  const confirmedMinima = minima.filter(m => isConfirmed(m, currentIdx));
  const globalMin = Math.min(...minima.map(m => m.price));
  const thresh = globalMin * (1 + FUDGE);
  const baseL1 =
    [...confirmedMinima].filter(m => m.price <= thresh).sort((a, b) => b.idx - a.idx)[0]
    ?? [...confirmedMinima].sort((a, b) => a.price - b.price)[0]
    ?? [...minima].sort((a, b) => a.price - b.price)[0];

  // ── Primary search: anchor on L1 = lowest CONFIRMED trough, rightmost-within-8% ─
  // Mirror of findBuyLine's confirmed-correct approach (see comments there).
  // CONFIRMED CORRECT against Tony's actual BOL chart: L1 = Nov-2023 @ ~$1.03
  // → L2 = Aug-2025 @ $1.24 (Tony's chart: "01 Nov 2023 @ $1.10" / "01 Aug
  // 2025 @ $1.34" — same months, our adjusted-price reads differ slightly but
  // the resulting line ($1.35 today) sits well below the $1.85 current price,
  // correctly keeping BOL above its support → Bullish).
  const allL1Candidates = [baseL1, ...[...confirmedMinima].sort((a, b) => a.price - b.price)];
  for (const l1 of allL1Candidates) {
    const l2 = findL2ForL1(minima, l1, bars, currentIdx);
    if (l2) return { l1, l2, line: lineAt(l1, l2, currentIdx) };
  }

  // ── Fallback: most-recent-confirmed-pair-first search ────────────────────
  const l2Candidates = [...confirmedMinima].sort((a, b) => b.idx - a.idx);
  for (const l2 of l2Candidates) {
    const l1Candidates = confirmedMinima
      .filter(m => m.idx <= l2.idx - MIN_GAP_MONTHS)
      .sort((a, b) => b.idx - a.idx);
    for (const l1 of l1Candidates) {
      if (!noLowViolation(bars, l1, l2)) continue;
      if (rayRetestedBelow(minima, l1, l2)) continue;
      const lineValue = lineAt(l1, l2, currentIdx);
      if (lineValue > 0) return { l1, l2, line: lineValue };
    }
  }

  return { l1: baseL1, l2: null, line: null };
}

/**
 * Main 3PTL classification.
 */
function classify3PTL(bars: PriceBar[], currentPrice: number, lastMonthCloseOverride?: number | null): {
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
  // True only for "Bullish" and "between the lines" Josephine paths — these are
  // the cases where our calculated lines might be straddling a stock that is
  // ACTUALLY in long-term structural decline (a falling knife whose own falling
  // lines happen to bracket the current price). The falling-knife override below
  // re-checks these against the major peak to catch cases like AQZ (88% below its
  // 2022 high, "between the lines" only because both our lines are also collapsing).
  // "Josephine ↗" (above both lines, dipped from last close) and crossed-lines
  // basing patterns are explicitly NOT re-checked — those are genuine reversal/
  // consolidation setups, not knives.
  let checkFallingKnife = false;

  // NOTE: we deliberately do NOT special-case "lines have crossed" (buyLine <
  // sellLine) as an automatic Josephine/converged verdict. CONFIRMED WRONG via
  // BRK on 2026-06-08: Tony's own chart anchors — H1=$1.75 (Jul'21), H2=$0.48
  // (Dec'25), L1=$0.37 (Aug'25), L2=$0.41 (Feb'26), all EXACT matches to raw
  // monthly CLOSE prices (confirming Tony reads closes, not highs/lows) —
  // produce buyLine≈$0.31 and sellLine≈$0.44: the lines HAVE crossed on his
  // chart too. Yet Tony reads BRK as Bullish, because price ($0.50) has broken
  // cleanly above BOTH lines. A crossed-lines state with price decisively above
  // both is exactly a confirmed breakout through a converged base — the bullish
  // case the Bible describes — not an automatic "still consolidating" Josephine.
  // The normal aboveBuy && aboveSell branch below already handles this state
  // correctly (and still runs the literal m-o-m Josephine check on top of it);
  // a crossed-lines state where price is NOT above both falls through to the
  // existing belowSell/between-the-lines branches, which is the right call too.

  const aboveBuy  = buyLine  !== null && currentPrice >= buyLine  * BREAKOUT_BUF;
  const aboveSell = sellLine !== null && currentPrice >= sellLine;
  const belowSell = sellLine !== null && currentPrice < sellLine;

  if (aboveBuy && aboveSell) {
    // Above both lines — check for Josephine using Tony's Bible rule, LITERALLY:
    // "If a stock has positive sentiment ... BUT it's in a downward trend (ie
    // today's price lower than the price at the end of the previous month),
    // then it's a 'Josephine'." No magnitude threshold — ANY decline counts.
    //
    // `lastMonthCloseOverride` is derived from DAILY data by
    // `fetchLastCompletedMonthClose` — NOT `bars[n-2].close`. CONFIRMED BUG
    // (KAR, 2026-06-08): `fetchMonthly`'s trailing bars are corrupted near a
    // month boundary — Yahoo backfills the live price into the "last month"
    // slot too, so `bars[n-2].close` reads $1.945 (= live price) instead of
    // May's true close of $1.955. That 0.5% difference IS the Josephine signal
    // ("today's $1.945 < last month's $1.955") — the corrupted data hid it
    // entirely. See `fetchLastCompletedMonthClose` for the full writeup.
    // We fall back to `bars[n-2].close` only if the daily-data fetch failed.
    const lastMonthClose = lastMonthCloseOverride ?? (n >= 2 ? bars[n - 2].close : 0);
    const priceVsLastMonth = lastMonthClose > 0 ? (currentPrice - lastMonthClose) / lastMonthClose : 0;
    if (lastMonthClose > 0 && currentPrice < lastMonthClose) {
      sentiment = "Josephine";
      note = `Josephine ↗: above both lines but price ${currentPrice.toFixed(3)} is ${(priceVsLastMonth * 100).toFixed(1)}% below last month's close ${lastMonthClose.toFixed(3)} — "not tonight, Josephine"`;
    } else {
      sentiment = "Bullish";
      note = `Bullish: price ${currentPrice.toFixed(3)} above buy line ${buyLine?.toFixed(3)} and sell line ${sellLine?.toFixed(3)}`;
    }
    checkFallingKnife = true;
  } else if (belowSell) {
    // Definitively below the sell line — Bearish regardless of buy line
    sentiment = "Bearish";
    note = `Bearish: price ${currentPrice.toFixed(3)} below sell line ${sellLine!.toFixed(3)}`;
  } else if (aboveSell) {
    // Above sell line but below buy line — Josephine (between the lines).
    // CAUTION: this is exactly the bucket a falling knife lands in when its own
    // collapsing trendlines happen to bracket the current price (AQZ: -88% off
    // its 2022 high, yet "between" our two ever-falling lines). Flag it for the
    // falling-knife re-check below — a real "between the lines" basing stock will
    // pass through unchanged; an active multi-year collapse will be reclassified.
    sentiment = "Josephine";
    note = `Josephine: above sell line ${sellLine!.toFixed(3)} but below buy line ${buyLine?.toFixed(3) ?? "n/a"} — between the lines`;
    checkFallingKnife = true;
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
  // Applies whenever the path was flagged via checkFallingKnife — i.e. "Bullish"
  // (crossed buy line) or "between the lines" Josephine (a bucket a falling knife
  // can land in when its own collapsing trendlines bracket the price — AQZ was
  // showing -88% off its 2022 high yet labelled a neutral "between the lines"
  // Josephine because BOTH our calculated lines had also collapsed with it).
  // "Josephine ↗" and crossed/converged-lines basing patterns are NOT re-checked —
  // those are confirmed-positive or genuine-reversal setups, not knives.
  if (checkFallingKnife && maxima.length >= 1) {
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

    // "Confirmed reversal" escape hatch for the SOFT (sustained-decline) branch only.
    // Tony's Bible explicitly frames the falling-knife caution in terms of "3
    // consecutive higher lows" confirming a genuine new uptrend (see comment above).
    // We check that concretely: are the last 3 CONFIRMED troughs strictly rising?
    // CONFIRMED against the reference set (Jun-2026): AMI bottomed in 2023 @ ~$0.08
    // and has printed three confirmed higher lows since (0.138 → 0.165 → 0.170) —
    // a textbook reversal — yet sits 39% below its Feb-2022 high of $0.50 (53mo
    // ago), which the blunt %-below-peak/time check alone would (wrongly) flag as
    // "sustained decline, uptrend not confirmed." AQZ, by contrast, shows NO such
    // pattern (its last 3 confirmed lows are still falling: 2.57 → 2.32 → 2.09) —
    // a genuine knife, correctly left subject to the override. This hatch deliberately
    // does NOT apply to the hard 60% knife rule below — Tony's "NEVER catch a falling
    // knife" is unconditional at that depth regardless of any recent higher lows.
    const confirmedMinima = minima.filter(m => isConfirmed(m, currentIdx));
    const last3Lows = confirmedMinima.slice(-3);
    const confirmedReversal = last3Lows.length === 3 &&
      last3Lows[0].price < last3Lows[1].price && last3Lows[1].price < last3Lows[2].price;

    if (pctBelowHighest >= 0.60) {
      // Falling knife — 60%+ below the major peak in the 5yr dataset.
      // Threshold lowered from 70%: SPK (-69%), AIZ (-65%), PPT (-62%) are all
      // classic falling knives that were slipping past the 70% cutoff.
      sentiment = "Bearish";
      note = `Falling knife: ${(pctBelowHighest * 100).toFixed(0)}% below major peak ${highestPeak.price.toFixed(3)} (${mthsSinceHighest}mo ago). Long-term downtrend not reversed.`;
    } else if (pctBelowHighest >= 0.35 && mthsSinceHighest >= 18 && !confirmedReversal) {
      // Sustained long-term decline: >35% below major peak for >18 months, AND no
      // confirmed reversal (3 consecutive higher confirmed lows) yet established.
      // The stock has not recovered to a new high for over 1.5 years — structural
      // downtrend is not yet confirmed reversed even if technically above both lines.
      // BPT-type pattern: peaked 27mo ago, 38% below — classic cautionary.
      sentiment = "Josephine";
      note = `Caution: ${(pctBelowHighest * 100).toFixed(0)}% below major peak ${highestPeak.price.toFixed(3)} (${mthsSinceHighest}mo ago) — sustained decline, uptrend not confirmed.`;
    } else if (mthsSinceRecent <= 36 && pctBelowRecent >= 0.40 && !confirmedReversal) {
      // Significant recent decline — caution
      sentiment = "Josephine";
      note = `Caution: ${(pctBelowRecent * 100).toFixed(0)}% below recent peak ${recentPeak.price.toFixed(3)} (${mthsSinceRecent}mo ago) — wait for 3 confirmed higher lows before buying.`;
    }
  }

  return { sentiment, buyLine, sellLine, h1, h2, l1, l2, note };
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

async function processCode(code: string) {
  const [bars, currentPrice, lastMonthClose] = await Promise.all([
    fetchMonthly(code), fetchCurrentPrice(code), fetchLastCompletedMonthClose(code),
  ]);
  if (bars.length < 12) return { sentiment: "Josephine" as Sentiment, error: "insufficient data", months: bars.length };
  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify3PTL(bars, price, lastMonthClose);
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
  const [bars, currentPrice, lastMonthClose] = await Promise.all([
    fetchMonthly(code), fetchCurrentPrice(code), fetchLastCompletedMonthClose(code),
  ]);
  const base = { code, runtime: "edge", monthly_bars: bars.length, current_price: currentPrice, last_month_close: lastMonthClose };
  if (bars.length < 12) return Response.json({ ...base, error: "insufficient data" });

  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify3PTL(bars, price, lastMonthClose);

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
