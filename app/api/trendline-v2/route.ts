/**
 * 3PTL v2 — evaluation endpoint. SEPARATE FROM PRODUCTION BY DESIGN.
 *
 * The live scorecard calls /api/trendline (v1) and is untouched by anything
 * here. This route exists so v2 (HQ's own algorithm — see lib/trendline-v2.ts)
 * can be measured against real data and against v1 before any switchover is
 * even proposed.
 *
 *   GET  /api/trendline-v2?code=BOL            v2 result for one stock
 *   GET  /api/trendline-v2?code=BOL&compare=1  v2 AND v1 side by side
 *   POST /api/trendline-v2  {codes:[...]}      batch, ≤25 codes
 *
 * Monthly bars come from the SAME Yahoo fetch v1 uses, so any difference in
 * output is the algorithm and never the data.
 */
import { classifyV2, V2Bar, monthFraction } from "@/lib/trendline-v2";

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
async function fetchMonthly(code: string): Promise<V2Bar[]> {
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
    const out: V2Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      const d = new Date(ts[i] * 1000);
      out.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, close: c });
    }
    // Yahoo can repeat the current month; keep the last close per calendar month.
    const byMonth = new Map<string, V2Bar>();
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

async function run(code: string) {
  const bars = await fetchMonthly(code);
  if (bars.length < 12) return { code, error: "insufficient data", months: bars.length };
  const daily = await fetchDaily(code);
  const price = daily.price ?? bars[bars.length - 1].close;
  const r = classifyV2(bars, price, { lastMonthClose: daily.prevMonthClose });
  const pv = (p: { m: number; p: number } | undefined | null) =>
    p ? { month: p.m, price: p.p, date: bars[bars.length - 1 + p.m]?.date ?? null } : null;
  return {
    code, price, months: bars.length, monthFraction: monthFraction(),
    lastMonthClose: daily.prevMonthClose,
    sentiment: r.sentiment, buy: r.buy, sell: r.sell, note: r.note,
    h1: pv(r.buyLine?.a), h2: pv(r.buyLine?.b),
    l1: pv(r.sellLine?.a), l2: pv(r.sellLine?.b),
  };
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const code = sp.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "code required" }, { status: 400 });

  const v2 = await run(code);
  if (!sp.get("compare")) return Response.json(v2);

  // Same-request comparison so both engines see the same market snapshot.
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
  return Response.json({ code, v2, v1 });
}

export async function POST(request: Request) {
  const { codes } = (await request.json()) as { codes?: string[] };
  const batch = (codes ?? []).slice(0, 25);
  if (!batch.length) return Response.json({ error: "codes required" }, { status: 400 });
  const results = await Promise.all(batch.map(run));
  const out: Record<string, unknown> = {};
  batch.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}
