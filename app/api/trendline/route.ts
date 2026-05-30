/**
 * POST /api/trendline  { codes: string[] }  — batch 3PTL calculation (≤25)
 * GET  /api/trendline?code=SYL             — debug single ticker
 *
 * Tony Kynaston's 3-Point Trendline (3PTL) on monthly bar charts:
 *
 *  BULLISH (+2): Stock has either—
 *    a) 3 consecutive RISING pivot lows (higher-low uptrend) AND price > the uptrend line
 *    b) broken ABOVE the last downtrend line (3 lower highs)
 *
 *  BEARISH (-1): 3 consecutive FALLING pivot highs (lower-high downtrend) AND price below the line
 *
 *  JOSEPHINE (0): everything in between — forming, unclear, or between lines
 *
 * Data: Yahoo Finance 5yr monthly (server-side call, confirmed working from edge).
 */

export const runtime = "edge";

const MARKIT_BASE = "https://asx.api.markitdigital.com/asx-research/1.0";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

// ── Price data ────────────────────────────────────────────────────────────────

interface PricePoint { date: string; close: number }

async function fetchMonthlyPrices(code: string): Promise<PricePoint[]> {
  // 5 year range gives ~60 monthly bars — enough for reliable 3PTL
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1mo&range=5y&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": HEADERS["User-Agent"], Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return [];
    const timestamps = result.timestamp as number[];
    const closes = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!timestamps || !closes) return [];
    return timestamps
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 7), close: closes[i] }))
      .filter((p) => p.close != null && !isNaN(p.close) && p.close > 0);
  } catch { return []; }
}

async function fetchCurrentPrice(code: string): Promise<number | null> {
  // 5-day daily data — last close is today's or most recent
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1d&range=5d&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": HEADERS["User-Agent"], Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return null;
    const closes = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!closes) return null;
    // Return last non-null close
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && !isNaN(closes[i]) && closes[i] > 0) return closes[i];
    }
    return null;
  } catch { return null; }
}

// ── Pivot detection ────────────────────────────────────────────────────────────

interface Pivot { idx: number; price: number; date: string }

/**
 * Find pivot highs/lows using a 3-bar lookback on each side.
 * A pivot high: highest bar in a 7-bar window centred on itself.
 * A pivot low:  lowest  bar in a 7-bar window centred on itself.
 */
function findPivots(prices: PricePoint[], lookback = 3): { highs: Pivot[]; lows: Pivot[] } {
  const closes = prices.map((p) => p.close);
  const n = closes.length;
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = lookback; i < n - lookback; i++) {
    const window = closes.slice(i - lookback, i + lookback + 1);
    if (closes[i] === Math.max(...window)) highs.push({ idx: i, price: closes[i], date: prices[i].date });
    if (closes[i] === Math.min(...window)) lows.push({ idx: i, price: closes[i], date: prices[i].date });
  }
  return { highs, lows };
}

/** Linear regression through pivot points, extrapolated to targetIdx. */
function trendlineAt(pivots: Pivot[], targetIdx: number): number | null {
  if (pivots.length < 2) return null;
  const n = pivots.length;
  const meanX = pivots.reduce((s, p) => s + p.idx, 0) / n;
  const meanY = pivots.reduce((s, p) => s + p.price, 0) / n;
  const num = pivots.reduce((s, p) => s + (p.idx - meanX) * (p.price - meanY), 0);
  const den = pivots.reduce((s, p) => s + (p.idx - meanX) ** 2, 0);
  if (den === 0) return meanY;
  const slope = num / den;
  return slope * (targetIdx - meanX) + meanY;
}

// ── 3PTL classification ───────────────────────────────────────────────────────

type Sentiment = "Bullish" | "Josephine" | "Bearish";

interface TrendlineResult {
  sentiment: Sentiment;
  currentPrice: number;
  sellLine: number | null;  // downtrend resistance (lower highs)
  buyLine: number | null;   // uptrend support (higher lows)
  uptrendActive: boolean;   // last 3 lows are rising
  downtrendActive: boolean; // last 3 highs are falling
  pivotHighCount: number;
  pivotLowCount: number;
  monthsOfData: number;
  note?: string;
}

function classify3PTL(prices: PricePoint[], currentPrice: number): TrendlineResult {
  const n = prices.length;
  const currentIdx = n; // one step beyond the last bar
  const { highs, lows } = findPivots(prices, 3);

  // ── Detect uptrend: last 3 pivot lows are each HIGHER than the previous ──
  const last3Lows = lows.slice(-3);
  const uptrendActive = last3Lows.length === 3 &&
    last3Lows[0].price < last3Lows[1].price && last3Lows[1].price < last3Lows[2].price;

  // ── Detect downtrend: last 3 pivot highs are each LOWER than the previous ──
  const last3Highs = highs.slice(-3);
  const downtrendActive = last3Highs.length === 3 &&
    last3Highs[0].price > last3Highs[1].price && last3Highs[1].price > last3Highs[2].price;

  const buyLine  = uptrendActive   ? trendlineAt(last3Lows,  currentIdx) : null;
  const sellLine = downtrendActive ? trendlineAt(last3Highs, currentIdx) : null;

  let sentiment: Sentiment = "Josephine";
  let note = "";

  if (uptrendActive && buyLine !== null) {
    // In confirmed uptrend: Bullish if price above the rising support line
    if (currentPrice >= buyLine) {
      sentiment = "Bullish";
      note = `Price ${currentPrice.toFixed(2)} ≥ rising support ${buyLine.toFixed(2)}`;
    } else {
      sentiment = "Josephine";
      note = `Uptrend forming but price ${currentPrice.toFixed(2)} < support ${buyLine.toFixed(2)} — weakening`;
    }
  } else if (downtrendActive && sellLine !== null) {
    // In confirmed downtrend: Bullish if price broke ABOVE the falling resistance
    if (currentPrice > sellLine) {
      sentiment = "Bullish";
      note = `Broke above downtrend resistance ${sellLine.toFixed(2)} — confirmed uptrend`;
    } else {
      sentiment = "Bearish";
      note = `Price ${currentPrice.toFixed(2)} below falling resistance ${sellLine.toFixed(2)}`;
    }
  } else {
    // Neither clear uptrend nor clear downtrend — look at simpler signals
    // If we have at least 2 rising lows, treat as likely uptrend (forming)
    const last2Lows = lows.slice(-2);
    if (last2Lows.length === 2 && last2Lows[0].price < last2Lows[1].price) {
      const approxBuy = trendlineAt(last2Lows, currentIdx);
      if (approxBuy !== null && currentPrice >= approxBuy) {
        sentiment = "Bullish";
        note = `2 rising lows (3rd not yet confirmed), price above approx support ${approxBuy.toFixed(2)}`;
      } else {
        sentiment = "Josephine";
        note = "Rising lows forming but price below support";
      }
    } else if (last2Lows.length === 2 && last2Lows[0].price > last2Lows[1].price) {
      const approxSell = trendlineAt(highs.slice(-2), currentIdx);
      if (approxSell !== null && currentPrice < approxSell) {
        sentiment = "Bearish";
        note = `2 falling lows (3rd not yet confirmed), below resistance ${approxSell?.toFixed(2)}`;
      } else {
        sentiment = "Josephine";
        note = "Falling lows but price held above resistance — mixed";
      }
    } else {
      note = "Insufficient pivot data for 3PTL — defaulting to Josephine";
    }
  }

  return {
    sentiment, currentPrice, sellLine, buyLine,
    uptrendActive, downtrendActive,
    pivotHighCount: highs.length, pivotLowCount: lows.length,
    monthsOfData: prices.length, note,
  };
}

// ── MarkitDigital entity lookup ───────────────────────────────────────────────

async function getEntityXid(code: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${MARKIT_BASE}/search/predictive?searchText=${encodeURIComponent(code)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const items = (data?.data as Record<string, unknown>)?.items as Record<string, unknown>[] ?? [];
    for (const item of items) {
      if (String(item.symbol ?? "").toUpperCase() === code.toUpperCase()) {
        return String(item.xidEntity ?? "");
      }
    }
    return null;
  } catch { return null; }
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

async function processCode(code: string) {
  const [monthly, currentPrice] = await Promise.all([
    fetchMonthlyPrices(code),
    fetchCurrentPrice(code),
  ]);

  if (monthly.length < 12) {
    return { sentiment: "Josephine" as Sentiment, error: "insufficient price data", months: monthly.length };
  }

  const price = currentPrice ?? monthly[monthly.length - 1].close;
  return classify3PTL(monthly, price);
}

// ── POST — batch ──────────────────────────────────────────────────────────────

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
  const code = (searchParams.get("code") ?? "SYL").toUpperCase();

  const [monthly, currentPrice] = await Promise.all([
    fetchMonthlyPrices(code),
    fetchCurrentPrice(code),
  ]);

  const result: Record<string, unknown> = {
    code, runtime: "edge",
    monthly_count: monthly.length,
    current_price: currentPrice,
    oldest_bar: monthly[0]?.date,
    newest_bar: monthly[monthly.length - 1]?.date,
    last_6_bars: monthly.slice(-6),
  };

  if (monthly.length < 12) {
    return Response.json({ ...result, error: "insufficient price data" });
  }

  const price = currentPrice ?? monthly[monthly.length - 1].close;
  const { highs, lows } = findPivots(monthly, 3);
  result.pivot_highs = highs.slice(-5);
  result.pivot_lows  = lows.slice(-5);
  result.trendline   = classify3PTL(monthly, price);

  return Response.json(result);
}
