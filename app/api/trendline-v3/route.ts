/**
 * 3PTL v3 — evaluation endpoint. SEPARATE FROM PRODUCTION BY DESIGN.
 *
 * The live scorecard calls /api/trendline (v1) and is untouched by anything
 * here, as is /api/trendline-v2 (HQ's Brettalator port). v3 is the sequential
 * walk built from Doug's own chart readings — see lib/trendline-v3.ts.
 *
 *   GET  /api/trendline-v3?code=BOL              v3 result for one stock
 *   GET  /api/trendline-v3?code=BOL&compare=1    v3 alongside v1 and v2
 *   POST /api/trendline-v3  {codes:[...]}        batch, <=25 codes
 *
 * Monthly bars come from the SAME Yahoo fetch v1 and v2 use, so any difference
 * in output is the algorithm and never the data.
 *
 * v3 can return a fourth sentiment the other two cannot: WATCH, for a stock
 * sitting between its buy and sell lines. Doug's words — "they are not a sell
 * nor a buy". Any caller that switches to v3 has to handle it.
 */
import { classifyV3, V3Bar } from "@/lib/trendline-v3";
import { classifyV2 } from "@/lib/trendline-v2";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

function yahooSymbol(code: string) {
  return /^[A-Z0-9]{1,4}$/.test(code) ? `${code}.AX` : code;
}

/** Six years of monthly bars — RAW (unadjusted), matching what a chartist sees. */
async function fetchMonthly(code: string): Promise<V3Bar[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 6 * 372 * 24 * 3600;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(code))}` +
              `?interval=1mo&period1=${start}&period2=${end}&includePrePost=false&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(9_000) });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const r = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!r) return [];
    const ts = r.timestamp as number[];
    const q = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0];
    const closes = q?.close as number[];
    if (!ts || !closes) return [];
    const out: V3Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      const d = new Date(ts[i] * 1000);
      out.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, close: c });
    }
    // Yahoo can repeat the current month; keep the last close per calendar month.
    const byMonth = new Map<string, V3Bar>();
    for (const b of out) byMonth.set(b.date, b);
    return Array.from(byMonth.values()).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** Live price plus the previous month's close (the Bible's uptick test). */
async function fetchDaily(code: string): Promise<{ price: number | null; prevMonthClose: number | null }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(code))}` +
              `?interval=1d&range=2mo&includePrePost=false`;
  const empty = { price: null, prevMonthClose: null };
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return empty;
    const json = await res.json() as Record<string, unknown>;
    const r = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!r) return empty;
    const ts = r.timestamp as number[];
    const closes = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]?.close as number[];
    if (!ts || !closes) return empty;
    const now = new Date();
    const cy = now.getUTCFullYear(), cm = now.getUTCMonth();
    let price: number | null = null, prevMonthClose: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      price = c;
      const d = new Date(ts[i] * 1000);
      if (d.getUTCFullYear() < cy || (d.getUTCFullYear() === cy && d.getUTCMonth() < cm)) prevMonthClose = c;
    }
    return { price, prevMonthClose };
  } catch { return empty; }
}

async function run(code: string, withV2 = false) {
  const bars = await fetchMonthly(code);
  if (bars.length < 12) return { code, error: "insufficient data", months: bars.length };
  const daily = await fetchDaily(code);
  const price = daily.price ?? bars[bars.length - 1].close;
  const r = classifyV3(bars, price, daily.prevMonthClose);

  // v2 is computed from the SAME bars rather than fetched over HTTP. An edge
  // function's fetch to its own sibling route does not carry the preview's
  // share cookie, so deployment protection returned null for both comparisons;
  // calling the library directly also guarantees one market snapshot. v1's
  // logic lives in its route rather than a lib, so it still has to be fetched
  // and will stay null on a protected preview.
  let v2: unknown = null;
  if (withV2) {
    const d = classifyV2(bars, price, { lastMonthClose: daily.prevMonthClose });
    const pv = (p: { m: number; p: number } | undefined | null) =>
      p ? { date: bars[bars.length - 1 + p.m]?.date ?? null, close: p.p } : null;
    v2 = {
      sentiment: d.sentiment, buy: d.buy, sell: d.sell, note: d.note,
      h1: pv(d.buyLine?.a), h2: pv(d.buyLine?.b),
      l1: pv(d.sellLine?.a), l2: pv(d.sellLine?.b),
    };
  }

  return {
    code, price, months: bars.length,
    lastMonthClose: daily.prevMonthClose,
    sentiment: r.sentiment, buy: r.buy, sell: r.sell, note: r.note,
    h1: r.h1, h2: r.h2, l1: r.l1, l2: r.l2,
    // The walk's event dates are NOT a tradeable history — L2 selection is not
    // strictly causal (see the caveat in lib/trendline-v3.ts). Useful for
    // debugging a reading, not for a "date became sell" column.
    events: r.events,
    v2,
  };
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const code = sp.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "code required" }, { status: 400 });

  const compare = !!sp.get("compare");
  const r = await run(code, compare);
  if (!compare) return Response.json(r);

  const { v2, ...v3 } = r as Record<string, unknown>;
  // v1's logic lives in its route rather than a lib, so it has to be fetched.
  // On a protected preview that fetch carries no share cookie and v1 comes back
  // null; on production it resolves. v2 above needs no fetch.
  let v1: unknown = null;
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(`${origin}/api/trendline?code=${encodeURIComponent(code)}`);
    if (res.ok) {
      const d = await res.json() as Record<string, unknown>;
      v1 = { sentiment: d.sentiment, buy: d.buyLine, sell: d.sellLine,
             h1: d.h1_detail, h2: d.h2_detail, l1: d.l1_detail, l2: d.l2_detail, note: d.note };
    }
  } catch { /* comparison is best-effort */ }
  return Response.json({ code, v3, v2, v1 });
}

export async function POST(request: Request) {
  const { codes } = (await request.json()) as { codes?: string[] };
  const batch = (codes ?? []).slice(0, 25);
  if (!batch.length) return Response.json({ error: "codes required" }, { status: 400 });
  // Not batch.map(run): map passes the index as the second argument, which
  // would land in `withV2` and make every stock but the first compute v2.
  const results = await Promise.all(batch.map((c) => run(c)));
  const out: Record<string, unknown> = {};
  batch.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}
