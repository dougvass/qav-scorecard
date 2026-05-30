/**
 * GET /api/trendline?code=SYL
 *
 * Fetches monthly close prices for an ASX stock and calculates the 3PTL
 * (3-Point Trendline) to determine Bullish / Josephine / Bearish.
 *
 * Price data: tries Yahoo Finance monthly API, then MarkitDigital patterns.
 * Returns full diagnostic info so we can tune the algorithm.
 *
 * POST /api/trendline  { codes: string[] }  — batch (≤25 codes)
 * Returns: Record<string, { sentiment: "Bullish"|"Josephine"|"Bearish", ... }>
 */

export const runtime = "edge";

const MARKIT_BASE = "https://asx.api.markitdigital.com/asx-research/1.0";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

// ── Step 1: get entityXid and security xid for a code ────────────────────────

async function getXids(code: string): Promise<{ xid: string; xidEntity: string } | null> {
  try {
    const res = await fetch(
      `${MARKIT_BASE}/search/predictive?searchText=${encodeURIComponent(code)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const items = (data?.data as Record<string, unknown>)?.items as Record<string, unknown>[] ?? [];
    for (const item of items) {
      const sym = String(item.symbol ?? "").toUpperCase();
      if (sym === code.toUpperCase()) {
        return { xid: String(item.xid ?? ""), xidEntity: String(item.xidEntity ?? "") };
      }
    }
    return null;
  } catch { return null; }
}

// ── Step 2: fetch monthly closes ──────────────────────────────────────────────

interface PricePoint { date: string; close: number }

async function fetchMonthlyYahoo(code: string): Promise<PricePoint[] | null> {
  // Yahoo Finance chart API — 3 years of monthly data
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=1mo&range=4y&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const result = (json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[];
    if (!result?.[0]) return null;
    const timestamps = result[0].timestamp as number[];
    const closes = ((result[0].indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!timestamps || !closes) return null;
    return timestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString().slice(0, 7),
      close: closes[i],
    })).filter((p) => p.close != null && !isNaN(p.close));
  } catch { return null; }
}

async function fetchMonthlyMarkit(xid: string): Promise<PricePoint[] | null> {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 4 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Try several MarkitDigital price history URL patterns
  const candidates = [
    `${MARKIT_BASE}/timeseries/close?xids=${xid}&startDate=${start}&endDate=${end}&frequency=monthly`,
    `${MARKIT_BASE}/data/timeseries?xid=${xid}&startDate=${start}&endDate=${end}&frequency=monthly`,
    `${MARKIT_BASE}/charts/history?xid=${xid}&startDate=${start}&endDate=${end}&frequency=monthly`,
    `${MARKIT_BASE}/markets/timeseries?xid=${xid}&startDate=${start}&endDate=${end}&frequency=monthly`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const json = await res.json() as Record<string, unknown>;
      // Try to extract close prices from common response shapes
      const data = json?.data ?? json;
      if (Array.isArray(data)) {
        const pts = (data as Record<string, unknown>[]).map((d) => ({
          date: String(d.date ?? d.period ?? d.time ?? ""),
          close: Number(d.close ?? d.value ?? d.price ?? 0),
        })).filter((p) => p.date && p.close > 0);
        if (pts.length > 6) return pts;
      }
    } catch { /* try next */ }
  }
  return null;
}

// ── 3PTL algorithm ────────────────────────────────────────────────────────────

type Sentiment = "Bullish" | "Josephine" | "Bearish";

interface PivotPoint { idx: number; price: number }

function findPivots(prices: number[], lookback = 2): { highs: PivotPoint[]; lows: PivotPoint[] } {
  const highs: PivotPoint[] = [];
  const lows: PivotPoint[] = [];
  for (let i = lookback; i < prices.length - lookback; i++) {
    const slice = prices.slice(i - lookback, i + lookback + 1);
    const isHigh = prices[i] === Math.max(...slice);
    const isLow  = prices[i] === Math.min(...slice);
    if (isHigh) highs.push({ idx: i, price: prices[i] });
    if (isLow)  lows.push({ idx: i, price: prices[i] });
  }
  return { highs, lows };
}

function extrapolate(pivots: PivotPoint[], toIdx: number): number | null {
  if (pivots.length < 2) return null;
  const pts = pivots.slice(-3); // use last 3 (or 2 if only 2 exist)
  // Linear regression through pivot points
  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p.idx, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.price, 0) / n;
  const slope = pts.reduce((s, p) => s + (p.idx - meanX) * (p.price - meanY), 0) /
                pts.reduce((s, p) => s + (p.idx - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  return slope * toIdx + intercept;
}

function calculate3PTL(prices: PricePoint[]): {
  sentiment: Sentiment;
  sellLine: number | null;
  buyLine: number | null;
  currentPrice: number;
  pivotHighs: number;
  pivotLows: number;
} {
  const closes = prices.map((p) => p.close);
  const current = closes[closes.length - 1];
  const currentIdx = closes.length - 1;

  const { highs, lows } = findPivots(closes, 2);
  const sellLine = extrapolate(highs, currentIdx);
  const buyLine  = extrapolate(lows,  currentIdx);

  let sentiment: Sentiment = "Josephine";
  if (sellLine !== null && current > sellLine) sentiment = "Bullish";
  else if (buyLine !== null && current < buyLine) sentiment = "Bearish";

  return { sentiment, sellLine, buyLine, currentPrice: current, pivotHighs: highs.length, pivotLows: lows.length };
}

// ── Full pipeline for one code ────────────────────────────────────────────────

async function processCode(code: string) {
  const xids = await getXids(code);
  if (!xids) return { sentiment: "Josephine" as Sentiment, error: "entityXid not found" };

  // Try Yahoo first (confirmed data source), then Markit
  let prices = await fetchMonthlyYahoo(code);
  let source = "yahoo";
  if (!prices || prices.length < 12) {
    prices = await fetchMonthlyMarkit(xids.xid);
    source = "markit";
  }
  if (!prices || prices.length < 12) {
    return { sentiment: "Josephine" as Sentiment, error: "insufficient price data", xid: xids.xid };
  }

  const result = calculate3PTL(prices);
  return { ...result, source, months: prices.length, xid: xids.xid };
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

// ── GET — debug single ticker ─────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "SYL").toUpperCase();

  const result: Record<string, unknown> = { code, runtime: "edge" };

  // Xids
  const xids = await getXids(code);
  result.xids = xids;
  if (!xids) return Response.json({ ...result, error: "entityXid not found" });

  // Yahoo monthly
  const yahoo = await fetchMonthlyYahoo(code);
  result.yahoo_months = yahoo?.length ?? 0;
  result.yahoo_sample = yahoo?.slice(-6) ?? null;

  // MarkitDigital patterns
  const markit = await fetchMonthlyMarkit(xids.xid);
  result.markit_months = markit?.length ?? 0;
  result.markit_sample = markit?.slice(-6) ?? null;

  // 3PTL calculation (use whichever source has more data)
  const prices = (yahoo?.length ?? 0) >= (markit?.length ?? 0) ? yahoo : markit;
  result.price_source = prices === yahoo ? "yahoo" : "markit";
  result.total_months = prices?.length ?? 0;

  if (prices && prices.length >= 12) {
    result.trendline = calculate3PTL(prices);
  } else {
    result.trendline = null;
    result.error = "insufficient price data (<12 months)";
  }

  return Response.json(result);
}
