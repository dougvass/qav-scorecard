/**
 * Yahoo Finance Phase 2 data endpoint
 *
 * POST /api/yahoo-finance
 * Body: { codes: string[], pes: Record<string, number | null> }
 * Returns: Record<string, { S_equity_inc: number|null, S_pe_hi_lo: number|null }>
 *
 * For each ASX code (appends .AX):
 *   S_equity_inc  — 1 if stockholders' equity increased YoY for last 3 consecutive years
 *   S_pe_hi_lo    — 1 if current trailing PE is ≤ midpoint of the 3-year PE range
 *
 * Processes two phases in parallel across the batch to maximise throughput while
 * staying well within Vercel's 10-second function timeout.
 */

import { NextResponse } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yahooFinance = require("yahoo-finance2").default ?? require("yahoo-finance2");

// Suppress yahoo-finance2 validation noise in logs
try {
  yahooFinance.setGlobalConfig({ validation: { logErrors: false, logOptionsErrors: false } });
} catch {
  // Config API varies across versions
}

interface Phase2Result {
  S_equity_inc: number | null;
  S_pe_hi_lo: number | null;
}

interface RequestBody {
  codes: string[];
  pes: Record<string, number | null>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) || !isFinite(n) ? null : n;
}

function dateMs(d: unknown): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "string" || typeof d === "number") return new Date(d).getTime();
  return 0;
}

// ─── Main route ───────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { codes = [], pes = {} } = body;
  if (!Array.isArray(codes) || codes.length === 0) {
    return NextResponse.json({});
  }

  const fourYearsAgo = new Date();
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const period1 = fourYearsAgo.toISOString().split("T")[0];

  // ── Phase 1: all quoteSummary calls in parallel ───────────────────────────
  const summaryResults = await Promise.allSettled(
    codes.map((code) =>
      yahooFinance.quoteSummary(`${code}.AX`, {
        modules: ["balanceSheetHistory", "incomeStatementHistory", "summaryDetail"],
      }).catch(() => null)
    )
  );

  // ── Phase 2: historical price calls only for stocks that have valid PE ────
  const historicalResults = await Promise.allSettled(
    codes.map((code, i) => {
      const sr = summaryResults[i];
      if (sr.status !== "fulfilled" || !sr.value) return Promise.resolve(null);

      const currentPE =
        safeNum(sr.value?.summaryDetail?.trailingPE) ?? safeNum(pes[code]);
      if (!currentPE || currentPE <= 0 || currentPE >= 500)
        return Promise.resolve(null);

      const isStatements =
        sr.value?.incomeStatementHistory?.incomeStatementHistory ?? [];
      if (isStatements.length < 2) return Promise.resolve(null);

      return yahooFinance
        .historical(`${code}.AX`, { period1, interval: "3mo" })
        .catch(() => null);
    })
  );

  // ── Compute scores ────────────────────────────────────────────────────────
  const results: Record<string, Phase2Result> = {};
  const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const sr = summaryResults[i];
    let S_equity_inc: number | null = null;
    let S_pe_hi_lo: number | null = null;

    if (sr.status === "fulfilled" && sr.value) {
      const summary = sr.value;

      // ── S_equity_inc ────────────────────────────────────────────────────
      // Statements come newest-first from Yahoo Finance
      const bsStatements: unknown[] =
        summary?.balanceSheetHistory?.balanceSheetStatements ?? [];
      const equities: number[] = bsStatements
        .slice(0, 4)
        .map((s: unknown) => safeNum((s as Record<string, unknown>).totalStockholderEquity))
        .filter((v): v is number => v !== null);

      if (equities.length >= 3) {
        // equities[0] = most recent; equities[1] = 1yr ago; equities[2] = 2yr ago
        S_equity_inc =
          equities[0] > equities[1] && equities[1] > equities[2] ? 1 : 0;
      }

      // ── S_pe_hi_lo ──────────────────────────────────────────────────────
      const trailingPE =
        safeNum(summary?.summaryDetail?.trailingPE) ?? safeNum(pes[code]);
      const isStatements: unknown[] =
        summary?.incomeStatementHistory?.incomeStatementHistory ?? [];

      type EPSPoint = { dateMs: number; eps: number };
      const annualEPS: EPSPoint[] = isStatements
        .slice(0, 4)
        .map((s: unknown) => ({
          dateMs: dateMs((s as Record<string, unknown>).endDate),
          eps: safeNum((s as Record<string, unknown>).dilutedEps),
        }))
        .filter((s): s is EPSPoint => s.eps !== null && s.eps > 0);

      const hr = historicalResults[i];
      const bars: unknown[] =
        hr?.status === "fulfilled" && Array.isArray(hr.value) ? hr.value : [];

      if (
        trailingPE &&
        trailingPE > 0 &&
        trailingPE < 500 &&
        annualEPS.length >= 2 &&
        bars.length >= 4
      ) {
        const historicalPEs: number[] = [];

        for (const { dateMs: epsMs, eps } of annualEPS) {
          // Find the quarterly bar closest in time to the EPS year-end
          const closest = (bars as Array<Record<string, unknown>>).reduce(
            (best, bar) => {
              const diff = Math.abs(dateMs(bar.date) - epsMs);
              const bestDiff = Math.abs(dateMs(best.date) - epsMs);
              return diff < bestDiff ? bar : best;
            }
          );
          const gap = Math.abs(dateMs(closest.date) - epsMs);
          const closePrice = safeNum(closest.close);
          if (closePrice && closePrice > 0 && gap < SIX_MONTHS_MS) {
            const pe = closePrice / eps;
            if (pe > 0 && pe < 500) historicalPEs.push(pe);
          }
        }

        if (historicalPEs.length >= 2) {
          const minPE = Math.min(...historicalPEs);
          const maxPE = Math.max(...historicalPEs);
          S_pe_hi_lo = trailingPE <= (minPE + maxPE) / 2 ? 1 : 0;
        }
      }
    }

    results[code] = { S_equity_inc, S_pe_hi_lo };
  }

  return NextResponse.json(results);
}
