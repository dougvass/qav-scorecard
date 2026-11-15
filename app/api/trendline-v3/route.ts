/**
 * 3PTL — the engine the scorecard runs.
 *
 *   GET  /api/trendline-v3?code=BOL          one stock, with its anchors
 *   GET  /api/trendline-v3?commodities=1     the commodity complex on Yahoo
 *                                            futures (the scorecard itself uses
 *                                            /api/commodities instead)
 *   POST /api/trendline-v3  {codes:[...]}    batch, <=25 codes
 *
 * The rules live in lib/trendline-v3.ts — the sequential walk built from Doug's
 * own chart readings. This route is only the data layer: monthly closes and a
 * live price from Yahoo, handed to `classifyV3`.
 *
 * It can return a fourth sentiment the old engines could not: WATCH, for a
 * stock sitting between its buy and sell lines. Doug's words — "they are not a
 * sell nor a buy".
 *
 * HISTORY. This was once an evaluation endpoint beside two others: v1 at
 * /api/trendline (the original classifier, 1,272 lines, which production ran
 * until the buy list moved here) and v2 at /api/trendline-v2 (a port of QAV
 * HQ's "Brettalator"). Both were removed on 2026-11-14 with Doug's agreement —
 * nothing called them but this route's own `?compare=1` debug mode, which went
 * with them. They are in git history if a comparison is ever wanted again.
 */
import { classifyV3, classifyV3Before, V3Bar } from "@/lib/trendline-v3";
import { COMMODITY_SYMBOLS, EMBEDDED_MONTHLY } from "@/lib/commodities";
import { monthOf, currentMonth } from "@/lib/exchange-months";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

/**
 * An ASX code gets the .AX suffix; anything already shaped like a Yahoo symbol
 * (GC=F, U-UN.TO) passes through.
 *
 * ASX codes run to SIX characters, not four. The test used to stop at four, so
 * PMGOLD and SGLLV were sent to Yahoo bare, came back 404, and were stored as a
 * neutral Watch on every run — found 2026-11-14 when Doug asked for the
 * "unreadable" codes to be cross-checked against the ASX. Both are listed and
 * both have a full six years of bars under their .AX symbols.
 */
function yahooSymbol(code: string) {
  return /^[A-Z0-9]{1,6}$/.test(code) ? `${code}.AX` : code;
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
    const off = ((r.meta as Record<string, unknown>)?.gmtoffset as number) ?? 0;
    const q = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0];
    const closes = q?.close as number[];
    if (!ts || !closes) return [];
    const out: V3Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      out.push({ date: monthOf(ts[i], off), close: c });
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
    const off = ((r.meta as Record<string, unknown>)?.gmtoffset as number) ?? 0;
    const cur = currentMonth();
    let price: number | null = null, prevMonthClose: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      price = c;
      // The LAST session of a previous month, in the exchange's calendar — the
      // first session of the current month is 00:00 Sydney, which is still the
      // month before in UTC, so a UTC test took it as last month's close.
      if (monthOf(ts[i], off) < cur) prevMonthClose = c;
    }
    return { price, prevMonthClose };
  } catch { return empty; }
}

/** The reading as PRODUCTION gives it — every 2026-11-15 rule off — from the
 *  same bars and the same price, for `?compare=1`. See V3_RULES in
 *  lib/trendline-v3.ts. */
function before(bars: V3Bar[], price: number, lmc: number | null) {
  const w = classifyV3Before(bars, price, lmc);
  return {
    sentiment: w.sentiment, buy: w.buy, sell: w.sell, note: w.note,
    h1: w.h1, h2: w.h2, l1: w.l1, l2: w.l2,
  };
}

async function run(code: string, compare = false) {
  const bars = await fetchMonthly(code);
  // Under a year of monthly closes: no 3PTL can be drawn. `unreadable` tells
  // the scorecard to leave the sentiment UNSCORED rather than file the stock
  // under a neutral Watch it has not earned (Doug, 2026-11-14).
  if (bars.length < 12) return { code, error: "insufficient data", unreadable: true, months: bars.length };
  const daily = await fetchDaily(code);
  const price = daily.price ?? bars[bars.length - 1].close;
  const r = classifyV3(bars, price, daily.prevMonthClose);
  return {
    // Compare mode also hands back the closes it read, so a rule can be replayed
    // offline over the whole list instead of needing a build per variant.
    ...(compare ? { was: before(bars, price, daily.prevMonthClose),
                    closes: bars.map((b) => [b.date, b.close]) } : {}),
    code, price, months: bars.length,
    lastMonthClose: daily.prevMonthClose,
    sentiment: r.sentiment, buy: r.buy, sell: r.sell, note: r.note,
    h1: r.h1, h2: r.h2, l1: r.l1, l2: r.l2,
    // The sell line is a safety net / is still forming under a holding.
    net: r.net, forming: r.forming,
    // The walk's event dates are NOT a tradeable history — L2 selection is not
    // strictly causal (see the caveat in lib/trendline-v3.ts). Useful for
    // debugging a reading, not for a "date became sell" column.
    events: r.events,
  };
}

/**
 * One commodity. Same engine as the stocks — v3 has a single rule set, where v1
 * ran a separate commodity mode (close basis, faster confirmation, and notably
 * NO falling-knife rule). That difference is real: a commodity v3 reads as a
 * knife gates every stock mapped to it off the buy list, which v1 would not
 * have done.
 *
 * Iron ore has no reachable feed and comes from the embedded Market Index
 * series; `asOf` is returned so its lag is visible rather than silent. For that
 * series the price IS the last monthly close, so the uptick test compares the
 * last two months rather than a live quote.
 */
async function runCommodity(name: string, compare = false) {
  const emb = EMBEDDED_MONTHLY[name];
  if (emb) {
    const bars: V3Bar[] = emb.bars.map(([date, close]) => ({ date, close }));
    if (bars.length < 12) return { symbol: "embedded", error: "insufficient data", months: bars.length };
    const price = bars[bars.length - 1].close;
    const lmc = bars.length >= 2 ? bars[bars.length - 2].close : null;
    // The price IS the last monthly close, so the lines are read at that month
    // and not one on (the `live` flag of classifyV3).
    const r = classifyV3(bars, price, lmc, undefined, false);
    return {
      ...(compare ? { was: before(bars, price, lmc) } : {}),
      symbol: "embedded", months: bars.length, asOf: emb.asOf,
      source: "Market Index workbook", price, lastMonthClose: lmc,
      sentiment: r.sentiment, note: r.note, sell: r.sell, buy: r.buy,
      l1: r.l1, l2: r.l2, h1: r.h1, h2: r.h2,
    };
  }
  const symbol = COMMODITY_SYMBOLS[name];
  if (!symbol) return { symbol: null, error: "no series for this commodity" };
  const bars = await fetchMonthly(symbol);
  if (bars.length < 12) return { symbol, error: "insufficient data", months: bars.length };
  const daily = await fetchDaily(symbol);
  const price = daily.price ?? bars[bars.length - 1].close;
  const r = classifyV3(bars, price, daily.prevMonthClose);
  return {
    ...(compare ? { was: before(bars, price, daily.prevMonthClose) } : {}),
    symbol, months: bars.length, price, lastMonthClose: daily.prevMonthClose,
    sentiment: r.sentiment, note: r.note, sell: r.sell, buy: r.buy,
    l1: r.l1, l2: r.l2, h1: r.h1, h2: r.h2,
  };
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;

  // The whole commodity complex in one call — feeds the buy-list commodity
  // gate (a stock whose underlying commodity is Bearish is not a buy).
  if (sp.get("commodities")) {
    const names = Object.keys(COMMODITY_SYMBOLS).concat(Object.keys(EMBEDDED_MONTHLY));
    const cmp = !!sp.get("compare");
    const results = await Promise.all(names.map((n) => runCommodity(n, cmp)));
    const out: Record<string, unknown> = {};
    names.forEach((n, i) => { out[n] = results[i]; });
    return Response.json({ commodities: out });
  }

  const code = sp.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "code required" }, { status: 400 });

  return Response.json(await run(code, !!sp.get("compare")));
}

export async function POST(request: Request) {
  const { codes, compare } = (await request.json()) as { codes?: string[]; compare?: boolean };
  const batch = (codes ?? []).slice(0, 25);
  if (!batch.length) return Response.json({ error: "codes required" }, { status: 400 });
  // An arrow, not `batch.map(run)`: map passes the index as the second
  // argument, which would switch `compare` on for every row but the first.
  const results = await Promise.all(batch.map((c) => run(c, !!compare)));
  const out: Record<string, unknown> = {};
  batch.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}
