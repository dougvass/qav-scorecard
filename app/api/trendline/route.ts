/**
 * 3PTL (3-Point Trendline) API — Tony Kynaston's QAV methodology
 *
 * Uses monthly OHLC bars from Yahoo Finance:
 *   • Pivot HIGHS are detected on the monthly HIGH price (candle top)
 *   • Pivot LOWS  are detected on the monthly LOW  price (candle bottom)
 * This matches how Tony draws lines on the monthly bar chart.
 *
 * Classification:
 *   DOWNTREND (3 lower monthly HIGHS):
 *     Bearish  — price still below falling resistance line
 *     Bullish  — price broke above resistance by ≥2% (confirmed breakout)
 *
 *   UPTREND (3 higher monthly LOWS):
 *     Bullish   — price above rising support line
 *     Josephine — price fell back below rising support (weakening)
 *
 *   Downtrend takes priority over uptrend when both present.
 *
 * POST /api/trendline { codes: string[] }  — batch ≤25
 * GET  /api/trendline?code=SYL             — debug
 */

export const runtime = "edge";

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/** Minimum % price must exceed downtrend resistance to count as a confirmed breakout */
const BREAKOUT_BUFFER = 1.02;

// ── Data types ─────────────────────────────────────────────────────────────────

interface PriceBar { date: string; open: number; high: number; low: number; close: number }
interface Pivot    { idx: number; price: number; date: string }

// ── Yahoo Finance fetch ────────────────────────────────────────────────────────

async function fetchBars(code: string, range: string, interval: string): Promise<PriceBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=${interval}&range=${range}&includePrePost=false`;
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
      open:  q.open?.[i]  ?? 0,
      high:  q.high?.[i]  ?? 0,
      low:   q.low?.[i]   ?? 0,
      close: q.close?.[i] ?? 0,
    })).filter((b) => b.close > 0 && b.high > 0 && b.low > 0);
  } catch { return []; }
}

async function fetchMonthly(code: string): Promise<PriceBar[]> {
  return fetchBars(code, "5y", "1mo");
}

async function fetchCurrentPrice(code: string): Promise<number | null> {
  const bars = await fetchBars(code, "5d", "1d");
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].close > 0) return bars[i].close;
  }
  return null;
}

// ── Pivot detection on OHLC ────────────────────────────────────────────────────

/** Pivot HIGH: monthly HIGH is higher than any HIGH in the surrounding window */
function findPivotHighs(bars: PriceBar[], lookback = 3): Pivot[] {
  const n = bars.length;
  return bars.flatMap((bar, i) => {
    if (i < lookback || i >= n - lookback) return [];
    const window = bars.slice(i - lookback, i + lookback + 1).map((b) => b.high);
    return bar.high === Math.max(...window) ? [{ idx: i, price: bar.high, date: bar.date }] : [];
  });
}

/** Pivot LOW: monthly LOW is lower than any LOW in the surrounding window */
function findPivotLows(bars: PriceBar[], lookback = 3): Pivot[] {
  const n = bars.length;
  return bars.flatMap((bar, i) => {
    if (i < lookback || i >= n - lookback) return [];
    const window = bars.slice(i - lookback, i + lookback + 1).map((b) => b.low);
    return bar.low === Math.min(...window) ? [{ idx: i, price: bar.low, date: bar.date }] : [];
  });
}

/** Fit a line through pivot points and extrapolate to targetIdx */
function trendlineAt(pivots: Pivot[], targetIdx: number): number | null {
  if (pivots.length < 2) return null;
  const n = pivots.length;
  const mx = pivots.reduce((s, p) => s + p.idx,   0) / n;
  const my = pivots.reduce((s, p) => s + p.price, 0) / n;
  const num = pivots.reduce((s, p) => s + (p.idx - mx) * (p.price - my), 0);
  const den = pivots.reduce((s, p) => s + (p.idx - mx) ** 2, 0);
  if (den === 0) return my;
  const slope = num / den;
  return slope * (targetIdx - mx) + my;
}

// ── 3PTL classification ────────────────────────────────────────────────────────

type Sentiment = "Bullish" | "Josephine" | "Bearish";

function classify(bars: PriceBar[], currentPrice: number): {
  sentiment: Sentiment;
  currentPrice: number;
  sellLine: number | null;
  buyLine: number | null;
  downtrendActive: boolean;
  uptrendActive: boolean;
  pivotHighs: Pivot[];
  pivotLows: Pivot[];
  note: string;
} {
  const n = bars.length;
  const currentIdx = n;

  const pivotHighs = findPivotHighs(bars, 3);
  const pivotLows  = findPivotLows(bars,  3);

  const last3H = pivotHighs.slice(-3);
  const last3L = pivotLows.slice(-3);

  // Downtrend: last 3 monthly HIGHS are each lower than previous
  const downtrendActive = last3H.length === 3 &&
    last3H[0].price > last3H[1].price && last3H[1].price > last3H[2].price;

  // Uptrend: last 3 monthly LOWS are each higher than previous
  const uptrendActive = last3L.length === 3 &&
    last3L[0].price < last3L[1].price && last3L[1].price < last3L[2].price;

  const sellLine = downtrendActive ? trendlineAt(last3H, currentIdx) : null;
  const buyLine  = uptrendActive   ? trendlineAt(last3L, currentIdx) : null;

  let sentiment: Sentiment = "Josephine";
  let note = "";

  // ── Priority 1: active DOWNTREND — requires convincing breakout to flip Bullish ──
  if (downtrendActive && sellLine !== null) {
    if (currentPrice >= sellLine * BREAKOUT_BUFFER) {
      sentiment = "Bullish";
      note = `Broke above downtrend resistance ${sellLine.toFixed(2)} by ≥2% (price ${currentPrice.toFixed(2)}) — confirmed uptrend`;
    } else {
      sentiment = "Bearish";
      note = `Downtrend active: price ${currentPrice.toFixed(2)} at/below falling resistance ${sellLine.toFixed(2)} (needs ${(sellLine * BREAKOUT_BUFFER).toFixed(2)} to confirm)`;
    }
  }
  // ── Priority 2: active UPTREND (only if no downtrend) ──
  else if (uptrendActive && buyLine !== null) {
    if (currentPrice >= buyLine) {
      sentiment = "Bullish";
      note = `Uptrend active: price ${currentPrice.toFixed(2)} ≥ rising support ${buyLine.toFixed(2)}`;
    } else {
      sentiment = "Josephine";
      note = `Uptrend weakening: price ${currentPrice.toFixed(2)} fell below support ${buyLine.toFixed(2)}`;
    }
  }
  // ── Priority 3: partial signals (2 pivots) ──
  else {
    const last2H = pivotHighs.slice(-2);
    const last2L = pivotLows.slice(-2);
    const partialDowntrend = last2H.length === 2 && last2H[0].price > last2H[1].price;
    const partialUptrend   = last2L.length === 2 && last2L[0].price < last2L[1].price;

    if (partialDowntrend) {
      const approxSell = trendlineAt(last2H, currentIdx);
      if (approxSell !== null && currentPrice >= approxSell * BREAKOUT_BUFFER) {
        sentiment = "Bullish";
        note = `Partial downtrend (2 highs) — price broke above ${approxSell.toFixed(2)}`;
      } else {
        sentiment = "Bearish";
        note = `Partial downtrend (2 lower highs) — 3rd high not yet confirmed`;
      }
    } else if (partialUptrend) {
      const approxBuy = trendlineAt(last2L, currentIdx);
      if (approxBuy !== null && currentPrice >= approxBuy) {
        sentiment = "Bullish";
        note = `Partial uptrend (2 higher lows) — price above support ${approxBuy.toFixed(2)}`;
      } else {
        sentiment = "Josephine";
        note = `Partial uptrend (2 higher lows) — price below support`;
      }
    } else {
      note = `Insufficient pivot data — ${pivotHighs.length} highs, ${pivotLows.length} lows`;
    }
  }

  return {
    sentiment, currentPrice, sellLine, buyLine,
    downtrendActive, uptrendActive,
    pivotHighs: pivotHighs.slice(-5),
    pivotLows:  pivotLows.slice(-5),
    note,
  };
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

async function processCode(code: string) {
  const [bars, currentPrice] = await Promise.all([fetchMonthly(code), fetchCurrentPrice(code)]);
  if (bars.length < 12) {
    return { sentiment: "Josephine" as Sentiment, error: "insufficient data", months: bars.length };
  }
  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify(bars, price);
  return { ...result, months: bars.length };
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
  const [bars, currentPrice] = await Promise.all([fetchMonthly(code), fetchCurrentPrice(code)]);

  const base = { code, runtime: "edge", monthly_bars: bars.length, current_price: currentPrice };
  if (bars.length < 12) return Response.json({ ...base, error: "insufficient price data" });

  const price = currentPrice ?? bars[bars.length - 1].close;
  const result = classify(bars, price);

  return Response.json({
    ...base,
    oldest: bars[0]?.date,
    newest: bars[bars.length - 1]?.date,
    last_6: bars.slice(-6).map((b) => ({ date: b.date, high: b.high, low: b.low, close: b.close })),
    ...result,
  });
}
