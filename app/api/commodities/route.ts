/**
 * GET /api/commodities — the 3PTL verdict for every commodity, from the World
 * Bank's Pink Sheet.
 *
 * Returns { asOf, source, commodities: { KEY: { sentiment, note, ... } } }, the
 * shape the buy-list commodity gate already consumes.
 *
 * ── Why this route exists ────────────────────────────────────────────────────
 * Commodities were classified from Yahoo monthly futures, and those series have
 * calendar GAPS: gold was missing 8 of 61 months (2022-05, 2023-01, 2023-10,
 * 2024-09, 2024-12, 2025-06, 2026-02, 2026-03). The engine indexes time by
 * array position, so a gap silently compresses it — a gradient measured over
 * "21 steps" can span 24 calendar months. That, not the rule set, was why the
 * commodity complex read so differently from the stocks. Feeding v3 gapless
 * monthly closes moved Aluminium and Platinum from wrong to right against HQ's
 * own run with no engine change at all.
 *
 * ── Source ──────────────────────────────────────────────────────────────────
 * The Pink Sheet (CMO-Historical-Data-Monthly.xlsx), gapless since 1960 and
 * updated monthly — through 2026M09 as at 2026-10-02, a month fresher than the
 * Market Index workbook. Sheet "Monthly Prices": series names on row 5, units
 * row 6, data from row 7, dates formatted 1960M01.
 *
 * Its download URL carries a release hash that changes, so the current link is
 * discovered from the commodity-markets page and only falls back to a pinned
 * URL if that fails.
 *
 * Eleven of our commodities come from it, including Nickel and Coal, which had
 * no series at all. Palladium and Uranium are not in it and keep their Yahoo
 * futures — calendar-normalised here, which they need for the reason above.
 * Lithium has no free monthly price series anywhere (FRED has only a miners
 * EQUITY index; the Pink Sheet, stooq and Yahoo futures have nothing; SMM,
 * Fastmarkets, Benchmark and the LME are paywalled), so it stays manual.
 */
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { classifyV3, V3Bar } from "@/lib/trendline-v3";
import { COMMODITY_SYMBOLS, EMBEDDED_MONTHLY, PINK_SHEET_SERIES } from "@/lib/commodities";

export const dynamic = "force-dynamic";

const CMO_PAGE = "https://www.worldbank.org/en/research/commodity-markets";
const CMO_FALLBACK =
  "https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026" +
  "/related/CMO-Historical-Data-Monthly.xlsx";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; qav-scorecard/1.0)" };

/** Follow the CMO page to the current monthly workbook; fall back to the pin. */
async function cmoUrl(): Promise<string> {
  try {
    const res = await fetch(CMO_PAGE, { headers: UA, signal: AbortSignal.timeout(9_000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/https:\/\/[^"'\s]*CMO-Historical-Data-Monthly\.xlsx/);
      if (m) return m[0];
    }
  } catch { /* fall through to the pin */ }
  return CMO_FALLBACK;
}

/** "1960M01" → "1960-01". Anything else → null. */
function pinkDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})M(\d{1,2})$/);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${String(mm).padStart(2, "0")}`;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // The Pink Sheet marks missing values with an ellipsis or dots.
  if (!s || s === "…" || s === ".." || s === "...") return null;
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : null;
}

interface Pink { asOf: string | null; url: string; series: Record<string, V3Bar[]> }

async function pinkSheet(): Promise<Pink | null> {
  const url = await cmoUrl();
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) return null;
  const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" });
  const ws = wb.Sheets["Monthly Prices"];
  if (!ws) return null;
  // Read as a matrix rather than by header, because the sheet has three title
  // rows above the names and the names themselves repeat units beneath.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  if (rows.length < 8) return null;

  // Series names sit on row 5 (1-based) = index 4.
  const names = rows[4] ?? [];
  const col: Record<string, number> = {};
  for (let c = 1; c < names.length; c++) {
    const label = String(names[c] ?? "").trim();
    if (label) col[label] = c;
  }

  const series: Record<string, V3Bar[]> = {};
  let asOf: string | null = null;
  for (const key of Object.keys(PINK_SHEET_SERIES)) {
    const label = PINK_SHEET_SERIES[key];
    const c = col[label];
    if (c === undefined) continue;
    const bars: V3Bar[] = [];
    for (let r = 6; r < rows.length; r++) {
      const date = pinkDate(rows[r]?.[0]);
      if (!date) continue;
      const v = num(rows[r]?.[c]);
      if (v === null) continue;
      bars.push({ date, close: v });
    }
    if (bars.length < 24) continue;
    // Six years is plenty for a five-year window; keep the tail small.
    series[key] = bars.slice(-80);
    const last = bars[bars.length - 1].date;
    if (!asOf || last > asOf) asOf = last;
  }
  return Object.keys(series).length ? { asOf, url, series } : null;
}

/**
 * Yahoo monthly closes, CALENDAR-NORMALISED.
 *
 * Only Palladium and Uranium still need this, but they need it badly: the
 * engine's time axis is the array index, so a missing month shifts every later
 * bar. Gaps are filled by linear interpolation between the bracketing closes —
 * carrying the previous value forward instead would make the filled month equal
 * its neighbour and the >= / <= pivot tests would read a spurious peak AND
 * trough there.
 */
async function yahooMonthly(symbol: string): Promise<V3Bar[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 7 * 372 * 24 * 3600;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1mo&period1=${start}&period2=${end}&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const r = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!r) return [];
    const ts = r.timestamp as number[];
    const closes = ((r.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0]
                    ?.close as number[];
    if (!ts || !closes) return [];
    const byMonth = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      const d = new Date(ts[i] * 1000);
      byMonth.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, c);
    }
    const have = Array.from(byMonth.keys()).sort();
    if (have.length < 24) return [];

    const out: V3Bar[] = [];
    let [y, m] = [Number(have[0].slice(0, 4)), Number(have[0].slice(5, 7))];
    const lastKey = have[have.length - 1];
    for (let guard = 0; guard < 1200; guard++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const v = byMonth.get(key);
      if (v !== undefined) {
        out.push({ date: key, close: v });
      } else {
        out.push({ date: key, close: NaN });   // placeholder, interpolated below
      }
      if (key === lastKey) break;
      m += 1;
      if (m === 13) { y += 1; m = 1; }
    }
    // Linear interpolation across each run of placeholders.
    for (let i = 0; i < out.length; i++) {
      if (!isNaN(out[i].close)) continue;
      let a = i - 1; while (a >= 0 && isNaN(out[a].close)) a--;
      let b = i + 1; while (b < out.length && isNaN(out[b].close)) b++;
      if (a < 0 || b >= out.length) { out[i].close = out[a >= 0 ? a : b].close; continue; }
      const step = (out[b].close - out[a].close) / (b - a);
      out[i].close = out[a].close + step * (i - a);
    }
    return out.slice(-80);
  } catch { return []; }
}

/** Live quote, so the uptick test sees today rather than last month's close. */
async function livePrice(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1d&range=5d`;
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    const r = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    const p = ((r?.meta as Record<string, unknown>)?.regularMarketPrice) as number | undefined;
    return typeof p === "number" && isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

export async function GET() {
  const headers = {
    "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=172800",
  };
  let pink: Pink | null = null;
  try { pink = await pinkSheet(); } catch { pink = null; }

  const out: Record<string, unknown> = {};
  const keys = Object.keys(PINK_SHEET_SERIES)
    .concat(Object.keys(COMMODITY_SYMBOLS))
    .concat(Object.keys(EMBEDDED_MONTHLY));
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);

    let bars: V3Bar[] | null = pink?.series[key] ?? null;
    let source = bars ? "World Bank Pink Sheet" : null;
    let price: number | null = null;

    if (!bars && COMMODITY_SYMBOLS[key]) {
      bars = await yahooMonthly(COMMODITY_SYMBOLS[key]);
      if (bars.length) {
        source = "Yahoo monthly, calendar-normalised";
        price = await livePrice(COMMODITY_SYMBOLS[key]);
      } else { bars = null; }
    }
    if (!bars && EMBEDDED_MONTHLY[key]) {
      bars = EMBEDDED_MONTHLY[key].bars.map(([date, close]) => ({ date, close }));
      source = `Market Index workbook (asOf ${EMBEDDED_MONTHLY[key].asOf})`;
    }
    if (!bars || bars.length < 12) {
      out[key] = { error: "no series available", symbol: COMMODITY_SYMBOLS[key] ?? null };
      continue;
    }

    // Without a live quote the price IS the last monthly close, so the uptick
    // test compares the last two months.
    const lastClose = bars[bars.length - 1].close;
    const p = price ?? lastClose;
    const lmc = price !== null ? lastClose : (bars.length >= 2 ? bars[bars.length - 2].close : null);
    const r = classifyV3(bars, p, lmc);
    out[key] = {
      sentiment: r.sentiment, note: r.note, sell: r.sell, buy: r.buy,
      l1: r.l1, l2: r.l2, h1: r.h1, h2: r.h2,
      price: p, lastMonthClose: lmc, months: bars.length,
      asOf: bars[bars.length - 1].date, source,
      symbol: COMMODITY_SYMBOLS[key] ?? null,
    };
  }

  return NextResponse.json({
    asOf: pink?.asOf ?? null,
    source: pink ? pink.url : "Pink Sheet unavailable — fell back per commodity",
    commodities: out,
  }, { headers });
}
