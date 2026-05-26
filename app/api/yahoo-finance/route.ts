/**
 * Phase 2 data — Financial Modeling Prep (FMP) API.
 *
 * Replaces the Yahoo Finance scraping approach. FMP is a proper REST API
 * that works reliably from Vercel serverless (no IP-blocking issues).
 *
 * POST /api/yahoo-finance   ← path kept so page.tsx needs no changes
 * Body:  { codes: string[], pes: Record<string, number | null> }
 * Returns: Record<string, { S_equity_inc: number|null, S_pe_hi_lo: number|null }>
 *
 * Requires: FMP_API_KEY environment variable
 *   → https://financialmodelingprep.com/  (free tier: 250 req/day)
 *   → Starter plan ~$14/month for larger portfolios
 *
 * Endpoints:
 *   /v3/balance-sheet-statement/{ticker}.AX  — equity trend (3 years)
 *   /v3/ratios/{ticker}.AX                  — historical annual PE ratios
 */

import { NextResponse } from "next/server";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FMPRow = Record<string, any>;

async function fmpGet(path: string, apiKey: string, debug = false): Promise<FMPRow[]> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${FMP_BASE}${path}${sep}apikey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (debug) console.log(`[FMP] ${url.replace(apiKey, "***")} → ${res.status}`);
    if (!res.ok) {
      if (debug) console.log(`[FMP] non-OK response body:`, await res.text());
      return [];
    }
    const data = await res.json();
    if (debug) console.log(`[FMP] response type=${Array.isArray(data) ? "array" : "object"}, keys=${Array.isArray(data) ? data.length : Object.keys(data).join(",")}`);
    if (Array.isArray(data)) return data as FMPRow[];
    // FMP returns { "Error Message": "..." } on bad ticker or plan limit
    if (debug) console.log(`[FMP] error object:`, JSON.stringify(data));
    return [];
  } catch (e) {
    if (debug) console.log(`[FMP] fetch threw:`, e);
    return [];
  }
}

// GET /api/yahoo-finance?ticker=BHP — test a single ticker for debugging
export async function GET(request: Request) {
  const apiKey = process.env.FMP_API_KEY ?? "";
  if (!apiKey) return Response.json({ error: "FMP_API_KEY not set" }, { status: 503 });

  const ticker = new URL(request.url).searchParams.get("ticker") ?? "BHP";
  const encoded = encodeURIComponent(`${ticker}.AX`);

  const [bs, ratios] = await Promise.all([
    fmpGet(`/balance-sheet-statement/${encoded}?limit=3&period=annual`, apiKey, true),
    fmpGet(`/ratios/${encoded}?limit=3&period=annual`, apiKey, true),
  ]);

  return Response.json({
    ticker: `${ticker}.AX`,
    balanceSheet: { count: bs.length, sample: bs[0] ?? null },
    ratios: { count: ratios.length, sample: ratios[0] ?? null },
  });
}

// ─── Score computation ────────────────────────────────────────────────────────

/**
 * S_equity_inc — score 1 if total stockholders' equity increased YoY
 * for 3 consecutive fiscal years (newest data first from FMP).
 */
function computeEquityInc(balanceSheets: FMPRow[]): number | null {
  const eq = balanceSheets
    .slice(0, 4)
    .map((s) => {
      // FMP field name varies slightly between annual/TTM responses
      const v = s.totalStockholdersEquity ?? s.totalEquity ?? null;
      return typeof v === "number" && isFinite(v) ? v : null;
    })
    .filter((v): v is number => v !== null);

  if (eq.length < 3) return null;
  // eq[0] = most recent year; eq[1] = prior year; eq[2] = two years ago
  return eq[0] > eq[1] && eq[1] > eq[2] ? 1 : 0;
}

/**
 * S_pe_hi_lo — score 1 if the current trailing PE (from Stock Doctor CSV)
 * is at or within 10% of the 3-year historical minimum PE (from FMP ratios).
 */
function computePeHiLo(
  ratios: FMPRow[],
  csvPE: number | null
): number | null {
  // Use the Stock Doctor CSV PE as the current value (always fresh)
  const currentPE = csvPE;
  if (!currentPE || currentPE <= 0 || currentPE >= 500) return null;

  // Historical PE ratios from FMP annual reports (newest first)
  const historicalPEs = ratios
    .slice(0, 4)
    .map((r) => {
      const v = r.priceEarningsRatio ?? r.peRatio ?? null;
      return typeof v === "number" && isFinite(v) && v > 0 && v < 500 ? v : null;
    })
    .filter((v): v is number => v !== null);

  if (historicalPEs.length < 2) return null;

  const minPE = Math.min(...historicalPEs);
  // Score 1 if current PE is at or within 10% of the 3-yr historical minimum
  return currentPE <= minPE * 1.1 ? 1 : 0;
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

  const apiKey = process.env.FMP_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "FMP_API_KEY not configured — add it to Vercel environment variables" },
      { status: 503 }
    );
  }

  // All stocks in the batch fetched in parallel (2 calls each: balance sheet + ratios)
  const results: Record<string, Phase2Result> = {};

  await Promise.allSettled(
    codes.map(async (code) => {
      const ticker = `${code}.AX`;
      const encoded = encodeURIComponent(ticker);

      const [bsResult, ratioResult] = await Promise.allSettled([
        fmpGet(`/balance-sheet-statement/${encoded}?limit=5&period=annual`, apiKey),
        fmpGet(`/ratios/${encoded}?limit=5&period=annual`, apiKey),
      ]);

      const bsData    = bsResult.status    === "fulfilled" ? bsResult.value    : [];
      const ratioData = ratioResult.status === "fulfilled" ? ratioResult.value : [];

      results[code] = {
        S_equity_inc: computeEquityInc(bsData),
        S_pe_hi_lo:   computePeHiLo(ratioData, pes[code] ?? null),
      };
    })
  );

  return NextResponse.json(results);
}
