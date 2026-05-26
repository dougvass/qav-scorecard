/**
 * Yahoo Finance Phase 2 data — native fetch, no external packages.
 *
 * Auth: finance.yahoo.com sets a session cookie; exchange it for a crumb;
 * use cookie + crumb on all subsequent API calls.
 *
 * POST /api/yahoo-finance
 * Body:  { codes: string[], pes: Record<string, number | null> }
 * Returns: Record<string, { S_equity_inc: number|null, S_pe_hi_lo: number|null }>
 */

import { NextResponse } from "next/server";

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const COMMON_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

// ─── Auth: cookie + crumb ─────────────────────────────────────────────────────

interface Auth { cookie: string; crumb: string }

/** Extract Name=Value pairs from all Set-Cookie headers. */
function parseCookies(res: Response): string {
  try {
    // Node 18+ / Vercel — handles multiple Set-Cookie headers correctly
    const h = res.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof h.getSetCookie === "function") {
      return h.getSetCookie()
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    }
  } catch { /* fall through */ }

  // Fallback: split comma-separated Set-Cookie (may mis-split on date commas,
  // but good enough for Yahoo's short-lived session cookies)
  const raw = res.headers.get("set-cookie") ?? "";
  return raw
    .split(/,(?=\s*\w+=)/)
    .map((c) => c.trim().split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function getAuth(): Promise<Auth | null> {
  // Yahoo Finance requires:
  //   1. Visit finance.yahoo.com → get session cookies (A1, A3, etc.)
  //   2. Exchange those cookies for a short-lived "crumb"
  //   3. Pass cookie + crumb on all subsequent API calls

  const cookieSources = [
    "https://finance.yahoo.com/",
    "https://finance.yahoo.com/quote/BHP.AX/",
    "https://fc.yahoo.com/",
  ];

  const crumbEndpoints = [
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
  ];

  for (const cookieUrl of cookieSources) {
    let cookieStr = "";
    try {
      const res = await fetch(cookieUrl, {
        headers: {
          ...COMMON_HEADERS,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });
      cookieStr = parseCookies(res);
    } catch { continue; }

    if (!cookieStr) continue;

    for (const crumbUrl of crumbEndpoints) {
      try {
        const cr = await fetch(crumbUrl, {
          headers: {
            ...COMMON_HEADERS,
            Accept: "application/json, text/plain, */*",
            Referer: "https://finance.yahoo.com/",
            Cookie: cookieStr,
          },
        });
        if (!cr.ok) continue;

        const crumb = (await cr.text()).trim();
        // A valid crumb is a short alphanumeric-ish string (not HTML, not JSON)
        if (crumb && crumb.length > 0 && crumb.length <= 64 &&
            !crumb.startsWith("<") && !crumb.startsWith("{")) {
          return { cookie: cookieStr, crumb };
        }
      } catch { /* try next */ }
    }
  }

  return null; // proceed without auth — chart endpoint often works anyway
}

// ─── Yahoo Finance API helpers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YFJson = Record<string, any>;

// Yahoo wraps numbers as { raw: number, fmt: string } — extract the raw value
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in v) return raw(v.raw);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawMs(v: any): number | null {
  const r = raw(v);
  return r !== null ? r * 1000 : null; // seconds → milliseconds
}

function authQuery(auth: Auth | null): string {
  return auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
}

function authHeaders(auth: Auth | null): Record<string, string> {
  const h: Record<string, string> = {
    ...COMMON_HEADERS,
    Accept: "application/json",
    Referer: "https://finance.yahoo.com/",
  };
  if (auth?.cookie) h["Cookie"] = auth.cookie;
  return h;
}

async function fetchQuoteSummary(ticker: string, auth: Auth | null): Promise<YFJson | null> {
  const modules = "balanceSheetHistory,incomeStatementHistory,summaryDetail";
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/` +
    `${encodeURIComponent(ticker)}?modules=${modules}${authQuery(auth)}`;

  try {
    const res = await fetch(url, { headers: authHeaders(auth) });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.quoteSummary?.result?.[0] ?? null;
  } catch { return null; }
}

async function fetchHistory(
  ticker: string,
  auth: Auth | null
): Promise<Array<{ dateMs: number; close: number }>> {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - 4 * 365 * 24 * 60 * 60;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=3mo${authQuery(auth)}`;

  try {
    const res = await fetch(url, { headers: authHeaders(auth) });
    if (!res.ok) return [];
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const ts: number[] = result.timestamp ?? [];
    const cl: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    return ts
      .map((t, i) => ({ dateMs: t * 1000, close: cl[i] ?? 0 }))
      .filter((b) => b.close > 0);
  } catch { return []; }
}

// ─── Score computation ────────────────────────────────────────────────────────

function computeEquityInc(summary: YFJson): number | null {
  // Statements arrive newest-first; [0] = most recent fiscal year
  const stmts: YFJson[] = summary?.balanceSheetHistory?.balanceSheetStatements ?? [];
  const eq = stmts
    .slice(0, 4)
    .map((s) => raw(s?.totalStockholderEquity))
    .filter((v): v is number => v !== null);

  if (eq.length < 3) return null;
  // Score 1 only if each of the last 3 years increased over the prior year
  return eq[0] > eq[1] && eq[1] > eq[2] ? 1 : 0;
}

function computePeHiLo(
  summary: YFJson,
  bars: Array<{ dateMs: number; close: number }>,
  csvPE: number | null
): number | null {
  const trailingPE = raw(summary?.summaryDetail?.trailingPE) ?? csvPE;
  if (!trailingPE || trailingPE <= 0 || trailingPE >= 500) return null;

  const stmts: YFJson[] = summary?.incomeStatementHistory?.incomeStatementHistory ?? [];
  const epsPoints = stmts
    .slice(0, 4)
    .map((s) => ({ dateMs: rawMs(s?.endDate), eps: raw(s?.dilutedEps) }))
    .filter((p): p is { dateMs: number; eps: number } =>
      p.dateMs !== null && p.eps !== null && p.eps > 0
    );

  if (epsPoints.length < 2 || bars.length < 4) return null;

  const SIX_MO = 180 * 24 * 60 * 60 * 1000;
  const historicalPEs: number[] = [];

  for (const { dateMs: epsMs, eps } of epsPoints) {
    const closest = bars.reduce((best, b) =>
      Math.abs(b.dateMs - epsMs) < Math.abs(best.dateMs - epsMs) ? b : best
    );
    if (Math.abs(closest.dateMs - epsMs) < SIX_MO) {
      const pe = closest.close / eps;
      if (pe > 0 && pe < 500) historicalPEs.push(pe);
    }
  }

  if (historicalPEs.length < 2) return null;

  // Score 1 if current PE is at or within 10% of its 3-year minimum
  const minPE = Math.min(...historicalPEs);
  return trailingPE <= minPE * 1.1 ? 1 : 0;
}

// ─── Route handler ────────────────────────────────────────────────────────────

interface Phase2Result { S_equity_inc: number | null; S_pe_hi_lo: number | null }
interface Body { codes: string[]; pes: Record<string, number | null> }

export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { codes = [], pes = {} } = body;
  if (codes.length === 0) return NextResponse.json({});

  // Get auth once for the whole batch
  const auth = await getAuth();

  // Phase 1: all quoteSummary calls in parallel
  const summaries = await Promise.allSettled(
    codes.map((code) => fetchQuoteSummary(`${code}.AX`, auth))
  );

  // Phase 2: history only for stocks with a usable PE
  const histories = await Promise.allSettled(
    codes.map((code, i) => {
      const sr = summaries[i];
      if (sr.status !== "fulfilled" || !sr.value) return Promise.resolve([]);
      const pe = raw(sr.value?.summaryDetail?.trailingPE) ?? pes[code];
      if (!pe || pe <= 0 || pe >= 500) return Promise.resolve([]);
      return fetchHistory(`${code}.AX`, auth);
    })
  );

  const results: Record<string, Phase2Result> = {};
  for (let i = 0; i < codes.length; i++) {
    const sr = summaries[i];
    const hr = histories[i];
    if (sr.status !== "fulfilled" || !sr.value) {
      results[codes[i]] = { S_equity_inc: null, S_pe_hi_lo: null };
      continue;
    }
    results[codes[i]] = {
      S_equity_inc: computeEquityInc(sr.value),
      S_pe_hi_lo: computePeHiLo(
        sr.value,
        hr.status === "fulfilled" ? (hr.value ?? []) : [],
        pes[codes[i]] ?? null
      ),
    };
  }

  return NextResponse.json(results);
}
