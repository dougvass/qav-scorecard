/**
 * Total return since a date — the data behind the buy-list track record.
 *
 *   POST /api/total-return  { items: [{ code, since: "YYYY-MM-DD" }] }   <= 25 items
 *
 * For each code: the return from the close of the first session on or after
 * `since` to the latest close, twice — on Yahoo's dividend-adjusted closes
 * (total return, dividends reinvested) and on raw closes (price only). The
 * same window is measured on the S&P/ASX 200 Gross Total Return index, so each
 * stock sits beside what the market did over exactly its own period.
 *
 * Doug, 2026-11-15, asked whether the QAV stocks could be tracked on total
 * return "including dividends and capital returns", and took both halves of the
 * answer: the 1/3/5-year columns (lib/total-return.ts, on the 3PTL run) and
 * this — every stock measured from the day it joined the buy list, which is the
 * only version that says whether a high QAV score is FOLLOWED by a better
 * return.
 *
 * `since` is a date the scorecard recorded a score on. The price a buyer could
 * actually have had is that day's close or later, never earlier, so the start
 * is the first session ON OR AFTER it. A stock that joined today has no later
 * close and returns null rather than a zero.
 *
 * Market data only: nothing from the Stock Doctor export reaches this route but
 * the codes themselves.
 */
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/** S&P/ASX 200 Gross Total Return — the accumulation index, dividends included.
 *  (^AXJO is the price index and would flatter every dividend payer.) */
const BENCHMARK = "^AXJT";

interface DayPoint { d: string; close: number; adj: number }

export interface TotalReturnResult {
  since: string;
  /** The session the measurement starts on, and its raw close. */
  startDate: string | null;
  startClose: number | null;
  endDate: string | null;
  endClose: number | null;
  /** Percent, one decimal. null when there has been no session since `since`. */
  total: number | null;
  price: number | null;
  error?: string;
}

function yahooSymbol(code: string): string {
  return /^[A-Z0-9]{1,6}$/.test(code) ? `${code}.AX` : code;
}

/** "YYYY-MM-DD" for a Yahoo bar in the exchange's own calendar. */
function dayOf(tsSeconds: number, gmtoffset: number): string {
  const d = new Date((tsSeconds + gmtoffset) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Daily closes, raw and adjusted, from ten days before `since` to now. */
async function fetchDaily(symbol: string, since: string): Promise<DayPoint[]> {
  const start = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) - 10 * 86400;
  const end = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1d&period1=${start}&period2=${end}&includePrePost=false&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(9_000) });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const r = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!r) return [];
    const ts = r.timestamp as number[] | undefined;
    const off = ((r.meta as Record<string, unknown>)?.gmtoffset as number) ?? 0;
    const closes = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[] | undefined;
    const adjs = ((r.indicators as Record<string, unknown>)?.adjclose as Record<string, unknown>[])?.[0]?.adjclose as number[] | undefined;
    if (!ts || !closes) return [];
    const byDay = new Map<string, DayPoint>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      const a = adjs?.[i];
      const d = dayOf(ts[i], off);
      // Yahoo can repeat today (a live stub after the last full session); the
      // later one wins.
      byDay.set(d, { d, close: c, adj: a != null && !isNaN(a) && a > 0 ? a : c });
    }
    return Array.from(byDay.values()).sort((x, y) => x.d.localeCompare(y.d));
  } catch { return []; }
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

function measure(series: DayPoint[], since: string): TotalReturnResult {
  const none: TotalReturnResult = {
    since, startDate: null, startClose: null, endDate: null, endClose: null, total: null, price: null,
  };
  if (series.length === 0) return { ...none, error: "no price history" };
  const i = series.findIndex((p) => p.d >= since);
  if (i < 0) return none;                       // joined after the last session
  const start = series[i], end = series[series.length - 1];
  const base: TotalReturnResult = {
    since, startDate: start.d, startClose: start.close, endDate: end.d, endClose: end.close,
    total: null, price: null,
  };
  if (i === series.length - 1) return base;     // no session since it joined
  return {
    ...base,
    total: round1((end.adj / start.adj - 1) * 100),
    price: round1((end.close / start.close - 1) * 100),
  };
}

export async function POST(request: Request) {
  let body: { items?: { code?: unknown; since?: unknown }[] };
  try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  const items = (body.items ?? [])
    .filter((it): it is { code: string; since: string } =>
      typeof it?.code === "string" && /^[A-Z0-9]{2,6}$/.test(it.code) &&
      typeof it?.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.since))
    .slice(0, 25);
  if (items.length === 0) return Response.json({ results: {}, benchmark: { symbol: BENCHMARK, bySince: {} } });

  const earliest = items.map((it) => it.since).sort()[0];
  const [bench, ...series] = await Promise.all([
    fetchDaily(BENCHMARK, earliest),
    ...items.map((it) => fetchDaily(yahooSymbol(it.code), it.since)),
  ]);

  const results: Record<string, TotalReturnResult> = {};
  items.forEach((it, i) => { results[it.code] = measure(series[i], it.since); });

  // The index over each stock's own window: from the same first session.
  const bySince: Record<string, number | null> = {};
  for (const it of items) {
    if (it.since in bySince) continue;
    bySince[it.since] = measure(bench, it.since).total;
  }
  return Response.json({ results, benchmark: { symbol: BENCHMARK, bySince } });
}
