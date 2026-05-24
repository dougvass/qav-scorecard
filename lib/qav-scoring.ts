/**
 * QAV Phase 0 scoring — TypeScript port of qav_pipeline.py
 *
 * Exactly replicates the 15 Phase 0 score columns (validated 100% against
 * QAV_analysis_sheet_v14pcf11.xlsx).
 */

import { StockRow, ScoredStock, ScoreColumns } from "./types";

// ─── Constants (match row 35 of QAV_updated) ───────────────────────────────

const RRR = 0.195;           // Tony's hurdle rate (AV35)
const MARKET_HURDLE = 0.101; // 6% + RBA cash rate 4.1% (AW35)
const DIV_YIELD_THRESHOLD_PCT = 9.3; // AM35 threshold (compared as %)

const STAR_STOCK_SCORES: Record<string, number> = {
  "non star stock": 0,
  "star growth stock": 1,
  "borderline star stock": 0.5,
  "star income stock": 0.5,
  "star growth stock and star income stock": 1.5,
  "borderline star stock and star income stock": 1,
};

const FH_TREND_SCORES: Record<string, number> = {
  recovering: 2,
  steady: 1,
  deteriorating: -1,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number" && isNaN(v)) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

// ─── Individual scoring functions (mirror Python exactly) ──────────────────

function scoreSentimentLong(row: StockRow): number {
  const p5 = num(row["Price Chg 5yr (%)"]);
  const p6 = num(row["Price Chg 6mth (%)"]);
  const sdmax = row["SDMAX Status"];
  const a = p5 !== null && p5 > 0 ? 1 : 0;
  const b = p6 !== null && p6 > 0 ? 1 : 0;
  const c = isBlank(row["Price Chg 5yr (%)"]) ? 1 : 0;
  const inner = a + b + c === 2 ? 1 : 0;
  const bullish = sdmax === "Bullish" ? 1 : 0;
  return inner + bullish > 0 ? 1 : 0;
}

function scorePriceToCashflow(row: StockRow): number | null {
  const sp = num(row["Share Price ($)"]);
  const cf = num(row["CF: Net Operating ($)"]);
  const shares = num(row["Shares Outstanding (M)"]);
  if (sp === null || cf === null || shares === null || shares === 0 || cf === 0)
    return null;
  const pcf = Math.round((sp / (cf / (shares * 1_000_000))) * 100) / 100;
  if (pcf < 0) return 0;
  return pcf <= 7 ? 2 : 0;
}

function scoreDivYield(row: StockRow): number | null {
  const y = num(row["Div Yield (%)"]);
  if (y === null) return null;
  return y > DIV_YIELD_THRESHOLD_PCT ? 1 : 0;
}

function scorePeLtDy(row: StockRow): number | null {
  const pe = num(row["PE"]);
  const dy = num(row["Div Yield (%)"]);
  if (dy === null || dy === 0 || pe === null || pe === 0) return null;
  return pe <= dy ? 1 : null;
}

function scoreSpLtNeps(row: StockRow): number | null {
  const sp = num(row["Share Price ($)"]);
  const eq = num(row["Equity ($)"]);
  const shares = num(row["Shares Outstanding (M)"]);
  if (sp === null || eq === null || shares === null || shares === 0) return null;
  const neps = Math.round((eq / (shares * 1_000_000)) * 10) / 10;
  return sp < neps ? 1 : null;
}

function scoreSpLt13Neps(row: StockRow): number | null {
  const sp = num(row["Share Price ($)"]);
  const eq = num(row["Equity ($)"]);
  const shares = num(row["Shares Outstanding (M)"]);
  if (sp === null || eq === null || shares === null || shares === 0) return null;
  const neps = Math.round((1.3 * eq / (shares * 1_000_000)) * 10) / 10;
  return sp < neps ? 1 : null;
}

function scoreGepsOverPe(row: StockRow): number | null {
  const pe = num(row["PE"]);
  const eps = num(row["EPS Bef Abnormals (c)"]);
  const feps = num(row["EPS (¢) Fcst yr1"]);
  if (pe === null || pe === 0) return null;
  if (feps === null || feps <= 0) return null;
  if (eps === null || eps === 0) return null;
  const val = ((feps - eps) / Math.abs(eps) / pe) * 100;
  if (val > 1.5) return 2;
  if (val < 0) return -1;
  return 0;
}

function calcIv1(row: StockRow): number | null {
  const eps = num(row["EPS Bef Abnormals (c)"]);
  if (eps === null) return null;
  return Math.round((eps / 100 / RRR) * 100) / 100;
}

function calcIv2(row: StockRow): number | null {
  const feps = num(row["EPS (¢) Fcst yr1"]);
  if (feps === null) return null;
  return Math.round((feps / 100 / MARKET_HURDLE) * 100) / 100;
}

function scoreSpLtIv1(row: StockRow): number | null {
  const sp = num(row["Share Price ($)"]);
  const iv = calcIv1(row);
  if (sp === null || iv === null) return null;
  return sp < iv ? 1 : 0;
}

function scoreSpLtIv2(row: StockRow): number | null {
  if (isBlank(row["EPS (¢) Fcst yr1"])) return null;
  const sp = num(row["Share Price ($)"]);
  const iv = calcIv2(row);
  if (sp === null || iv === null) return null;
  return sp < iv ? 1 : 0;
}

function scoreSpLtHalfIv2(row: StockRow): number | null {
  if (isBlank(row["EPS (¢) Fcst yr1"])) return null;
  const sp = num(row["Share Price ($)"]);
  const iv = calcIv2(row);
  if (sp === null || iv === null) return null;
  return sp < 0.5 * iv ? 1 : 0;
}

function scoreStarStock(row: StockRow): number {
  const s = row["Star Stock Status"];
  if (isBlank(s)) return 0;
  return STAR_STOCK_SCORES[String(s).trim().toLowerCase()] ?? 0;
}

function scoreSpLtIv4Consensus(row: StockRow): number | null {
  const consensus = num(row["Consensus Tgt ($)"]);
  const sp = num(row["Share Price ($)"]);
  if (consensus === null || sp === null) return null;
  return sp < consensus ? 1 : 0;
}

function scoreFhRating(row: StockRow): number {
  const r = row["Financial Health Rating"];
  if (isBlank(r)) return 0;
  return r === "Strong" || r === "Satisfactory" ? 1 : 0;
}

function scoreFhTrend(row: StockRow): number | null {
  const t = row["Financial Health Trend"];
  if (isBlank(t)) return null;
  const key = String(t).trim().toLowerCase();
  return key in FH_TREND_SCORES ? FH_TREND_SCORES[key] : null;
}

function scoreOwnership(row: StockRow): number {
  const holdings = num(row["All Directors' Holdings ($)"]);
  const shares = num(row["Shares Outstanding (M)"]);
  const sp = num(row["Share Price ($)"]);
  if (holdings === null || shares === null || sp === null || shares === 0 || sp === 0)
    return 0;
  const mktCap = shares * 1_000_000 * sp;
  return holdings / mktCap >= 0.1 ? 2 : 0;
}

// ─── Main scoring pipeline ─────────────────────────────────────────────────

/** Compute Phase 0 QAV scores for a list of StockRow objects.
 *  MS ratings (Phase 3) can be passed in via msRatings dict. */
export function scoreStocks(
  rows: StockRow[],
  msRatings?: Record<string, number | null>
): ScoredStock[] {
  return rows.map((row) => {
    const scores: ScoreColumns = {
      S_sentiment_long: scoreSentimentLong(row),
      S_sentiment_short: null,        // Phase 1 — not available client-side
      S_pcf: scorePriceToCashflow(row),
      S_div_yield: scoreDivYield(row),
      S_pe_lt_dy: scorePeLtDy(row),
      S_pe_hi_lo: null,               // Phase 2 — needs history DB
      S_equity_inc: null,             // Phase 2 — needs history DB
      S_sp_lt_neps: scoreSpLtNeps(row),
      "S_sp_lt_1.3neps": scoreSpLt13Neps(row),
      S_geps_pe: scoreGepsOverPe(row),
      S_sp_lt_iv1: scoreSpLtIv1(row),
      S_sp_lt_iv2: scoreSpLtIv2(row),
      "S_sp_lt_0.5iv2": scoreSpLtHalfIv2(row),
      S_sp_lt_iv3: msRatings ? (msRatings[row.Code] ?? null) : null,
      S_sp_lt_iv4: scoreSpLtIv4Consensus(row),
      S_star: scoreStarStock(row),
      S_fh_rating: scoreFhRating(row),
      S_fh_trend: scoreFhTrend(row),
      S_ownership: scoreOwnership(row),
    };

    // Count and sum non-null scores
    const scoreVals = Object.values(scores).filter((v) => v !== null) as number[];
    const count = scoreVals.length;
    const totalScore = scoreVals.reduce((a, b) => a + b, 0);
    const quality = count > 0 ? totalScore / count : null;

    // PCF (recomputed from raw, same as Python)
    const sp = num(row["Share Price ($)"]);
    const cf = num(row["CF: Net Operating ($)"]);
    const shares = num(row["Shares Outstanding (M)"]);
    let pcf: number | null = null;
    if (sp !== null && cf !== null && shares !== null && shares !== 0 && cf !== 0) {
      pcf = Math.round((sp / (cf / (shares * 1_000_000))) * 100) / 100;
    }

    // IV1 and IV2 (for display)
    const iv1 = calcIv1(row);
    const iv2 = calcIv2(row);

    // QAV = Quality / PCF * 100
    let qav: number | null = null;
    if (quality !== null && pcf !== null && pcf !== 0) {
      qav = Math.round((quality / pcf) * 100 * 100) / 100;
    }

    return {
      ...row,
      ...scores,
      IV1: iv1,
      IV2: iv2,
      PCF: pcf,
      Count: count,
      TotalScore: totalScore,
      Quality: quality,
      QAV: qav,
    } as ScoredStock;
  });
}

/** Filter and sort: keep stocks with QAV >= minQav, sorted descending by QAV. */
export function makeBuyList(
  scored: ScoredStock[],
  minQav: number = 10
): ScoredStock[] {
  return scored
    .filter((s) => s.QAV !== null && s.QAV >= minQav)
    .sort((a, b) => (b.QAV ?? 0) - (a.QAV ?? 0));
}

/** Colour coding for QAV score badge. */
export function qavColor(qav: number | null): string {
  if (qav === null) return "bg-gray-100 text-gray-400";
  if (qav >= 20) return "bg-emerald-100 text-emerald-800";
  if (qav >= 10) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-700";
}

/** Colour for individual score cells. */
export function scoreColor(val: number | null): string {
  if (val === null) return "text-gray-300";
  if (val > 0) return "text-emerald-700 font-semibold";
  if (val < 0) return "text-red-600 font-semibold";
  return "text-gray-400";
}

/** Convert a MorningStar star rating to S_sp_lt_iv3 score. */
export function starToIv3Score(starRating: number | null): number | null {
  if (starRating === null) return null;
  return starRating >= 4 ? 1 : 0;
}
