/**
 * Yahoo Finance Phase 2 data endpoint — no external packages required.
 *
 * Uses Yahoo Finance's raw JSON API directly (native fetch, Node 18+).
 * Gets a session crumb for authenticated access, then fetches:
 *   - quoteSummary (balance sheet + income statement + summary)
 *   - chart history (quarterly close prices)
 *
 * POST /api/yahoo-finance
 * Body:  { codes: string[], pes: Record<string, number | null> }
 * Returns: Record<string, { S_equity_inc: number|null, S_pe_hi_lo: number|null }>
 */

import { NextResponse } from "next/server";

const YF1 = "https://query1.finance.yahoo.com";
const YF2 = "https://query2.finance.yahoo.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Auth: get crumb + cookie from Yahoo Finance ──────────────────────────────

interface Auth {
  cookie: string;
  crumb: string;
}

async function getAuth(): Promise<Auth | null> {
  try {
    // Step 1: visit fc.yahoo.com to get a session cookie
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
    });

    // Collect all Set-Cookie headers
    let cookieStr = "";
    if (typeof (cookieRes.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function") {
      // Node 18+ native fetch
      const cookies = (cookieRes.headers as Headers & { getSetCookie: () => string[] }).getSetCookie();
      cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
    } else {
      // Fallback: get first Set-Cookie header
      cookieStr = (cookieRes.headers.get("set-cookie") ?? "").split(";")[0];
    }

    // Step 2: exchange cookie for a crumb
    const crumbRes = await fetch(`${YF2}/v1/test/getcrumb`, {
      headers: { "User-Agent": UA, Cookie: cookieStr },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    // crumb is a short alphanumeric string — reject HTML or empty responses
    if (!crumb || crumb.length > 64 || crumb.startsWith("<")) return null;

    return { cookie: cookieStr, crumb };
  } catch {
    return null;
  }
}

// ─── Typed helpers for Yahoo Finance's { raw, fmt } number format ─────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in v) return raw(v.raw);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawDate(v: any): number | null {
  // Returns Unix timestamp in *milliseconds*
  const r = raw(v);
  return r !== null ? r * 1000 : null;
}

// ─── API fetch helpers ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchQuoteSummary(ticker: string, auth: Auth | null): Promise<any> {
  const modules = "balanceSheetHistory,incomeStatementHistory,summaryDetail";
  const crumbQ = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
  const url = `${YF1}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbQ}`;

  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (auth?.cookie) headers["Cookie"] = auth.cookie;

  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.quoteSummary?.result?.[0] ?? null;
}

// Returns array of { dateMs, close } quarterly bars
async function fetchHistory(
  ticker: string,
  auth: Auth | null
): Promise<Array<{ dateMs: number; close: number }>> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 4 * 365 * 24 * 60 * 60; // 4 years back
  const crumbQ = auth ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
  const url = `${YF1}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=3mo${crumbQ}`;

  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (auth?.cookie) headers["Cookie"] = auth.cookie;

  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];

  return timestamps
    .map((ts, i) => ({ dateMs: ts * 1000, close: closes[i] }))
    .filter((b) => typeof b.close === "number" && isFinite(b.close) && b.close > 0);
}

// ─── Score computation ────────────────────────────────────────────────────────

interface Phase2Result {
  S_equity_inc: number | null;
  S_pe_hi_lo: number | null;
}

interface RequestBody {
  codes: string[];
  pes: Record<string, number | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeEquityInc(summary: any): number | null {
  const statements: unknown[] =
    summary?.balanceSheetHistory?.balanceSheetStatements ?? [];
  // Statements arrive newest-first from Yahoo Finance
  const equities = statements
    .slice(0, 4)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => raw(s?.totalStockholderEquity))
    .filter((v): v is number => v !== null);

  if (equities.length < 3) return null;
  // equities[0] = most recent year
  return equities[0] > equities[1] && equities[1] > equities[2] ? 1 : 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computePeHiLo(
  summary: any,
  bars: Array<{ dateMs: number; close: number }>,
  csvPE: number | null
): number | null {
  const trailingPE = raw(summary?.summaryDetail?.trailingPE) ?? csvPE;
  if (!trailingPE || trailingPE <= 0 || trailingPE >= 500) return null;

  const isStatements: unknown[] =
    summary?.incomeStatementHistory?.incomeStatementHistory ?? [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const annualEPS = isStatements.slice(0, 4).map((s: any) => ({
    dateMs: rawDate(s?.endDate),
    eps: raw(s?.dilutedEps),
  })).filter(
    (s): s is { dateMs: number; eps: number } =>
      s.dateMs !== null && s.eps !== null && s.eps > 0
  );

  if (annualEPS.length < 2 || bars.length < 4) return null;

  const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
  const historicalPEs: number[] = [];

  for (const { dateMs: epsMs, eps } of annualEPS) {
    // Find the quarterly bar whose date is closest to the EPS year-end date
    const closest = bars.reduce((best, bar) =>
      Math.abs(bar.dateMs - epsMs) < Math.abs(best.dateMs - epsMs) ? bar : best
    );
    if (Math.abs(closest.dateMs - epsMs) < SIX_MONTHS_MS) {
      const pe = closest.close / eps;
      if (pe > 0 && pe < 500) historicalPEs.push(pe);
    }
  }

  if (historicalPEs.length < 2) return null;

  const minPE = Math.min(...historicalPEs);
  const maxPE = Math.max(...historicalPEs);
  return trailingPE <= (minPE + maxPE) / 2 ? 1 : 0;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { codes = [], pes = {} } = body;
  if (codes.length === 0) return NextResponse.json({});

  // Get Yahoo Finance auth once for the whole batch
  const auth = await getAuth();

  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);

  // Phase 1: fetch all quoteSummaries in parallel
  const summaries = await Promise.allSettled(
    codes.map((code) => fetchQuoteSummary(`${code}.AX`, auth))
  );

  // Phase 2: fetch quarterly price history in parallel
  // (only for stocks that have meaningful PE data)
  const histories = await Promise.allSettled(
    codes.map((code, i) => {
      const sr = summaries[i];
      if (sr.status !== "fulfilled" || !sr.value) return Promise.resolve([]);
      const csvPE = pes[code] ?? null;
      const trailingPE =
        raw(sr.value?.summaryDetail?.trailingPE) ?? csvPE;
      if (!trailingPE || trailingPE <= 0 || trailingPE >= 500)
        return Promise.resolve([]);
      return fetchHistory(`${code}.AX`, auth).catch(() => []);
    })
  );

  // Compute scores
  const results: Record<string, Phase2Result> = {};

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const sr = summaries[i];
    const hr = histories[i];

    if (sr.status !== "fulfilled" || !sr.value) {
      results[code] = { S_equity_inc: null, S_pe_hi_lo: null };
      continue;
    }

    const summary = sr.value;
    const bars = hr.status === "fulfilled" ? (hr.value ?? []) : [];

    results[code] = {
      S_equity_inc: computeEquityInc(summary),
      S_pe_hi_lo: computePeHiLo(summary, bars, pes[code] ?? null),
    };
  }

  return NextResponse.json(results);
}
