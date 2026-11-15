"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { parseStockDoctorText, decodeStockDoctorCsv } from "@/lib/csv-parser";
import {
  CSV_STORAGE_KEY, StoredCsv, loadStoredCsv, saveStoredCsv, clearStoredCsv,
  formatLoadedAt, daysSince,
} from "@/lib/csv-storage";
import {
  SD_ORIGIN, SD_FILTER_NAME, BridgeAckMessage, isBridgeCsvMessage, bookmarkletHref,
} from "@/lib/sd-bridge";
import {
  AccountStatus, SyncStatus, setSynced, authStatus, signIn, signOut, syncNow,
  getSyncStatus, onSyncStatus,
} from "@/lib/server-store";
import { PHASE2_STORAGE_KEY, StoredPhase2, monthsOld, STALE_MONTHS, scorePeHiLoLive } from "@/lib/phase2-storage";
import { BUYBACK_STORAGE_KEY, StoredBuybacks } from "@/lib/buyback-storage";
import {
  SENTIMENT_STORAGE_KEY,
  StoredSentiments,
  SentimentOverride,
  SENTIMENT_SCORES,
  SentimentKey,
  sentimentKeyOf,
  isJosephineDip,
} from "@/lib/sentiment-storage";
import {
  TRENDLINE_STORAGE_KEY,
  StoredTrendlines,
  TRENDLINE_SCORES,
  toStoredSentiment,
} from "@/lib/trendline-storage";
import {
  REDFLAG_STORAGE_KEY,
  StoredRedFlags,
  RedFlagEntry,
  GovernanceHit,
  hasRedFlag,
} from "@/lib/redflags";
import {
  REPORTING_STORAGE_KEY,
  StoredReporting,
  ReportingStatus,
  addMonths,
  formatDay,
} from "@/lib/reporting";
import { saveFundScores, FundScore } from "@/lib/fund-scores";
import {
  ASX_FINANCIALS_STORAGE_KEY,
  StoredAsxFinancials,
  AsxFinancialsRecord,
  AsxRead,
  deriveFromReport,
  isInForce,
  applyToRow,
} from "@/lib/asx-financials";
import {
  HOLDINGS_STORAGE_KEY,
  StoredHoldings,
  loadHoldings,
  saveHoldings,
  isHoldingAlert,
} from "@/lib/holdings-storage";
import HoldingsPanel from "@/components/holdings-panel";
import {
  COMMODITIES,
  STOCK_COMMODITY,
  COMMODITY_STORAGE_KEY,
  StoredCommodities,
  effectiveCommoditySentiment,
} from "@/lib/commodities";
import {
  scoreStocks,
  makeBuyList,
  isEtfOrFund,
  isSetAsideFund,
  setAsideKind,
  DEFAULT_CASH_RATE,
  DEFAULT_BORROWING_RATE,
  DEFAULT_RRR,
  ScoringRates,
} from "@/lib/qav-scoring";
import { StockRow, ScoredStock } from "@/lib/types";
import {
  HistorySeries, HistoryPoint, todayIso, mergeSeries,
  loadLocalHistory, saveLocalHistory,
} from "@/lib/history-storage";
import { UploadZone } from "@/components/upload-zone";
import { SummaryStats } from "@/components/summary-stats";
import { StockTable } from "@/components/stock-table";
import {
  UploadCloud,
  RefreshCw,
  Star,
  ListFilter,
  BarChart2,
  Settings2,
  Database,
  TrendingUp,
  Activity,
  Briefcase,
  AlertTriangle,
  Lock,
  Cloud,
} from "lucide-react";

/**
 * The 3PTL engine for STOCKS: the sequential walk built from Doug's own chart
 * readings (lib/trendline-v3.ts) — 15/15 on his qualified set.
 *
 * The two older engines this could once be pointed back at (v1 at
 * /api/trendline, v2 at /api/trendline-v2) were deleted on 2026-11-14.
 * toStoredSentiment() still accepts their vocabulary, so a result stored by
 * either before then keeps resolving.
 */
const TRENDLINE_ENDPOINT = "/api/trendline-v3";

/**
 * The COMMODITY complex. /api/commodities runs the same engine over World Bank
 * Pink Sheet monthly closes — gapless, which is what commodities actually
 * needed: Yahoo's monthly futures have calendar gaps and the engine indexes
 * time by array position, so a gap silently compresses it.
 *
 * "/api/trendline-v3?commodities=1" (the same engine over Yahoo futures,
 * gappy) still exists and can be restored by changing this line.
 */
const COMMODITY_ENDPOINT = "/api/commodities";

const SCORE_KEYS = [
  "S_sentiment_long", "S_sentiment_short", "S_pcf", "S_div_yield",
  "S_pe_lt_dy", "S_pe_hi_lo", "S_equity_inc", "S_sp_lt_neps",
  "S_sp_lt_1.3neps", "S_geps_pe", "S_sp_lt_iv1", "S_sp_lt_iv2",
  "S_sp_lt_0.5iv2", "S_sp_lt_iv4", "S_star",
  "S_fh_rating", "S_fh_trend", "S_ownership", "S_buyback", "S_new_upturn",
] as const;

// Phase 2 payload: Code → { S_equity_inc, S_pe_hi_lo, lastPeriod }
type Phase2Map = Record<string, { S_equity_inc: number | null; S_pe_hi_lo: number | null; lastPeriod?: string | null; peHistory?: number[] }>;

// Buyback payload: Code → active flag
type BuybackMap = Record<string, boolean>;

/** Stock Doctor writes dates as dd/mm/yyyy; Date.parse() reads that as US
 *  mm/dd/yyyy and silently mangles anything past the 12th. */
function parseSdDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = v.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-30" -> "Jun 26", the way Stock Doctor labels a reporting period. */
function periodLabel(iso: string | null | undefined): string {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})/);
  if (!m) return iso || "—";
  return `${MONTH_ABBR[Number(m[2]) - 1] ?? m[2]} ${m[1].slice(2)}`;
}

/** Stocks per reporting-check request (the route takes up to 30). */
const REPORTING_CHUNK = 15;
/** How many hold stocks the daily ASX check takes without being asked. */
const AUTO_REPORTING_LIMIT = 60;
/**
 * The soonest a report for the next half can be due: six months to the period
 * end plus the two months Listing Rules 4.2B / 4.3B allow. Before that date a
 * stock on the hold cannot be late, whatever the feed says.
 */
const EARLIEST_DEADLINE_MONTHS = 8;

/** The local calendar day of an ISO timestamp, as YYYY-MM-DD. */
function localDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Data-freshness straight from the Phase 1 CSV's "Last Period Analysed".
 *
 * This is the RIGHT source for the 6-month reporting-season rule: the CSV is
 * re-exported often, so its dates are current, and it covers every stock in the
 * universe rather than only those in the Phase 2 workbook. The Phase 2 date is
 * a snapshot frozen at whenever that workbook was last built — it can only lag.
 * (Found via LAU: reported FY26 on 24-Aug-2026, but the Phase 2 column still
 * read 31/12/2025 from a 13-Jul export and flagged it 8 months stale, not 2.)
 * enrichWithPhase2 may still move the date FORWARD if it holds something newer,
 * never backward.
 */
function enrichWithCsvFreshness(stocks: ScoredStock[], rows: StockRow[]): ScoredStock[] {
  const byCode = new Map<string, string | null>();
  for (const r of rows) {
    const code = String((r as Record<string, unknown>).Code ?? "").trim().toUpperCase();
    if (code) byCode.set(code, parseSdDate((r as Record<string, unknown>)["Last Period Analysed"]));
  }
  return stocks.map((stock) => {
    const iso = byCode.get(stock.Code.toUpperCase());
    if (!iso) return stock;
    const age = monthsOld(iso);
    return {
      ...stock,
      _lastPeriod: iso,
      _dataMonthsOld: age,
      _staleData: age !== null && age > STALE_MONTHS ? 1 : null,
    } as ScoredStock;
  });
}

/** Apply Phase 2 scores (equity trend + PE hi-lo) and recompute derived stats. */
function enrichWithPhase2(stocks: ScoredStock[], phase2: Phase2Map): ScoredStock[] {
  return stocks.map((stock) => {
    const data = phase2[stock.Code];
    // A stock with NO Phase 2 row at all still needs flagging — that is exactly
    // the case that matters: a new name has appeared on the buy list and its
    // PE Hi/Lo and Equity scores have never been collected from Stock Doctor.
    if (!data) {
      return { ...stock, _missingPhase2: 1, _missingWhich: "PE Hi/Lo + Equity" } as ScoredStock;
    }
    const enriched = { ...stock } as ScoredStock;
    if (data.S_equity_inc !== null) enriched.S_equity_inc = data.S_equity_inc;
    if (data.S_pe_hi_lo !== null) enriched.S_pe_hi_lo = data.S_pe_hi_lo;
    // Prefer PE Hi/Lo scored against TODAY's PE. The workbook's stored score is
    // frozen at scrape time, but PE moves with the price daily — see
    // scorePeHiLoLive for the measured damage. Falls back to the stored value
    // when there is too little history to judge.
    const livePe = Number(String((stock as Record<string, unknown>).PE ?? "").replace(/,/g, ""));
    const liveScore = scorePeHiLoLive(isFinite(livePe) ? livePe : null, data.peHistory);
    if (liveScore !== null) {
      enriched.S_pe_hi_lo = liveScore;
      (enriched as Record<string, unknown>)._peHiLoLive = 1;
    }
    const gaps = [
      data.S_pe_hi_lo === null ? "PE Hi/Lo" : null,
      data.S_equity_inc === null ? "Equity" : null,
    ].filter(Boolean);
    // "Data needed" means data that CAN be collected. A row with a
    // `lastPeriod` has had its financials page read — the date is the newest
    // period on its history row — so a score still blank after that is blank
    // BY RULE: PE Hi/Lo for a company with no current PE (a loss-maker),
    // Equity for one with a single annual period on record. Asking for those
    // again was noise that never cleared: MME, CCX, AIZ, CLG, KSN, TEK and CYG
    // sat in the box permanently. Doug, 2026-11-14: drop them. Only a row
    // that was never collected (no date) still counts as missing; when one of
    // these companies reports again, the out-of-date scan below picks it up.
    const collected = !!data.lastPeriod;
    const missing = gaps.length > 0 && !collected;
    (enriched as Record<string, unknown>)._missingPhase2 = missing ? 1 : null;
    (enriched as Record<string, unknown>)._missingWhich = missing ? gaps.join(" + ") : null;

    // ── Phase 2 OUT OF DATE ────────────────────────────────────────────────
    // Doug, 2026-11-14: "automating and scanning on each run for Phase 2 data
    // that might be out of date."
    //
    // The test is the one the manual top-ups have always used to build their
    // target list: Stock Doctor's "Last Period Analysed" (from this CSV) is a
    // NEWER period than the newest one our PE / Equity history holds. That
    // means the company has reported since the history was collected, so PE
    // Hi/Lo is missing a reported PE and Equity Increasing is missing a year.
    //
    // `data.lastPeriod` is the right thing to compare against: it is the
    // workbook's "Last Reported" column, which is written from the newest label
    // on the PE_Equity_History row — checked against the workbook itself, the
    // two agree for 547 of 547 rows. So it says what the history COVERS.
    //
    // Compared by month, because the CSV carries a day (30/06/2026) and the
    // history a period label (Jun 26).
    //
    // Only a row that actually holds collected data can be out of date; one
    // with nothing in it is already listed as missing, and saying both would
    // count the same stock twice.
    //
    // Must be read BEFORE the freshness block below, which may move
    // `_lastPeriod` forward — though only in the opposite case, where Phase 2
    // is the newer of the two.
    // Against STOCK DOCTOR's period, not the ASX report's: the history is
    // collected from Stock Doctor, so a stock scored from its own report is not
    // "out of date" there — Stock Doctor has nothing newer to collect.
    const csvPeriod = ((enriched as Record<string, unknown>)._sdPeriod as string | undefined)
      ?? ((enriched as Record<string, unknown>)._lastPeriod as string | undefined) ?? null;
    const p2Period = data.lastPeriod ?? null;
    const holdsData = data.S_pe_hi_lo !== null || data.S_equity_inc !== null || !!data.peHistory;
    const phase2Stale = holdsData && p2Period !== null && csvPeriod !== null &&
      csvPeriod.slice(0, 7) > p2Period.slice(0, 7);
    (enriched as Record<string, unknown>)._phase2Stale = phase2Stale ? 1 : null;
    (enriched as Record<string, unknown>)._phase2Has = phase2Stale ? p2Period : null;
    (enriched as Record<string, unknown>)._phase2Now = phase2Stale ? csvPeriod : null;

    // Data-freshness rule: numbers older than 6 months = HOLD OFF buying
    // until the company reports (reporting-season rule). Flag, don't score —
    // staleness says nothing about quality, only about buy timing.
    // The CSV (enrichWithCsvFreshness) is the primary source because it is
    // re-exported often; only take the Phase 2 date when it is NEWER, which
    // happens when the financials pages were scraped after the last CSV run.
    const existing = (enriched as Record<string, unknown>)._lastPeriod as string | undefined;
    if (data.lastPeriod && (!existing || data.lastPeriod > existing)) {
      const age = monthsOld(data.lastPeriod);
      (enriched as Record<string, unknown>)._lastPeriod = data.lastPeriod;
      (enriched as Record<string, unknown>)._dataMonthsOld = age;
      (enriched as Record<string, unknown>)._staleData = age !== null && age > STALE_MONTHS ? 1 : null;
    }
    const vals = SCORE_KEYS
      .map((k) => (enriched as Record<string, unknown>)[k] as number | null)
      .filter((v): v is number => v !== null);
    enriched.Count = vals.length;
    enriched.TotalScore = vals.reduce((a, b) => a + b, 0);
    enriched.Quality = vals.length > 0 ? enriched.TotalScore / vals.length : null;
    enriched.QAV =
      enriched.Quality !== null && enriched.PCF !== null && enriched.PCF !== 0
        ? Math.round((enriched.Quality / enriched.PCF) * 100 * 100) / 100
        : null;
    return enriched;
  });
}

/** Apply auto-calculated 3PTL trendline results (overrides SDMAX, overridden by manual). */
function enrichWithTrendlines(stocks: ScoredStock[], trendlines: StoredTrendlines): ScoredStock[] {
  return stocks.map((stock) => {
    const entry = trendlines.data[stock.Code];
    if (!entry) return stock;

    // NO CHART YET. Under a year of monthly closes there is no 3PTL to draw —
    // a new listing, or a relisting whose history starts again. These used to
    // be filed under a neutral Watch, which scores 0 and so pulled Quality
    // DOWN for a stock nobody had read. Doug, 2026-11-14, after the seven then
    // affected were checked against the ASX (all listed; five under a year
    // old): "leave unscored". So the sentiment is blank — out of the Quality
    // average altogether — and the SDMAX reading the CSV supplied does not
    // stand in for it either: that is Stock Doctor's line, not Tony's.
    if (entry.unreadable || entry.sentiment === null) {
      const blank = {
        ...stock,
        S_sentiment_long: null,
        S_new_upturn: null,
        _positiveJosephine: null,
        _noChart: 1,
      } as ScoredStock;
      const kept = SCORE_KEYS
        .map((k) => (blank as Record<string, unknown>)[k] as number | null)
        .filter((v): v is number => v !== null);
      blank.Count = kept.length;
      blank.TotalScore = kept.reduce((a, b) => a + b, 0);
      blank.Quality = kept.length > 0 ? blank.TotalScore / kept.length : null;
      blank.QAV =
        blank.Quality !== null && blank.PCF !== null && blank.PCF !== 0
          ? Math.round((blank.Quality / blank.PCF) * 100 * 100) / 100
          : null;
      return blank;
    }
    // Josephine means ONE thing now: above both lines but below last month's
    // close. Everything else scoring 0 is between the lines, i.e. Watch.
    //
    // This test used to look for "josephine: positive" or "positive 3ptl" in
    // the note, and NOTHING in the codebase has ever written either string —
    // so the marker was never set and the teal badge was unreachable. v1
    // actually writes "Josephine ↗: above both lines but price X is N% below
    // last month's close"; v3 writes "below last month close X". Match both.
    // The two legacy strings are kept so any older stored run still resolves.
    const note = (entry.note ?? "").toLowerCase();
    const isDip =
      entry.sentiment === "Josephine" &&
      (note.includes("↗") ||
       /below last month(?:'s)? close/.test(note) ||
       note.includes("josephine: positive") ||
       note.includes("positive 3ptl"));

    const enriched = {
      ...stock,
      S_sentiment_long: TRENDLINE_SCORES[entry.sentiment],
      // Auto-set new upturn +1 when 3PTL detects a fresh breakout above resistance
      S_new_upturn: scoreNewUpturn(entry.lastBuyBreach, stock),
      // 1 = Josephine (the dip), null = Watch (between the lines).
      _positiveJosephine: isDip ? 1 : null,
    } as ScoredStock;
    const vals = SCORE_KEYS
      .map((k) => (enriched as Record<string, unknown>)[k] as number | null)
      .filter((v): v is number => v !== null);
    enriched.Count = vals.length;
    enriched.TotalScore = vals.reduce((a, b) => a + b, 0);
    enriched.Quality = vals.length > 0 ? enriched.TotalScore / vals.length : null;
    enriched.QAV =
      enriched.Quality !== null && enriched.PCF !== null && enriched.PCF !== 0
        ? Math.round((enriched.Quality / enriched.PCF) * 100 * 100) / 100
        : null;
    return enriched;
  });
}

/**
 * Bible Column I — "Is there a recent positive upturn?"
 *
 *   Cell type: Score (Positive = 1. Negative = blank.)
 *   "Does the 5 year monthly chart show a recent upturn since the last
 *    financial results (results of the date, not reporting date)?"
 *   "By 'recent upturn', we mean 'has it breached the buy line'?"
 *   "If it's just started a new upcycle, that's an extra good time to buy in.
 *    But we aren't going to penalise it if the answer is a no."
 *
 * So: 1 when the walk's most recent buy-line breach falls on or after the
 * BALANCE date of the last reported results, otherwise blank. Blank, never 0 —
 * a zero would drag Quality down, which the Bible explicitly rules out.
 *
 * `_lastPeriod` is that balance date, taken from the CSV's "Last Period
 * Analysed" (and moved forward by Phase 2 when it holds something newer). It is
 * the results date, not the announcement date the Bible warns against. With no
 * balance date there is no window, so the answer is blank.
 */
function scoreNewUpturn(lastBuyBreach: string | null | undefined, stock: ScoredStock): number | null {
  if (!lastBuyBreach) return null;
  const period = (stock as Record<string, unknown>)._lastPeriod as string | undefined;
  if (!period) return null;
  // Breach months are "YYYY-MM"; the balance date is ISO "YYYY-MM-DD".
  return lastBuyBreach >= period.slice(0, 7) ? 1 : null;
}

/**
 * Apply the QAV commodity gate: a stock whose underlying commodity is in Sell
 * (Bearish) status is itself a sell / do-not-buy, regardless of its own chart
 * — force sentiment to Bearish and flag it for the table badge. Runs AFTER
 * the auto 3PTL layer and BEFORE manual per-stock overrides (manual wins).
 *
 * A PROXY commodity is ADVISORY ONLY: its automatic read is displayed but never
 * gates. Lithium has no price series at all, so it runs on the LIT ETF of miner
 * and battery equities, and that stand-in should not push stocks off the buy
 * list by itself — it read Sell at 71.07 against a 73.96 line, 3.9% below, with
 * the two lines converged inside 1.3%, while gating PLS, LTR, IGO and MIN.
 *
 * A MANUAL setting on a proxy commodity DOES gate, because choosing it means a
 * human read the real chart.
 */
function enrichWithCommodityGate(stocks: ScoredStock[], commodities: StoredCommodities): ScoredStock[] {
  return stocks.map((stock) => {
    const commodityKey = STOCK_COMMODITY[stock.Code];
    if (!commodityKey) return stock;
    const sentiment = effectiveCommoditySentiment(commodities, commodityKey);
    const def = COMMODITIES.find((c) => c.key === commodityKey);
    const label = (def?.label ?? commodityKey) + (def?.proxy ? "*" : "");
    const advisory = !!def?.proxy && commodities.manual[commodityKey] === undefined;
    if (sentiment !== "Bearish" || advisory) {
      // Not gated — still annotate the commodity for display
      return { ...stock, _commodity: label, _commoditySell: null } as ScoredStock;
    }
    const enriched = {
      ...stock,
      S_sentiment_long: TRENDLINE_SCORES.Bearish,
      _commodity: label,
      _commoditySell: 1,
    } as ScoredStock;
    const vals = SCORE_KEYS
      .map((k) => (enriched as Record<string, unknown>)[k] as number | null)
      .filter((v): v is number => v !== null);
    enriched.Count = vals.length;
    enriched.TotalScore = vals.reduce((a, b) => a + b, 0);
    enriched.Quality = vals.length > 0 ? enriched.TotalScore / vals.length : null;
    enriched.QAV =
      enriched.Quality !== null && enriched.PCF !== null && enriched.PCF !== 0
        ? Math.round((enriched.Quality / enriched.PCF) * 100 * 100) / 100
        : null;
    return enriched;
  });
}

/** Apply manual 3PTL sentiment overrides and recompute derived stats. */
function enrichWithSentimentOverrides(stocks: ScoredStock[], overrides: StoredSentiments): ScoredStock[] {
  return stocks.map((stock) => {
    const override = overrides[stock.Code];
    if (override === undefined) return stock;
    const enriched = {
      ...stock,
      S_sentiment_long: SENTIMENT_SCORES[override],
      // Watch and Josephine both score 0, so the score cannot separate them.
      // Josephine now means ONLY the dip case (above the lines, below last
      // month's close), so a Josephine override sets the dip marker and every
      // other override clears it — otherwise a manual Watch would inherit a
      // stale flag from the auto run and render as Josephine.
      _positiveJosephine: override === "Josephine" ? 1 : null,
    } as ScoredStock;
    const vals = SCORE_KEYS
      .map((k) => (enriched as Record<string, unknown>)[k] as number | null)
      .filter((v): v is number => v !== null);
    enriched.Count = vals.length;
    enriched.TotalScore = vals.reduce((a, b) => a + b, 0);
    enriched.Quality = vals.length > 0 ? enriched.TotalScore / vals.length : null;
    enriched.QAV =
      enriched.Quality !== null && enriched.PCF !== null && enriched.PCF !== 0
        ? Math.round((enriched.Quality / enriched.PCF) * 100 * 100) / 100
        : null;
    return enriched;
  });
}

/** Apply buyback scores (1 if active buyback, null otherwise) and recompute derived stats. */
function enrichWithBuybacks(stocks: ScoredStock[], buybacks: BuybackMap): ScoredStock[] {
  return stocks.map((stock) => {
    const active = buybacks[stock.Code];
    if (!active) return stock; // false or undefined → no score change (stays null)
    const enriched = { ...stock, S_buyback: 1 } as ScoredStock;
    const vals = SCORE_KEYS
      .map((k) => (enriched as Record<string, unknown>)[k] as number | null)
      .filter((v): v is number => v !== null);
    enriched.Count = vals.length;
    enriched.TotalScore = vals.reduce((a, b) => a + b, 0);
    enriched.Quality = vals.length > 0 ? enriched.TotalScore / vals.length : null;
    enriched.QAV =
      enriched.Quality !== null && enriched.PCF !== null && enriched.PCF !== 0
        ? Math.round((enriched.Quality / enriched.PCF) * 100 * 100) / 100
        : null;
    return enriched;
  });
}

/**
 * Slide-down panel for entering active buyback codes manually.
 * The ASX /asx/1/company/{code}/announcements API is no longer available (404),
 * so we ask the user to check asx.com.au and enter the codes themselves.
 * This matches how the original TK spreadsheet works (column K, manual entry).
 */
function BuybackPanel({
  currentCodes,
  onSave,
  onClose,
}: {
  currentCodes: string[];
  onSave: (codes: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(currentCodes.join(", "));

  function handleSave() {
    const codes = text
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    onSave(codes);
  }

  return (
    <div className="border-t border-orange-100 bg-orange-50 px-6 py-4">
      <div className="max-w-screen-2xl mx-auto space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-orange-800">On-Market Buybacks (+1 score each)</p>
            <p className="text-xs text-orange-600 mt-0.5">
              Manual override — or use <strong>Check Buybacks</strong> to scan automatically.
              For each stock check{" "}
              <code className="bg-orange-100 px-1 rounded text-orange-700">
                asx.com.au/markets/trade-our-cash-market/announcements.<em>code</em>
              </code>{" "}
              and look for <strong>Appendix 3C</strong> (buy-back) or{" "}
              <strong>Appendix 3D</strong> (change). Enter active codes below.
            </p>
          </div>
          <button onClick={onClose} className="text-orange-400 hover:text-orange-700 text-lg leading-none">✕</button>
        </div>

        <div className="flex items-center gap-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. BHP, CBA, ANZ, WBC"
            className="flex-1 text-sm border border-orange-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 font-mono"
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
          >
            Save
          </button>
          {currentCodes.length > 0 && (
            <button
              onClick={() => onSave([])}
              className="px-3 py-2 text-sm font-medium rounded-lg border border-orange-300 text-orange-700 hover:bg-orange-100 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        {currentCodes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {currentCodes.map((code) => (
              <span key={code} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-100 text-orange-800 border border-orange-200">
                <TrendingUp className="w-3 h-3" />
                {code}
              </span>
            ))}
          </div>
        )}

        <p className="text-xs text-orange-400">
          Tip: for BHP visit{" "}
          <a
            href="https://www.asx.com.au/markets/trade-our-cash-market/announcements.bhp"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            asx.com.au/markets/trade-our-cash-market/announcements.<strong>bhp</strong>
          </a>
          {" "}— replace <em>bhp</em> with the lowercase ticker code.
        </p>
      </div>
    </div>
  );
}

/**
 * The "send it straight from Stock Doctor" bookmarklet, as something to drag to
 * the bookmarks bar. See lib/sd-bridge.ts for what it does and why.
 *
 * The href is set through the DOM rather than as a prop: React refuses to
 * render a `javascript:` URL it is handed. Clicking it HERE does nothing — it
 * only means anything on Stock Doctor's Stock Filter page — so the click is
 * swallowed and the hint is shown instead.
 */
function SdBookmarklet({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(!compact);
  const [nudged, setNudged] = useState(false);
  useEffect(() => {
    if (open) ref.current?.setAttribute("href", bookmarkletHref(window.location.origin));
  }, [open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="ml-auto text-xs text-indigo-500 hover:text-indigo-700 underline"
        title="Load the CSV straight from Stock Doctor, with no download"
      >
        Stock Doctor bookmark
      </button>
    );
  }
  return (
    <div className={`${compact ? "ml-auto" : "w-full max-w-2xl"} rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900`}>
      <p>
        <strong>Skip the download.</strong> Drag{" "}
        <a
          ref={ref}
          onClick={(e) => { e.preventDefault(); setNudged(true); }}
          className="inline-block cursor-grab rounded-md bg-indigo-600 px-2 py-0.5 font-semibold text-white no-underline hover:bg-indigo-700"
          title="Drag me to your bookmarks bar"
        >
          QAV ← Stock Doctor
        </a>{" "}
        to your bookmarks bar. Then, on Stock Doctor&apos;s <em>Stock Filter</em> page, click it: it runs{" "}
        <strong>{SD_FILTER_NAME}</strong>, fetches the export and loads it here — no file, no upload.
        {compact && (
          <button onClick={() => setOpen(false)} className="ml-2 underline text-indigo-500 hover:text-indigo-700">hide</button>
        )}
      </p>
      {nudged && (
        <p className="mt-1 text-xs text-indigo-600">
          It does nothing on this page — drag it to the bookmarks bar and click it on Stock Doctor.
        </p>
      )}
    </div>
  );
}

/**
 * Sign in with the passcode, and say whether this browser is in step with the
 * server. Renders nothing at all until a passcode has been set on the server —
 * with none there is nothing to sign in to, and the app is browser-only as it
 * always was.
 *
 * `card` is the larger form shown on the empty start screen, where signing in
 * is the whole point: on a phone that has never loaded a CSV, it is how the
 * data gets there.
 *
 * A successful sign-in reloads the page. That is the simplest way to make
 * every mount-time load (the sync, QAV history) run again as a signed-in
 * browser, and it happens once per device.
 */
function AccountControl({
  account, sync, onSyncNow, card,
}: {
  account: AccountStatus | null;
  sync: SyncStatus;
  onSyncNow?: () => void;
  card?: boolean;
}) {
  const [open, setOpen] = useState(!!card);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!account?.configured) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    setProblem(null);
    const failed = await signIn(code);
    if (failed) { setProblem(failed); setBusy(false); return; }
    window.location.reload();
  }

  if (account.signedIn) {
    const when = sync.lastSyncAt
      ? new Date(sync.lastSyncAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
      : null;
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
            sync.error
              ? "text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100"
              : "text-sky-700 bg-sky-50 border-sky-200 hover:bg-sky-100"
          }`}
          title={sync.error ?? "Your CSV, Phase 2, 3PTL run, holdings and overrides are stored on the server and shared across your devices."}
        >
          <Cloud className={`w-4 h-4 ${sync.busy ? "animate-pulse" : ""}`} />
          {sync.busy ? "Syncing…" : sync.error ? "Not synced" : when ? `Synced ${when}` : "Synced"}
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg text-sm space-y-2">
            {sync.error && <p className="text-xs text-amber-700">{sync.error}</p>}
            <p className="text-xs text-gray-500">
              Stored on the server behind your passcode, so this opens the same on every device you sign in on.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setOpen(false); onSyncNow?.(); }}
                className="text-indigo-600 hover:text-indigo-800 underline"
              >
                Sync now
              </button>
              <button
                onClick={async () => { await signOut(); window.location.reload(); }}
                className="text-gray-500 hover:text-gray-700 underline"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const form = (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        type="password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Passcode"
        autoComplete="current-password"
        autoFocus={!card}
        className="min-w-0 flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      <button
        type="submit"
        disabled={busy || !code}
        className="px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );

  if (card) {
    return (
      <div className="w-full max-w-2xl rounded-xl border border-sky-200 bg-sky-50 px-5 py-4 space-y-2">
        <p className="text-sm font-semibold text-sky-900 flex items-center gap-1.5">
          <Lock className="w-4 h-4" /> Sign in to load your data on this device
        </p>
        <p className="text-xs text-sky-700">
          Your CSV, Phase 2 data, 3PTL run and holdings are stored on the server. Enter the passcode once and this
          device stays signed in.
        </p>
        {form}
        {problem && <p className="text-xs text-red-600">{problem}</p>}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        title="Sign in to store your data on the server and open it on any device"
      >
        <Lock className="w-4 h-4" />
        Sign in
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg space-y-2">
          <p className="text-xs text-gray-500">
            Signed out, everything stays in this browser only. Sign in to store it on the server and open it anywhere.
          </p>
          {form}
          {problem && <p className="text-xs text-red-600">{problem}</p>}
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const [loading, setLoading] = useState(false);
  const [rawRows, setRawRows] = useState<StockRow[] | null>(null);
  /** The ETFs and funds in the export, set aside before scoring — see
   *  isSetAsideFund. They are not in rawRows, so nothing downstream (scores,
   *  3PTL, buybacks, Phase 2, history, the reporting check) ever sees them. */
  const [fundRows, setFundRows] = useState<StockRow[]>([]);
  const [showFundCodes, setShowFundCodes] = useState(false);
  const [allStocks, setAllStocks] = useState<ScoredStock[] | null>(null);
  const [buyList, setBuyList] = useState<ScoredStock[]>([]);
  const [history, setHistory] = useState<HistorySeries>({});
  /** null = not yet known; false = no POSTGRES_URL, running on the local mirror only. */
  const [historyConfigured, setHistoryConfigured] = useState<boolean | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAll, setShowAll] = useState(false);
  /** Which view the table area is showing. "holdings" is the portfolio. */
  const [view, setView] = useState<"buy" | "all" | "holdings">("buy");
  const [holdings, setHoldings] = useState<StoredHoldings>({ timestamp: null, codes: [] });
  const [holdingsChecking, setHoldingsChecking] = useState(false);
  const [redFlags, setRedFlags] = useState<StoredRedFlags | null>(null);
  const [redFlagChecking, setRedFlagChecking] = useState<{ done: number; total: number } | null>(null);
  /** Where each stock on the reporting-season hold is in its reporting cycle,
   *  read from the ASX — see lib/reporting.ts. Kept in this browser only: it
   *  is re-derived from public data on every device, every day. */
  const [reporting, setReporting] = useState<StoredReporting | null>(null);
  const [reportingChecking, setReportingChecking] = useState(false);
  /** Figures read from a company's own ASX report, standing in for Stock
   *  Doctor's while it is a period behind — see lib/asx-financials.ts. */
  const [asxFinancials, setAsxFinancials] = useState<StoredAsxFinancials | null>(null);
  const [asxReading, setAsxReading] = useState<string | null>(null);
  const [phase2Loaded, setPhase2Loaded] = useState(false);
  const [phase2StockCount, setPhase2StockCount] = useState(0);
  const [phase2Data, setPhase2Data] = useState<Phase2Map | null>(null);
  const [sentimentOverrides, setSentimentOverrides] = useState<StoredSentiments>({});
  const [trendlineData, setTrendlineData] = useState<StoredTrendlines | null>(null);
  const [trendlineChecking, setTrendlineChecking] = useState(false);
  const [trendlineProgress, setTrendlineProgress] = useState<{ done: number; total: number } | null>(null);
  const [trendlineLoaded, setTrendlineLoaded] = useState(false);
  const [commodityData, setCommodityData] = useState<StoredCommodities | null>(null);
  const [commodityChecking, setCommodityChecking] = useState(false);
  const [showCommodityPanel, setShowCommodityPanel] = useState(false);
  /** Which commodity's stock list is open, if any — see the chip onClick. */
  const [commodityStocksFor, setCommodityStocksFor] = useState<string | null>(null);
  const [buybackData, setBuybackData] = useState<BuybackMap | null>(null);
  const [buybackLoaded, setBuybackLoaded] = useState(false);
  const [buybackCount, setBuybackCount] = useState(0);
  const [showBuybackPanel, setShowBuybackPanel] = useState(false);
  const [buybackChecking, setBuybackChecking] = useState(false);
  const [buybackProgress, setBuybackProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  /** When and how the CSV on screen arrived. `remembered` = restored from this
   *  browser's copy of the last load rather than loaded just now. */
  const [csvMeta, setCsvMeta] =
    useState<{ loadedAt: string; source: StoredCsv["source"]; remembered: boolean } | null>(null);
  /** Set by the auto-run so a commodity refresh does not pop its panel open. */
  const commodityQuiet = useRef(false);
  /** null until the server has said whether there is a passcode to sign in
   *  with, and whether this browser already has. */
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(getSyncStatus());
  /** False until the first sync with the server has finished (or it is known
   *  there is none to do). The auto-run waits for it: on a phone the server
   *  may already hold today's 3PTL run, and starting another before finding
   *  that out would be 446 wasted requests. */
  const [syncReady, setSyncReady] = useState(false);
  const [showRateSettings, setShowRateSettings] = useState(false);
  /** Selected sentiment states; empty means no filter. Any combination works. */
  const [filterSentiment, setFilterSentiment] = useState<SentimentKey[]>([]);

  // Rate inputs
  const [cashRate, setCashRate] = useState(DEFAULT_CASH_RATE);
  /** What the RBA currently publishes, for the label and the reset button. */
  const [cashRateLive, setCashRateLive] =
    useState<{ rate: number; since: string | null; stale: boolean } | null>(null);
  /** Set once the user types a rate, so the live value never stomps theirs. */
  const cashRateEdited = useRef(false);
  const [iv1Rate, setIv1Rate] = useState(DEFAULT_RRR * 100);
  const [borrowingRate, setBorrowingRate] = useState(DEFAULT_BORROWING_RATE);

  const rates: ScoringRates = {
    rrr: iv1Rate / 100,
    marketHurdle: (6 + cashRate) / 100,
    borrowingRate: borrowingRate,   // used for dividend yield threshold (Bible Col Q)
  };

  // ── localStorage loaders (called on mount AND when another tab writes) ──────

  function loadPhase2FromStorage() {
    try {
      const raw = localStorage.getItem(PHASE2_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as StoredPhase2;
        const count = Object.values(stored.data).filter(
          (v) => v.S_pe_hi_lo !== null || v.S_equity_inc !== null
        ).length;
        setPhase2Data(stored.data as Phase2Map);
        setPhase2StockCount(count);
        setPhase2Loaded(true);
      } else {
        // Key was deleted in the other tab
        setPhase2Data(null);
        setPhase2StockCount(0);
        setPhase2Loaded(false);
      }
    } catch { /* corrupt — ignore */ }
  }

  function loadTrendlineFromStorage() {
    try {
      const raw = localStorage.getItem(TRENDLINE_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as StoredTrendlines;
        setTrendlineData(stored);
        setTrendlineLoaded(true);
      }
    } catch { /* corrupt — ignore */ }
  }

  function loadCommoditiesFromStorage() {
    try {
      const raw = localStorage.getItem(COMMODITY_STORAGE_KEY);
      if (raw) setCommodityData(JSON.parse(raw) as StoredCommodities);
    } catch { /* corrupt — ignore */ }
  }

  function loadSentimentsFromStorage() {
    try {
      const raw = localStorage.getItem(SENTIMENT_STORAGE_KEY);
      setSentimentOverrides(raw ? (JSON.parse(raw) as StoredSentiments) : {});
    } catch { /* corrupt — ignore */ }
  }

  function loadBuybacksFromStorage() {
    try {
      const raw = localStorage.getItem(BUYBACK_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as StoredBuybacks;
        const bbMap: BuybackMap = {};
        let active = 0;
        for (const [code, entry] of Object.entries(stored.data)) {
          bbMap[code] = entry.active;
          if (entry.active) active++;
        }
        setBuybackData(bbMap);
        setBuybackCount(active);
        setBuybackLoaded(true);
      } else {
        setBuybackData(null);
        setBuybackCount(0);
        setBuybackLoaded(false);
      }
    } catch { /* corrupt — ignore */ }
  }

  // Auto-load on mount + listen for changes from other tabs (e.g. /phase2 in new tab)
  const readRedFlags = useCallback(() => {
    try {
      const raw = localStorage.getItem(REDFLAG_STORAGE_KEY);
      if (raw) setRedFlags(JSON.parse(raw) as StoredRedFlags);
    } catch { /* an unreadable cache is the same as none */ }
  }, []);

  const readAsxFinancials = useCallback(() => {
    try {
      const raw = localStorage.getItem(ASX_FINANCIALS_STORAGE_KEY);
      setAsxFinancials(raw ? JSON.parse(raw) as StoredAsxFinancials : null);
    } catch { /* an unreadable cache is the same as none */ }
  }, []);

  const readReporting = useCallback(() => {
    try {
      const raw = localStorage.getItem(REPORTING_STORAGE_KEY);
      if (raw) setReporting(JSON.parse(raw) as StoredReporting);
    } catch { /* an unreadable cache is the same as none */ }
  }, []);

  useEffect(() => {
    loadPhase2FromStorage();
    loadBuybacksFromStorage();
    loadSentimentsFromStorage();
    loadTrendlineFromStorage();
    loadCommoditiesFromStorage();
    setHoldings(loadHoldings());
    readRedFlags();
    readReporting();
    readAsxFinancials();

    function onStorageChange(e: StorageEvent) {
      if (e.key === HOLDINGS_STORAGE_KEY)  setHoldings(loadHoldings());
      if (e.key === REDFLAG_STORAGE_KEY)   readRedFlags();
      if (e.key === ASX_FINANCIALS_STORAGE_KEY) readAsxFinancials();
      if (e.key === PHASE2_STORAGE_KEY)    loadPhase2FromStorage();
      if (e.key === BUYBACK_STORAGE_KEY)   loadBuybacksFromStorage();
      if (e.key === SENTIMENT_STORAGE_KEY) loadSentimentsFromStorage();
      if (e.key === TRENDLINE_STORAGE_KEY) loadTrendlineFromStorage();
      if (e.key === COMMODITY_STORAGE_KEY) loadCommoditiesFromStorage();
    }

    window.addEventListener("storage", onStorageChange);
    return () => window.removeEventListener("storage", onStorageChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── QAV score history ──────────────────────────────────────────────────────
  // Load the local mirror immediately (so sparklines render on first paint),
  // then merge in whatever the server has. See lib/history-storage.ts for why
  // there are two tiers.
  useEffect(() => {
    (async () => {
      // Precedence, lowest first: bundled seed -> local mirror -> server.
      // The seed (public/history-seed.json) is QAV re-scored from every Stock
      // Doctor CSV export we have, 2026-05-25 onward. Without it the Trend
      // column is empty until you have loaded a CSV on two separate days,
      // which is weeks of waiting for a feature that should work immediately.
      let base: HistorySeries = {};
      try {
        const seedRes = await fetch("/history-seed.json");
        if (seedRes.ok) base = await seedRes.json() as HistorySeries;
      } catch { /* seed is a convenience, never a requirement */ }

      const local = loadLocalHistory();
      if (local) base = mergeSeries(base, local.data);
      setHistory(base);

      try {
        const res = await fetch("/api/history");
        if (!res.ok) return;
        const json = await res.json() as { configured: boolean; data: HistorySeries };
        setHistoryConfigured(json.configured);
        if (json.configured) {
          const merged = mergeSeries(base, json.data ?? {});   // server wins
          setHistory(merged);
          saveLocalHistory(merged);
          // Migrate anything the server has never seen. Without this, history
          // accumulated before the database existed (and the bundled seed)
          // would stay trapped in one browser forever.
          //
          // Keyed per CODE+DATE, not per date. Keying on date alone silently
          // stranded 52 stocks (2026-09-06): the server already held that date
          // from the seed, so the whole day counted as "seen" and codes present
          // only in the local mirror — single-point stocks the seed excludes —
          // were never pushed.
          const seen = new Set<string>();
          for (const [code, pts] of Object.entries(json.data ?? {}))
            for (const p of pts) seen.add(`${code}|${p.d}`);
          const missing: Record<string, HistoryPoint[]> = {};
          for (const [code, pts] of Object.entries(merged)) {
            const gap = pts.filter((p) => !seen.has(`${code}|${p.d}`));
            if (gap.length) missing[code] = gap;
          }
          const byDate: Record<string, { code: string; qav: number | null; quality: number | null;
                                         pcf: number | null; sentiment: string | null; price: number | null }[]> = {};
          for (const [code, pts] of Object.entries(missing))
            for (const p of pts)
              (byDate[p.d] ??= []).push({ code, qav: p.qav, quality: p.quality,
                                          pcf: p.pcf, sentiment: p.sentiment, price: p.price });
          for (const [d, rows] of Object.entries(byDate)) {
            fetch("/api/history", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ date: d, rows }),
            }).catch(() => {});
          }
        } else {
          saveLocalHistory(base);
        }
      } catch { /* offline or not deployed yet — the local mirror still works */ }
    })();
  }, []);

  /**
   * Persist today's scores. Debounced because the re-score effect fires on
   * every rate-slider tick and every manual override — without this a single
   * drag would push dozens of writes. Re-running on the same day simply
   * upserts, so the last (most complete) run of the day is what sticks.
   */
  const recordSnapshot = useCallback((scored: ScoredStock[]) => {
    if (!scored.length) return;
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    snapshotTimer.current = setTimeout(() => {
      const d = todayIso();
      const rows = scored
        .filter((s) => s.QAV !== null)
        .map((s) => ({
          code: s.Code,
          qav: s.QAV,
          quality: s.Quality ?? null,
          pcf: s.PCF ?? null,
          sentiment: s.S_sentiment_long === 2 ? "Bullish"
                   : s.S_sentiment_long === -1 ? "Bearish"
                   : s.S_sentiment_long === 0
                     ? (isJosephineDip(s) ? "Josephine" : "Watch")
                     : null,
          price: typeof s["Share Price ($)"] === "number"
            ? (s["Share Price ($)"] as number)
            : parseFloat(String(s["Share Price ($)"] ?? "").replace(/,/g, "")) || null,
        }));
      if (!rows.length) return;

      const todays: HistorySeries = {};
      for (const r of rows) {
        todays[r.code] = [{
          d, qav: r.qav, quality: r.quality, pcf: r.pcf,
          sentiment: r.sentiment, price: r.price,
        } as HistoryPoint];
      }
      setHistory((prev) => {
        const merged = mergeSeries(prev, todays);
        saveLocalHistory(merged);
        return merged;
      });

      // Best-effort server write; failure is silent by design — the local
      // mirror already holds the snapshot and the next run re-sends it.
      fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: d, rows }),
      })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => { if (j && typeof j.configured === "boolean") setHistoryConfigured(j.configured); })
        .catch(() => {});
    }, 2500);
  }, []);

  // Re-score whenever raw rows, rates, or enrichment data changes
  useEffect(() => {
    if (!rawRows) return;
    // Where Stock Doctor is a period behind and the company's own report has
    // been read, score from the report. The swap happens on the ROW, before
    // anything is scored, so every criterion, the buy list and the hold all
    // follow from the same figures. It undoes itself: a record only applies
    // while Stock Doctor is still on the period it was built on.
    const rows = asxFinancials
      ? rawRows.map((r) => {
          const rec = asxFinancials.data[String(r.Code).toUpperCase()];
          const sdPeriod = parseSdDate(r["Last Period Analysed"]);
          return rec && sdPeriod && isInForce(rec, sdPeriod) ? applyToRow(r, rec) : r;
        })
      : rawRows;
    let scored = scoreStocks(rows, rates);
    scored = enrichWithCsvFreshness(scored, rows);      // freshness from the CSV first
    if (phase2Data)  scored = enrichWithPhase2(scored, phase2Data);
    if (buybackData)  scored = enrichWithBuybacks(scored, buybackData);
    if (trendlineData) scored = enrichWithTrendlines(scored, trendlineData);   // auto 3PTL
    if (commodityData) scored = enrichWithCommodityGate(scored, commodityData); // commodity sell → gate
    if (Object.keys(sentimentOverrides).length > 0)
      scored = enrichWithSentimentOverrides(scored, sentimentOverrides);        // manual wins
    setAllStocks(scored);
    const list = makeBuyList(scored);
    setBuyList(list);
    recordSnapshot(scored);

    // Tell the ETF page which funds the Stock Doctor list holds — see
    // lib/fund-scores.ts. They are set aside when the CSV is loaded and are not
    // scored here any more, so the record carries the name only.
    const funds: Record<string, FundScore> = {};
    for (const r of fundRows) {
      funds[String(r.Code).trim().toUpperCase()] = {
        name: String(r.Name ?? ""),
        // Everything set aside is ranked on the ETF & LIC page.
        isFund: true,
        qav: null, quality: null, pcf: null, count: null, sentiment: null,
        onBuyList: false, hold: false, period: null,
      };
    }
    saveFundScores(funds);
  // `borrowingRate` was missing from this list, so editing "Borrowing Cost" in
  // the Rates panel changed the threshold SHOWN in the breakdown while the
  // dividend score itself (Bible Col Q, yield > borrowing rate) kept the old
  // one until something else happened to trigger a re-score.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, fundRows, cashRate, iv1Rate, borrowingRate, phase2Data, buybackData, trendlineData, commodityData, sentimentOverrides, asxFinancials]);

  /**
   * Load a Stock Doctor CSV from its decoded text, however it arrived — a file
   * dropped by hand, this browser's remembered copy, or the Stock Doctor tab
   * (lib/sd-bridge.ts). Returns the row count; throws if it is not an export.
   *
   * Unless told otherwise it also REMEMBERS the CSV (lib/csv-storage.ts), so
   * the next visit opens on these numbers instead of the upload screen.
   */
  const ingestCsv = useCallback((
    text: string,
    name: string,
    source: StoredCsv["source"],
    opts?: { loadedAt?: string; persist?: boolean },
  ): number => {
    const parsed = parseStockDoctorText(text);
    if (parsed.length === 0) throw new Error("No stock rows found in CSV.");
    // ETFs, funds and listed investment companies leave the data set HERE,
    // before anything is scored. The ETFs are ranked on the ETF page by total
    // return; on the scorecard they were only ever hidden, while still costing
    // a 3PTL request each and counting in the history. What stays is every
    // company — including one too new to have a GICS code, which is why the
    // export carries the unclassified rows at all.
    const rows = parsed.filter((r) => !isSetAsideFund(r));
    const loadedAt = opts?.loadedAt ?? new Date().toISOString();
    const persist = opts?.persist !== false;
    setError(null);
    setRawRows(rows);
    setFundRows(parsed.filter((r) => isSetAsideFund(r)));
    setFileName(name);
    setCsvMeta({ loadedAt, source, remembered: !persist });
    if (persist) saveStoredCsv({ name, loadedAt, source, text });
    // The count the sender is told is what arrived, funds included.
    return parsed.length;
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      ingestCsv(decodeStockDoctorCsv(await file.arrayBuffer()), file.name, "upload");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse CSV.");
    } finally {
      setLoading(false);
    }
  }, [ingestCsv]);

  /** Load this browser's remembered CSV into the page, if there is one. */
  const restoreCsv = useCallback(() => {
    const c = loadStoredCsv();
    if (!c) return;
    try {
      ingestCsv(c.text, c.name, c.source, { loadedAt: c.loadedAt, persist: false });
    } catch { /* a remembered CSV that no longer parses is skipped, not fatal */ }
  }, [ingestCsv]);

  // Reopen on the last CSV this browser loaded, and follow another tab if it
  // loads a newer one — the copy in localStorage is the single source of truth.
  useEffect(() => {
    restoreCsv();
    const onStorage = (e: StorageEvent) => {
      if (e.key === CSV_STORAGE_KEY && e.newValue) restoreCsv();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [restoreCsv]);

  /**
   * SERVER SYNC (lib/server-store.ts). Everything above reads localStorage, so
   * the page paints at once from this browser's own copy; this then asks the
   * server whether it holds anything newer, pulls those stores down, pushes up
   * whatever is newer here, and reloads exactly the stores that changed.
   *
   * Writing localStorage from this same tab raises no `storage` event, which
   * is why the pulled keys are reloaded by hand here rather than through the
   * listener above. The CSV goes last: by then the 3PTL, commodity and buyback
   * stores it will be scored against are already in place, and the auto-run
   * reads their timestamps to decide what still needs doing.
   *
   * It re-runs when the tab comes back into view, no more than once a minute,
   * so a change made on the phone shows up on the desktop without a reload.
   */
  const lastSyncAttempt = useRef(0);
  const runSync = useCallback(async () => {
    lastSyncAttempt.current = Date.now();
    const { pulled } = await syncNow();
    const got = (key: string) => pulled.indexOf(key) >= 0;
    if (got(PHASE2_STORAGE_KEY))    loadPhase2FromStorage();
    if (got(BUYBACK_STORAGE_KEY))   loadBuybacksFromStorage();
    if (got(SENTIMENT_STORAGE_KEY)) loadSentimentsFromStorage();
    if (got(TRENDLINE_STORAGE_KEY)) loadTrendlineFromStorage();
    if (got(COMMODITY_STORAGE_KEY)) loadCommoditiesFromStorage();
    if (got(HOLDINGS_STORAGE_KEY))  setHoldings(loadHoldings());
    if (got(REDFLAG_STORAGE_KEY))   readRedFlags();
    if (got(ASX_FINANCIALS_STORAGE_KEY)) readAsxFinancials();
    if (got(CSV_STORAGE_KEY))       restoreCsv();
  // The loaders are plain functions that only call state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreCsv]);

  useEffect(() => {
    let cancelled = false;
    const off = onSyncStatus((st) => { if (!cancelled) setSyncStatus(st); });
    (async () => {
      const st = await authStatus();
      if (cancelled) return;
      setAccount(st);
      if (st.configured && st.signedIn) await runSync();
      if (!cancelled) setSyncReady(true);
    })();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!getSyncStatus().enabled) return;
      if (Date.now() - lastSyncAttempt.current < 60_000) return;
      void runSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runSync]);

  // The Stock Doctor bridge: accept a CSV posted by the bookmarklet running in
  // a Stock Doctor tab. ONLY that origin is listened to, and the payload is
  // only ever parsed as a CSV. The sender repeats until it is acknowledged
  // (this listener does not exist until the page has hydrated), so a repeat of
  // the CSV just loaded is acknowledged again without being loaded twice.
  const lastBridge = useRef<{ csv: string; rows: number } | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== SD_ORIGIN || !isBridgeCsvMessage(e.data)) return;
      let rows: number;
      if (lastBridge.current && lastBridge.current.csv === e.data.csv) {
        rows = lastBridge.current.rows;
      } else {
        try {
          rows = ingestCsv(e.data.csv, e.data.name, "stockdoctor");
        } catch (err) {
          const why = err instanceof Error ? err.message : "the export could not be read";
          setError(`Stock Doctor export: ${why}`);
          // Tell the sender why, so its banner does not sit waiting.
          const nack: BridgeAckMessage = { type: "qav-csv-ack", rows: 0, error: why };
          try { (e.source as Window | null)?.postMessage(nack, e.origin); } catch { /* sender gone */ }
          return;
        }
        lastBridge.current = { csv: e.data.csv, rows };
      }
      const ack: BridgeAckMessage = { type: "qav-csv-ack", rows };
      try { (e.source as Window | null)?.postMessage(ack, e.origin); } catch { /* sender gone */ }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [ingestCsv]);

  /**
   * Auto-check: fetch each stock's ASX announcement HTML page via the edge
   * server and search it for Appendix 3C / 3D text.
   * URL format: asx.com.au/markets/trade-our-cash-market/announcements.{code}
   */
  const checkBuybacks = useCallback(async () => {
    if (!rawRows) return;
    setBuybackChecking(true);
    setBuybackProgress({ done: 0, total: rawRows.length });
    setError(null);

    const codes = rawRows.map((r) => r.Code);
    const CHUNK = 20;
    const accumulated: BuybackMap = {};
    let activeCount = 0;

    try {
      for (let i = 0; i < codes.length; i += CHUNK) {
        const chunk = codes.slice(i, i + CHUNK);
        const res = await fetch("/api/buybacks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: chunk }),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const data = await res.json() as Record<string, { active: boolean }>;
        for (const [code, entry] of Object.entries(data)) {
          accumulated[code] = entry.active;
          if (entry.active) activeCount++;
        }
        setBuybackProgress({ done: Math.min(i + CHUNK, codes.length), total: codes.length });
      }

      const stored: StoredBuybacks = {
        timestamp: new Date().toISOString(),
        checkedCount: codes.length,
        data: Object.fromEntries(
          Object.entries(accumulated).map(([c, active]) => [c, { active }])
        ),
      };
      setSynced(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
      setBuybackData(accumulated);
      setBuybackCount(activeCount);
      setBuybackLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? `Buyback check: ${e.message}` : "Buyback check failed.");
    } finally {
      setBuybackChecking(false);
      setBuybackProgress(null);
    }
  }, [rawRows]);

  /** Run the 3PTL calculation for all stocks in the CSV via Yahoo Finance monthly data. */
  const calculateTrendlines = useCallback(async () => {
    if (!rawRows) return;
    setTrendlineChecking(true);
    setTrendlineProgress({ done: 0, total: rawRows.length });
    setError(null);

    const codes = rawRows.map((r) => r.Code);
    const CHUNK = 20;
    // Batches in flight at once. The run used to be strictly one batch after
    // another — 23 round trips for ~450 stocks. Measured 2026-11-14 over the
    // full 446-stock universe on a preview: 11.2s one batch at a time, 6.0s
    // with three in flight (retry pass included), and the stored readings were
    // identical for 446 of 446. Three, not more: each batch already fans out
    // to 20 Yahoo requests inside the route, and the ETF ranker has run at
    // this same setting across 388 funds without being throttled.
    const CONCURRENCY = 3;
    const accumulated: StoredTrendlines["data"] = {};
    // Codes the engine could not read on the first pass. A transient Yahoo
    // failure and a genuinely chartless stock both come back as
    // `{ error: "insufficient data" }`. With more requests in flight a hiccup
    // is a little likelier, so every unread code gets ONE more attempt before
    // it is recorded as having no chart.
    const unread: string[] = [];

    type EngineEntry = {
      sentiment?: string; note?: string; error?: string; months?: number;
      events?: { kind?: string; date?: string }[];
    };

    /** Fetch one batch and fold each reading into `accumulated`. */
    const runBatch = async (chunk: string[], firstPass: boolean) => {
      const res = await fetch(TRENDLINE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: chunk }),
      });
      if (!res.ok) throw new Error(`Trendline API error ${res.status}`);
      const data = await res.json() as Record<string, EngineEntry>;
      for (const [code, entry] of Object.entries(data)) {
        if (firstPass && entry.error) { unread.push(code); continue; }
        if (entry.error) {
          // Still unread on the second attempt. Recorded — so the run counts
          // as covering this code — but as "no chart", which leaves the
          // sentiment unscored instead of defaulting it to Watch.
          accumulated[code] = {
            sentiment: null,
            unreadable: true,
            note: typeof entry.months === "number" && entry.months > 0
              ? `No 3PTL yet — only ${entry.months} month${entry.months === 1 ? "" : "s"} of price history`
              : "No 3PTL — no price history could be read",
          };
          continue;
        }
        // Bible Column I: "has it breached the buy line" — so the signal is
        // the most recent BUY event in the walk. enrichWithTrendlines then
        // asks whether it falls after the last results' balance date.
        let lastBuyBreach: string | null = null;
        for (const e of entry.events ?? []) {
          if (e.kind === "BUY" && typeof e.date === "string") {
            if (!lastBuyBreach || e.date > lastBuyBreach) lastBuyBreach = e.date;
          }
        }
        accumulated[code] = {
          // v3 reports Buy / Sell / Watch / Josephine; toStoredSentiment maps
          // both vocabularies, so flipping TRENDLINE_ENDPOINT back to v1
          // needs no other change — v1 simply supplies no events, which
          // leaves the upturn blank, and blank does not penalise.
          sentiment: toStoredSentiment(entry.sentiment),
          note: entry.note,
          lastBuyBreach,
        };
      }
    };

    try {
      const chunks: string[][] = [];
      for (let i = 0; i < codes.length; i += CHUNK) chunks.push(codes.slice(i, i + CHUNK));

      // A small worker pool: each worker takes the next unclaimed batch until
      // none are left. One failed batch still fails the whole run, as before —
      // nothing is stored unless every batch came back.
      let next = 0, done = 0, failed = false;
      const worker = async () => {
        while (!failed && next < chunks.length) {
          const chunk = chunks[next++];
          try {
            await runBatch(chunk, true);
          } catch (e) {
            failed = true;
            throw e;
          }
          done += chunk.length;
          setTrendlineProgress({ done: Math.min(done, codes.length), total: codes.length });
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      // The second attempt, one batch at a time. Whatever comes back now is
      // kept, error or not, so every code still ends the run with an entry.
      const retry = unread.slice();
      for (let i = 0; i < retry.length; i += CHUNK) {
        await runBatch(retry.slice(i, i + CHUNK), false);
      }

      const stored: StoredTrendlines = {
        timestamp: new Date().toISOString(),
        checkedCount: codes.length,
        data: accumulated,
      };
      setSynced(TRENDLINE_STORAGE_KEY, JSON.stringify(stored));
      setTrendlineData(stored);
      setTrendlineLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? `3PTL: ${e.message}` : "3PTL calculation failed.");
    } finally {
      setTrendlineChecking(false);
      setTrendlineProgress(null);
    }
  }, [rawRows]);

  /** Run the 3PTL calculation for the commodity complex (QAV commodity gate). */
  const checkCommodities = useCallback(async () => {
    setCommodityChecking(true);
    setError(null);
    try {
      const res = await fetch(COMMODITY_ENDPOINT);
      if (!res.ok) throw new Error(`Commodity API error ${res.status}`);
      const json = await res.json() as { commodities: Record<string, { sentiment?: string; note?: string; error?: string }> };
      const auto: StoredCommodities["auto"] = {};
      for (const [key, entry] of Object.entries(json.commodities)) {
        if (entry.error || !entry.sentiment) continue;
        auto[key] = {
          // v3 says Buy/Sell/Watch/Josephine. Casting that straight to
          // TrendlineSentiment would have stored "Buy", which is not a key in
          // TRENDLINE_SCORES and would have broken the gate silently.
          sentiment: toStoredSentiment(entry.sentiment),
          note: entry.note,
        };
      }
      const stored: StoredCommodities = {
        timestamp: new Date().toISOString(),
        auto,
        manual: commodityData?.manual ?? {},
      };
      setSynced(COMMODITY_STORAGE_KEY, JSON.stringify(stored));
      setCommodityData(stored);
      // A refresh the auto-run started should not pop the panel open.
      if (!commodityQuiet.current) setShowCommodityPanel(true);
    } catch (e) {
      setError(e instanceof Error ? `Commodity check: ${e.message}` : "Commodity check failed.");
    } finally {
      commodityQuiet.current = false;
      setCommodityChecking(false);
    }
  }, [commodityData]);

  /**
   * Clearing stored manual commodity overrides.
   *
   * The click-to-cycle override was removed on Doug's instruction (2026-10-08):
   * clicking a chip now lists the stocks that commodity governs instead. Every
   * commodity has had an automatic reading since the Pink Sheet went in, so the
   * override had stopped earning its click.
   *
   * `effectiveCommoditySentiment` still honours `manual`, and overrides set
   * before this change are still in localStorage — so without a way to clear
   * them a stale one would gate forever with nothing in the UI to reveal it.
   * The panel surfaces the count and this clears them.
   */
  const clearCommodityOverrides = useCallback(() => {
    setCommodityData((prev) => {
      if (!prev) return prev;
      const stored: StoredCommodities = { ...prev, manual: {} };
      setSynced(COMMODITY_STORAGE_KEY, JSON.stringify(stored));
      return stored;
    });
  }, []);

  /**
   * Red flags — the Bible's qualified-audit check (Column AR) and the
   * corporate-governance Mill Rule. See lib/redflags.ts.
   *
   * Run over a CHOSEN set rather than the whole list: each stock means reading
   * an ASX announcement feed and an Appendix 4E PDF that can be 18MB, so the
   * route caps a batch at 10. That is how Tony does it by hand too — he checks
   * the audit for the top 20-30, "because it takes the most amount of time".
   */
  const checkRedFlags = useCallback(async (codes: string[]) => {
    const batch = Array.from(new Set(codes)).filter(Boolean);
    if (!batch.length) return;
    setRedFlagChecking({ done: 0, total: batch.length });
    setError(null);
    try {
      const byCode = new Map((allStocks ?? []).map((st) => [st.Code, st]));
      const merged: Record<string, RedFlagEntry> = { ...(redFlags?.data ?? {}) };
      for (let i = 0; i < batch.length; i += 10) {
        const chunk = batch.slice(i, i + 10).map((code) => ({
          code,
          // "Last Period Analysed" is the RESULTS date, which is what Listing
          // Rule 4.3A measures the lodgement deadline from.
          balanceDate: (byCode.get(code) as Record<string, unknown> | undefined)?._lastPeriod as string | undefined,
        }));
        const res = await fetch("/api/redflags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: chunk }),
        });
        if (!res.ok) throw new Error(`Red flag API error ${res.status}`);
        Object.assign(merged, await res.json() as Record<string, RedFlagEntry>);
        setRedFlagChecking({ done: Math.min(i + 10, batch.length), total: batch.length });
      }
      const stored: StoredRedFlags = { timestamp: new Date().toISOString(), data: merged };
      setSynced(REDFLAG_STORAGE_KEY, JSON.stringify(stored));
      setRedFlags(stored);
    } catch (e) {
      setError(e instanceof Error ? `Red flags: ${e.message}` : "Red flag check failed.");
    } finally {
      setRedFlagChecking(null);
    }
  }, [allStocks, redFlags]);

  /**
   * Ask the ASX where each of these stocks is in its reporting cycle.
   *
   * Doug, 2026-11-14: "check the reporting season hold on 18 stocks that are
   * flagged ... double check the ASX for any announcements in relation to the
   * numbers and why they are so late. This could basically be a new red flag
   * scenario." This is that check, made a routine: the announcement feed only,
   * no PDFs, so it is light enough to run without being asked.
   *
   * `keep` is the set of codes still on the hold. Anything else is dropped from
   * the store, so a stock that has reported and been re-analysed does not leave
   * a stale answer behind.
   *
   * A failure is silent on purpose. The banner keeps a "not checked" line for
   * whatever is missing and offers the check again; an error box for a
   * background lookup would be noise.
   */
  const checkReporting = useCallback(async (
    targets: { code: string; balanceDate: string }[],
    keep: Set<string>,
  ) => {
    if (!targets.length) return;
    setReportingChecking(true);
    try {
      let stored: StoredReporting | null = null;
      try {
        const raw = localStorage.getItem(REPORTING_STORAGE_KEY);
        stored = raw ? JSON.parse(raw) as StoredReporting : null;
      } catch { /* start clean */ }
      const merged: Record<string, ReportingStatus> = {};
      for (const [code, entry] of Object.entries(stored?.data ?? {})) {
        if (keep.has(code)) merged[code] = entry;
      }
      for (let i = 0; i < targets.length; i += REPORTING_CHUNK) {
        const res = await fetch("/api/redflags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportingOnly: true,
            codes: targets.slice(i, i + REPORTING_CHUNK).map((t) => ({ code: t.code, balanceDate: t.balanceDate })),
          }),
        });
        if (!res.ok) throw new Error(`Reporting check ${res.status}`);
        Object.assign(merged, await res.json() as Record<string, ReportingStatus>);
        const next: StoredReporting = { timestamp: new Date().toISOString(), data: { ...merged } };
        try { localStorage.setItem(REPORTING_STORAGE_KEY, JSON.stringify(next)); } catch { /* quota — state still holds it */ }
        setReporting(next);
      }
    } catch (e) {
      console.warn("Reporting check failed", e);
    } finally {
      setReportingChecking(false);
    }
  }, []);

  /** Replace the stored portfolio. Codes only — see lib/holdings-storage.ts. */
  const saveHoldingCodes = useCallback((codes: string[]) => {
    setHoldings(saveHoldings(codes));
  }, []);


  /**
   * Run 3PTL for a set of held codes and merge the results into the stored
   * trendline data.
   *
   * A holding need not be in the loaded CSV at all — the Stock Doctor filter
   * that produces it is a screen, so anything that has fallen out of favour is
   * missing from it, and those are exactly the holdings most likely to have
   * broken a line. Merging rather than replacing keeps the main table's results
   * intact, so checking three holdings does not discard a 500-stock run.
   */
  const checkHoldings3PTL = useCallback(async (codes: string[]) => {
    const batch = codes.filter(Boolean);
    if (!batch.length) return;
    setHoldingsChecking(true);
    setError(null);
    try {
      const merged: StoredTrendlines["data"] = { ...(trendlineData?.data ?? {}) };
      for (let i = 0; i < batch.length; i += 20) {
        const res = await fetch(TRENDLINE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: batch.slice(i, i + 20) }),
        });
        if (!res.ok) throw new Error(`Trendline API error ${res.status}`);
        const data = await res.json() as Record<string, {
          sentiment?: string; note?: string; error?: string;
          events?: { kind?: string; date?: string }[];
        }>;
        for (const [code, entry] of Object.entries(data)) {
          if (entry.error) {
            merged[code] = { sentiment: null, unreadable: true, note: "No 3PTL — not enough price history" };
            continue;
          }
          let lastBuyBreach: string | null = null;
          for (const e of entry.events ?? []) {
            if (e.kind === "BUY" && typeof e.date === "string") {
              if (!lastBuyBreach || e.date > lastBuyBreach) lastBuyBreach = e.date;
            }
          }
          merged[code] = {
            sentiment: toStoredSentiment(entry.sentiment),
            note: entry.note,
            lastBuyBreach,
          };
        }
      }
      const stored: StoredTrendlines = {
        timestamp: new Date().toISOString(),
        checkedCount: Object.keys(merged).length,
        data: merged,
      };
      setSynced(TRENDLINE_STORAGE_KEY, JSON.stringify(stored));
      setTrendlineData(stored);
      setTrendlineLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? `Holdings 3PTL: ${e.message}` : "Holdings 3PTL check failed.");
    } finally {
      setHoldingsChecking(false);
    }
  }, [trendlineData]);

  /**
   * Add one holding and run its 3PTL immediately.
   *
   * Doug, 2026-10-24: "also make the 3PTL run when a new stock is added." A
   * code added by hand is almost always one just bought, and the reading is the
   * whole reason the holding is tracked — a new row showing "—" until a
   * separate refresh is run would be the wrong default. It is also usually
   * absent from the loaded CSV, so `checkHoldings3PTL` (which merges rather
   * than replaces) is exactly the right path.
   */
  const addHoldingCode = useCallback(async (code: string) => {
    const next = Array.from(new Set([...holdings.codes, code.toUpperCase()]));
    setHoldings(saveHoldings(next));
    await checkHoldings3PTL([code.toUpperCase()]);
  }, [holdings.codes, checkHoldings3PTL]);

  /** Codes the user holds — drives the owned marker in the table. */
  const ownedCodes = useMemo(() => new Set(holdings.codes), [holdings.codes]);

  /**
   * How many holdings have broken their sell line. Shown on the tab itself so
   * the answer to "do I need to act today" costs no clicks — Doug's whole ask:
   * "if they have broken a sell line then I need to know and action it without
   * having to check each one everday."
   *
   * Counts a commodity gate or a manual override too, since either also leaves
   * the holding reading Bearish on the scorecard.
   */
  /**
   * Every stock on the reporting-season hold, with the period Stock Doctor
   * holds for it, in the order the ASX check should take them: those already
   * past the earliest deadline first (the only ones that can be overdue), then
   * anything on the buy list or held, then by QAV.
   */
  const holdTargets = useMemo(() => {
    const today = todayIso();
    const onBuyList = new Set(buyList.map((b) => b.Code));
    return (allStocks ?? [])
      .filter((s) => (s as Record<string, unknown>)._staleData === 1)
      .map((s) => {
        const balanceDate = String((s as Record<string, unknown>)._lastPeriod ?? "").slice(0, 10);
        return {
          code: s.Code,
          balanceDate,
          pastDeadline: !!balanceDate && today > addMonths(balanceDate, EARLIEST_DEADLINE_MONTHS),
          wanted: onBuyList.has(s.Code) || ownedCodes.has(s.Code),
          qav: s.QAV ?? 0,
        };
      })
      .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.balanceDate))
      .sort((a, b) =>
        Number(b.pastDeadline) - Number(a.pastDeadline) ||
        Number(b.wanted) - Number(a.wanted) ||
        b.qav - a.qav);
  }, [allStocks, buyList, ownedCodes]);

  /** The stored answer for a stock, but only while it is about the period the
   *  stock is still on — once Stock Doctor moves forward the old answer is void. */
  const reportingFor = useCallback((code: string, balanceDate: string): ReportingStatus | null => {
    const e = reporting?.data?.[code];
    return e && e.balanceDate === balanceDate ? e : null;
  }, [reporting]);

  /**
   * Run the ASX check for the hold, unprompted, once a day.
   *
   * Runs whenever the hold list holds a stock with no answer from today for the
   * period it is on. `reportingTried` remembers the exact request last made, so
   * a failed lookup is not retried on every re-score — the banner offers it
   * again by hand instead. Capped: in the first weeks of a reporting season
   * most of the list is on hold at once, and the ones that matter are sorted to
   * the front.
   */
  const reportingTried = useRef("");
  useEffect(() => {
    if (!syncReady || holdTargets.length === 0) return;
    const today = todayIso();
    let stored: StoredReporting | null = null;
    try {
      const raw = localStorage.getItem(REPORTING_STORAGE_KEY);
      stored = raw ? JSON.parse(raw) as StoredReporting : null;
    } catch { /* treat as none */ }
    const need = holdTargets
      .filter((t) => {
        const e = stored?.data?.[t.code];
        return !(e && e.balanceDate === t.balanceDate && e.state !== "unknown" && localDay(e.checkedAt) === today);
      })
      .slice(0, AUTO_REPORTING_LIMIT);
    if (need.length === 0) return;
    const signature = `${today}|${need.map((t) => `${t.code}:${t.balanceDate}`).join(",")}`;
    if (reportingTried.current === signature) return;
    reportingTried.current = signature;
    void checkReporting(need, new Set(holdTargets.map((t) => t.code)));
  // checkReporting is stable; holdTargets carries everything this depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdTargets, syncReady]);

  /** Write the ASX-figures store (synced, like the other stores) and state. */
  const saveAsxFinancials = useCallback((data: Record<string, AsxFinancialsRecord>) => {
    const next: StoredAsxFinancials = { timestamp: new Date().toISOString(), data };
    setSynced(ASX_FINANCIALS_STORAGE_KEY, JSON.stringify(next));
    setAsxFinancials(next);
  }, []);

  /** The current store straight from localStorage — a run of reads updates it
   *  several times, and state would be a render behind. */
  const currentAsxFinancials = useCallback((): Record<string, AsxFinancialsRecord> => {
    try {
      const raw = localStorage.getItem(ASX_FINANCIALS_STORAGE_KEY);
      return raw ? { ...(JSON.parse(raw) as StoredAsxFinancials).data } : {};
    } catch { return {}; }
  }, []);

  /** Accept, reject or forget one reading. */
  const updateAsxRecord = useCallback((code: string, change: Partial<AsxFinancialsRecord> | null) => {
    const data = currentAsxFinancials();
    if (change === null) delete data[code];
    else if (data[code]) data[code] = { ...data[code], ...change };
    saveAsxFinancials(data);
  }, [currentAsxFinancials, saveAsxFinancials]);

  /** Stock Doctor's own period for every code in the loaded export. */
  const sdPeriods = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of rawRows ?? []) {
      const iso = parseSdDate(r["Last Period Analysed"]);
      if (iso) out[String(r.Code).toUpperCase()] = iso;
    }
    return out;
  }, [rawRows]);

  /**
   * Read the ASX report for one stock and store what it says.
   *
   * The route does the reading and returns only what is in the public report.
   * Stock Doctor's side of the reconciliation — its cash flow, EPS, equity and
   * share count — is taken from the export here, in the browser.
   */
  const readAsxReport = useCallback(async (code: string): Promise<void> => {
    const row = (rawRows ?? []).find((r) => String(r.Code).toUpperCase() === code);
    const period = row ? parseSdDate(row["Last Period Analysed"]) : null;
    if (!row || !period) return;
    setAsxReading(code);
    try {
      const res = await fetch("/api/asx-financials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, balanceDate: period }),
      });
      if (!res.ok) throw new Error(`ASX report ${res.status}`);
      const read = await res.json() as AsxRead;
      const numberOf = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
      const record = deriveFromReport({
        period,
        cf: numberOf(row["CF: Net Operating ($)"]),
        eps: numberOf(row["EPS Bef Abnormals (c)"]),
        equity: numberOf(row["Equity ($)"]),
        sharesM: numberOf(row["Shares Outstanding (M)"]),
      }, read);
      const data = currentAsxFinancials();
      data[code] = record;
      saveAsxFinancials(data);
    } catch (e) {
      console.warn("ASX report read failed", code, e);
    } finally {
      setAsxReading(null);
    }
  }, [rawRows, currentAsxFinancials, saveAsxFinancials]);

  /**
   * Read the report, unprompted, for every buy-list stock the reporting check
   * found has reported while Stock Doctor has not caught up.
   *
   * Doug, 2026-11-14: "for stocks on the buy list that are on the hold due to
   * SD not updating their data. Download their updated reports from the ASX and
   * read them ... We keep that data stored until a SD update is available."
   *
   * One read per (stock, Stock Doctor period): a stored record of any status —
   * applied, waiting for his OK, rejected, unreadable — means it has been done.
   * The same pass DROPS records Stock Doctor has since overtaken, which is the
   * "until a SD update is available" half.
   */
  const asxTried = useRef(new Set<string>());
  useEffect(() => {
    if (!syncReady || !rawRows || !allStocks) return;
    const data = currentAsxFinancials();
    const overtaken = Object.keys(data).filter((code) => sdPeriods[code] !== data[code].basedOn);
    if (overtaken.length) {
      for (const code of overtaken) delete data[code];
      saveAsxFinancials(data);
      return;                       // the save re-runs this effect
    }
    if (asxReading) return;
    // Companies only. A fund's annual report has a cash flow statement too,
    // but its "operating cash flow" is distributions and unit trades — there is
    // no QAV reading to be had from it, whatever the ETF toggle says.
    const onBuyList = new Set(buyList.filter((b) => !isEtfOrFund(b)).map((b) => b.Code));
    const next = Object.keys(reporting?.data ?? {}).find((code) => {
      const r = reporting!.data[code];
      const key = `${code}:${r.balanceDate}`;
      return r.state === "reported" && sdPeriods[code] === r.balanceDate && onBuyList.has(code)
        && !data[code] && !asxTried.current.has(key);
    });
    if (!next) return;
    asxTried.current.add(`${next}:${reporting!.data[next].balanceDate}`);
    void readAsxReport(next);
  // readAsxReport and the two store helpers change only with rawRows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncReady, rawRows, allStocks, buyList, reporting, asxFinancials, asxReading, sdPeriods]);

  /**
   * The red flags as shown: the stored check, plus "results overdue" from the
   * reporting check. That one is merged in here, not written into the red-flag
   * store, because the two are refreshed on different clocks — red flags when
   * Doug presses the button, reporting every day — and an overdue marker must
   * disappear by itself the day the company reports.
   */
  const redFlagView = useMemo(() => {
    const out: Record<string, RedFlagEntry> = {};
    const periodOf = new Map((allStocks ?? []).map((st) =>
      [st.Code, String((st as Record<string, unknown>)._lastPeriod ?? "").slice(0, 10)] as [string, string]));
    for (const [code, entry] of Object.entries(redFlags?.data ?? {})) {
      // An "overdue" recorded by the full check is only true for the period it
      // was measured on.
      const stale = entry.reporting && periodOf.has(code) && periodOf.get(code) !== entry.reporting.balanceDate;
      out[code] = stale
        ? { ...entry, governance: entry.governance.filter((g) => g.kind !== "overdue") }
        : entry;
    }
    for (const [code, r] of Object.entries(reporting?.data ?? {})) {
      if (periodOf.get(code) !== r.balanceDate) continue;
      const prev = out[code];
      const rest = (prev?.governance ?? []).filter((g) => g.kind !== "overdue");
      if (r.state !== "overdue") {
        // Today's answer supersedes an older "overdue" from the full check.
        if (prev && r.state !== "unknown" && rest.length !== prev.governance.length) out[code] = { ...prev, governance: rest };
        continue;
      }
      const hit: GovernanceHit = { kind: "overdue", date: r.dueBy, detail: r.detail };
      out[code] = prev
        ? { ...prev, governance: [...rest, hit] }
        : { audit: "unknown", auditReason: "audit not checked", governance: [hit], checkedAt: r.checkedAt };
    }
    return out;
  }, [redFlags, reporting, allStocks]);

  /** How many stocks carry a red flag — shown on the toolbar button. */
  const redFlagCount = useMemo(
    () => Object.values(redFlagView).filter(hasRedFlag).length,
    [redFlagView],
  );

  const holdingAlertCount = useMemo(() => {
    const byCode = new Map((allStocks ?? []).map((st) => [st.Code, st]));
    return holdings.codes.filter((code) => {
      if (isHoldingAlert(trendlineData?.data?.[code]?.sentiment)) return true;
      if (byCode.get(code)?.S_sentiment_long === -1) return true;
      // The commodity gate, same as the panel computes it — a holding absent
      // from the CSV has no scored row to carry it, so without this the badge
      // undercounts exactly the holdings the list exists to watch.
      const ck = STOCK_COMMODITY[code];
      if (!ck || !commodityData) return false;
      const def = COMMODITIES.find((c) => c.key === ck);
      const advisory = !!def?.proxy && commodityData.manual[ck] === undefined;
      return effectiveCommoditySentiment(commodityData, ck) === "Bearish" && !advisory;
    }).length;
  }, [holdings.codes, trendlineData, allStocks, commodityData]);

  /** Set or clear a manual 3PTL sentiment override for one stock. */
  const saveSentimentOverride = useCallback((code: string, value: SentimentOverride | null) => {
    setSentimentOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[code];
      else next[code] = value;
      setSynced(SENTIMENT_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** Save a set of buyback codes (from manual entry) to state + localStorage. */
  const saveBuybacks = useCallback((activeCodes: string[]) => {
    const map: BuybackMap = {};
    activeCodes.forEach((c) => { map[c.toUpperCase()] = true; });
    const stored: StoredBuybacks = {
      timestamp: new Date().toISOString(),
      checkedCount: activeCodes.length,
      data: Object.fromEntries(activeCodes.map((c) => [c.toUpperCase(), { active: true }])),
    };
    setSynced(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
    setBuybackData(map);
    setBuybackCount(activeCodes.length);
    setBuybackLoaded(true);
    setShowBuybackPanel(false);
  }, []);

  // Live RBA cash rate. Runs once on mount; the route is edge-cached for six
  // hours and falls back to DEFAULT_CASH_RATE if the RBA is unreachable, so
  // this never blocks or breaks the page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/cash-rate");
        if (!res.ok) return;
        const d = await res.json() as { rate?: number; since?: string | null; stale?: boolean };
        if (cancelled || typeof d.rate !== "number" || !isFinite(d.rate)) return;
        setCashRateLive({ rate: d.rate, since: d.since ?? null, stale: !!d.stale });
        if (!cashRateEdited.current) setCashRate(d.rate);
      } catch { /* keep the compiled-in default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * AUTO-RUN. When a CSV lands — dropped, remembered, or sent from Stock
   * Doctor — start every check that has not already run TODAY, instead of
   * waiting for four separate buttons to be clicked after each upload.
   *
   * Doug, 2026-11-14: "Can more be automated..". Each of these already stored
   * its results with a timestamp, so "has it run today" needs nothing new.
   *
   *   3PTL          unless today's run already covers every code in this CSV
   *   Commodities   unless refreshed today (quietly — the panel stays shut)
   *   Buybacks      unless scanned today — and NOT when the stored list was
   *                 typed in by hand, which the scan would overwrite. The two
   *                 are told apart by shape: the scan stores every code it
   *                 checked, active or not; the manual panel stores only the
   *                 active ones.
   *
   * Red flags are deliberately left on their button: each stock is an ASX feed
   * plus an Appendix 4E PDF that can run to 18MB, over a set he chooses.
   *
   * The timestamps are read straight from localStorage, not from state, so the
   * decision does not depend on which of this page's effects happened to run
   * first on mount. It also waits for the first server sync (`syncReady`), so a
   * device that has just pulled today's run does not repeat it.
   *
   * Once per CSV: `autoRanFor` holds the row array it last ran for, so a
   * re-score from a rate change or an override does not start it again.
   * To switch it off, return early here.
   */
  const autoRanFor = useRef<StockRow[] | null>(null);
  useEffect(() => {
    if (!rawRows || !syncReady || autoRanFor.current === rawRows) return;
    autoRanFor.current = rawRows;

    // Where a run lands. Doug, 2026-11-14: "finish on the buy list screen."
    // Set once per CSV, here, so it is the starting point and not a lock: he
    // can move to another tab and it stays that way until the next CSV
    // arrives. (The same instruction switched on "ETFs hidden"; the funds are
    // now out of the data set altogether, so there is nothing left to hide.)
    setView("buy");
    setShowAll(false);

    const today = todayIso();
    const ranToday = (iso: string | null | undefined): boolean => {
      if (!iso) return false;
      const d = new Date(iso);
      if (isNaN(d.getTime())) return false;
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return local === today;
    };
    const read = (key: string): unknown => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    };

    const tl = read(TRENDLINE_STORAGE_KEY) as StoredTrendlines | null;
    const covered = !!tl && ranToday(tl.timestamp) && rawRows.every((r) => !!tl.data?.[r.Code]);
    if (!covered) void calculateTrendlines();

    const com = read(COMMODITY_STORAGE_KEY) as StoredCommodities | null;
    if (!ranToday(com?.timestamp)) {
      commodityQuiet.current = true;
      void checkCommodities();
    }

    const bb = read(BUYBACK_STORAGE_KEY) as StoredBuybacks | null;
    const entries = bb ? Object.values(bb.data ?? {}) : [];
    const typedByHand = entries.length > 0 && entries.every((e) => e.active);
    if (!typedByHand && !ranToday(bb?.timestamp)) void checkBuybacks();
  // Deliberately keyed on the CSV (and on the first server sync having
  // finished). The callbacks are rebuilt on almost every render; listing them
  // would re-run this on each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, syncReady]);

  const reset = useCallback(() => {
    setRawRows(null);
    setFundRows([]);
    setAllStocks(null);
    setBuyList([]);
    setShowAll(false);
    // Phase 2 + buybacks are stored in localStorage — persist across CSV uploads intentionally
    // "New CSV" also forgets the remembered one; otherwise the next visit
    // would reopen on the CSV he just chose to replace.
    clearStoredCsv();
    setCsvMeta(null);
    setFileName(null);
    setError(null);
  }, []);

  const displayedStocks = showAll ? (allStocks ?? []) : buyList;

  function applyTableFilters(arr: ScoredStock[]): ScoredStock[] {
    let result = arr;
    if (filterSentiment.length > 0) {
      result = result.filter((s) => {
        const k = sentimentKeyOf(s.S_sentiment_long, isJosephineDip(s));
        return k !== null && filterSentiment.indexOf(k) >= 0;
      });
    }
    return result;
  }
  const statsAll = applyTableFilters(allStocks ?? []);
  const statsBuyList = applyTableFilters(buyList);

  const marketHurdle = (6 + cashRate) / 100;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      {/* PHONE WIDTH. The header used to be one unwrapping row, so on a
          phone everything after the first two buttons ran off the right edge
          and could not be reached. It now wraps; and because a wrapped header
          is three rows tall, it only stays pinned to the top from tablet
          width up — pinned on a phone it would cover a third of the screen. */}
      <header className="bg-white border-b border-gray-200 md:sticky md:top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="order-1 flex items-center gap-3">
            <div className="bg-indigo-600 rounded-lg p-2">
              <BarChart2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-none">QAV Scorecard</h1>
              <p className="hidden sm:block text-xs text-gray-400 mt-0.5">ASX Stock Ranker — Tony Kynaston method</p>
            </div>
          </div>
          {/* SIGN IN — the far top right, at every width. It used to be the
              first button of the group below, which put it at the LEFT end of
              a wrapped row; its panel opens leftwards from the button, so it
              ran off the left edge of the screen and the passcode box could
              barely be reached (Doug, 2026-11-14). Up here its right edge is
              the page's right edge, so the panel always opens on screen.
              On a very wide window all three parts share one row and this is
              ordered last; narrower, it stays on the title's row and the
              buttons take the rows below. */}
          <div className="order-2 2xl:order-3 ml-auto 2xl:ml-0">
            <AccountControl account={account} sync={syncStatus} onSyncNow={runSync} />
          </div>
          <div className="order-3 2xl:order-2 basis-full 2xl:basis-auto 2xl:ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {/* The ETF ranker, which used to be a separate site. Same tab: the
                CSV is remembered now, so coming back costs nothing. */}
            <Link
              href="/etf"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors text-gray-600 border-gray-300 hover:bg-gray-50"
              title="Rank ASX ETFs and listed investment companies by 3PTL, net yield, fee and total return"
            >
              <BarChart2 className="w-4 h-4" />
              ETFs &amp; LICs
            </Link>
            {/* Phase 2 — opens in new tab so the CSV session is not lost */}
            <Link
              href="/phase2"
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                phase2Loaded
                  ? "text-teal-700 bg-teal-50 border-teal-200 hover:bg-teal-100"
                  : "text-gray-500 border-gray-300 hover:bg-gray-50"
              }`}
              title="Manage Phase 2 data — opens in new tab so your scorecard session is preserved"
            >
              <Database className="w-4 h-4" />
              {phase2Loaded ? `Phase 2 · ${phase2StockCount} stocks` : "Set up Phase 2"}
            </Link>

            {allStocks && (
              <>
                <button
                  onClick={() => setShowRateSettings((v) => !v)}
                  className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                    showRateSettings
                      ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                  title="Adjust hurdle rates"
                >
                  <Settings2 className="w-4 h-4" />
                  Rates
                </button>

                {/* 3PTL auto-calculation */}
                {!trendlineChecking && (
                  <button
                    onClick={calculateTrendlines}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                      trendlineLoaded
                        ? "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
                        : "text-gray-500 border-gray-300 hover:bg-gray-50"
                    }`}
                    title="Calculate 3PTL (3-Point Trendline) from 5yr monthly Yahoo Finance data — v3 sequential walk"
                  >
                    <Activity className="w-4 h-4" />
                    {trendlineLoaded ? "3PTL ✓" : "Calc 3PTL"}
                  </button>
                )}
                {trendlineChecking && trendlineProgress && (
                  <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-violet-700 bg-violet-50 border border-violet-200 rounded-lg">
                    <Activity className="w-4 h-4 animate-pulse" />
                    <span>{trendlineProgress.done}/{trendlineProgress.total}</span>
                    <div className="w-16 h-1.5 bg-violet-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-violet-500 rounded-full transition-all"
                        style={{ width: `${(trendlineProgress.done / trendlineProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Commodity 3PTL gate — underlying commodity in Sell = don't buy the stock */}
                <button
                  onClick={commodityData && !commodityChecking ? () => setShowCommodityPanel((v) => !v) : checkCommodities}
                  disabled={commodityChecking}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                    commodityData
                      ? "text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100"
                      : "text-gray-500 border-gray-300 hover:bg-gray-50"
                  }`}
                  title="3PTL sentiment for the commodity complex — stocks whose underlying commodity is Bearish are gated off the buy list"
                >
                  <BarChart2 className={`w-4 h-4 ${commodityChecking ? "animate-pulse" : ""}`} />
                  {commodityChecking ? "Commodities…" : commodityData ? "Commodities ✓" : "Commodities"}
                </button>

                {/* Red flags — qualified audit (Bible Col AR) + the governance
                    Mill Rule. Run over holdings and the top of the buy list,
                    not the whole CSV: each stock means an ASX feed plus an
                    Appendix 4E PDF that can run to 18MB. */}
                {redFlagChecking ? (
                  <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
                    <AlertTriangle className="w-4 h-4 animate-pulse" />
                    <span>{redFlagChecking.done}/{redFlagChecking.total}</span>
                  </div>
                ) : (
                  <button
                    onClick={() => checkRedFlags([
                      ...holdings.codes,
                      ...buyList.slice(0, 20).map((st) => st.Code),
                    ])}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                      redFlagCount > 0
                        ? "text-red-700 bg-red-50 border-red-200 hover:bg-red-100"
                        : redFlags
                          ? "text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
                          : "text-gray-500 border-gray-300 hover:bg-gray-50"
                    }`}
                    title={"Check the Appendix 4E for a qualified audit (Bible Column AR) and the ASX feed for corporate governance breaches (the Mill Rule).\n" +
                           "Covers your holdings plus the top 20 of the buy list.\n" +
                           "Results overdue — a reporting deadline passed with nothing lodged — is checked daily for every stock on the reporting-season hold, without pressing this."}
                  >
                    <AlertTriangle className="w-4 h-4" />
                    {/* The count comes first: a "results overdue" marker arrives
                        from the daily reporting check, with or without this
                        button ever having been pressed. */}
                    {redFlagCount > 0
                      ? `${redFlagCount} red flag${redFlagCount !== 1 ? "s" : ""}`
                      : redFlags ? "Red flags ✓" : "Check Red Flags"}
                  </button>
                )}

                {/* Buyback — auto-check + manual fallback */}
                {!buybackChecking && (
                  <button
                    onClick={checkBuybacks}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                      buybackLoaded
                        ? "text-orange-700 bg-orange-50 border-orange-200 hover:bg-orange-100"
                        : "text-gray-500 border-gray-300 hover:bg-gray-50"
                    }`}
                    title="Scan ASX announcement pages for Appendix 3C / 3D buyback filings"
                  >
                    <TrendingUp className="w-4 h-4" />
                    {buybackLoaded ? `${buybackCount} buyback${buybackCount !== 1 ? "s" : ""}` : "Check Buybacks"}
                  </button>
                )}
                {buybackChecking && buybackProgress && (
                  <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg">
                    <TrendingUp className="w-4 h-4 animate-pulse" />
                    <span>{buybackProgress.done}/{buybackProgress.total}</span>
                    <div className="w-16 h-1.5 bg-orange-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500 rounded-full transition-all"
                        style={{ width: `${(buybackProgress.done / buybackProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setShowBuybackPanel((v) => !v)}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-400 hover:bg-gray-50 transition-colors"
                  title="Manually enter buyback codes"
                >
                  ✎
                </button>

                <button
                  onClick={reset}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <UploadCloud className="w-4 h-4" />
                  New CSV
                </button>
              </>
            )}
          </div>
        </div>

        {/* Commodity 3PTL panel */}
        {showCommodityPanel && (
          <div className="border-t border-amber-100 bg-amber-50/60 px-6 py-3">
            <div className="max-w-screen-2xl mx-auto space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {COMMODITIES.map((c) => {
                  const manual = commodityData?.manual[c.key];
                  const auto = commodityData?.auto[c.key];
                  const eff = effectiveCommoditySentiment(commodityData, c.key);
                  // Watch needs its own palette: without it a Watch commodity
                  // fell through to the "not set" dashed style and read as
                  // unset, which v3 can now actually produce.
                  const palette =
                    eff === "Bullish"   ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
                    eff === "Bearish"   ? "bg-red-100 text-red-800 border-red-300" :
                    eff === "Watch"     ? "bg-sky-100 text-sky-800 border-sky-300" :
                    eff === "Josephine" ? "bg-yellow-100 text-yellow-800 border-yellow-300" :
                                          "bg-white text-gray-400 border-dashed border-gray-300";
                  const open = commodityStocksFor === c.key;
                  const governs = Object.keys(STOCK_COMMODITY)
                    .filter((code) => STOCK_COMMODITY[code] === c.key).length;
                  return (
                    <button
                      key={c.key}
                      onClick={() => setCommodityStocksFor(open ? null : c.key)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${palette} ${open ? "ring-2 ring-amber-400" : ""}`}
                      title={`${c.label}: ${eff ?? "not set"}${manual ? " (MANUAL override)" : auto ? " (auto 3PTL)" : ""}${auto?.note ? `\n${auto.note}` : ""}${c.proxy ? `\n\n${c.proxy}` : ""}\n\nClick to ${open ? "hide" : "list"} the ${governs} stock${governs === 1 ? "" : "s"} this commodity governs`}
                    >
                      {c.label}{c.proxy ? "*" : ""} {eff === "Bullish" ? "▲" : eff === "Bearish" ? "▼" : eff === "Watch" ? "◇" : eff === "Josephine" ? "◆" : "—"}
                      {governs > 0 && <span className="ml-1 opacity-50">{governs}</span>}
                      {manual && <span className="ml-1 opacity-60">✎</span>}
                    </button>
                  );
                })}
              </div>
              {/* The stocks one commodity governs — the chip click opens this. */}
              {commodityStocksFor && (() => {
                const def = COMMODITIES.find((c) => c.key === commodityStocksFor);
                const eff = effectiveCommoditySentiment(commodityData, commodityStocksFor);
                const codes = Object.keys(STOCK_COMMODITY)
                  .filter((code) => STOCK_COMMODITY[code] === commodityStocksFor)
                  .sort();
                const byCode = new Map((allStocks ?? []).map((s) => [s.Code, s]));
                const gating = eff === "Bearish" && !(def?.proxy && commodityData?.manual[commodityStocksFor] === undefined);
                return (
                  <div className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                      <strong className="text-amber-900">{def?.label}{def?.proxy ? "*" : ""}</strong>
                      <span className="text-amber-700">{eff ?? "not set"}</span>
                      <span className="text-amber-600">
                        governs {codes.length} stock{codes.length === 1 ? "" : "s"} ·{" "}
                        {gating
                          ? "Bearish, so every one of them is forced to Bearish"
                          : eff === "Bearish"
                            ? "Bearish but advisory (proxy), so it gates nothing"
                            : "not gating"}
                      </span>
                      <button onClick={() => setCommodityStocksFor(null)} className="ml-auto underline text-amber-700 hover:text-amber-900">close</button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {codes.map((code) => {
                        const s = byCode.get(code);
                        const held = !!s;
                        const sent = s ? (s.S_sentiment_long === 2 ? "Bullish"
                          : s.S_sentiment_long === -1 ? "Bearish"
                          : s.S_sentiment_long === 0 ? (isJosephineDip(s) ? "Josephine" : "Watch")
                          : null) : null;
                        const tone = !held ? "bg-gray-50 text-gray-400 border-gray-200"
                          : sent === "Bullish" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : sent === "Bearish" ? "bg-red-50 text-red-800 border-red-200"
                          : sent === "Watch" ? "bg-sky-50 text-sky-800 border-sky-200"
                          : sent === "Josephine" ? "bg-yellow-50 text-yellow-800 border-yellow-200"
                          : "bg-white text-gray-600 border-gray-200";
                        return (
                          <span
                            key={code}
                            className={`px-2 py-0.5 rounded border text-xs font-medium ${tone}`}
                            title={held
                              ? `${code}: ${sent ?? "no sentiment"}${s?.QAV != null ? ` · QAV ${s.QAV}` : ""}`
                              : `${code}: not in the loaded CSV`}
                          >
                            {code}
                            {held && s?.QAV != null && <span className="ml-1 opacity-60">{s.QAV}</span>}
                          </span>
                        );
                      })}
                    </div>
                    {!allStocks?.length && (
                      <p className="mt-2 text-xs text-amber-600">Load a CSV to see each one&apos;s sentiment and QAV.</p>
                    )}
                  </div>
                );
              })()}
              <div className="flex flex-wrap items-center gap-4 text-xs text-amber-700">
                <span>
                  Stocks whose underlying commodity is <strong>Bearish</strong> are forced to Bearish sentiment (QAV commodity rule).
                  A <strong>proxy*</strong> commodity is advisory only — its automatic read never gates.
                  Gold, Silver, Copper, Oil, Brent, Nat Gas, Aluminium, Platinum, Iron Ore, Nickel and Coal
                  come from the World Bank Pink Sheet (gapless monthly, updated monthly). Palladium and
                  Uranium use Yahoo futures. <strong>Lithium* is a proxy</strong> — the LIT ETF of miner
                  and battery equities, not the lithium price, so read it against{" "}
                  <a href="https://tradingeconomics.com/commodity/lithium" target="_blank" rel="noreferrer" className="underline">Trading Economics</a>.
                  Click a chip to list the stocks it governs; the number on each chip is that count.
                </span>
                {!!commodityData && Object.keys(commodityData.manual).length > 0 && (
                  <button onClick={clearCommodityOverrides} className="underline hover:text-amber-900" title="Click-to-override was removed; these were set before that change and still gate.">
                    clear {Object.keys(commodityData.manual).length} stored manual override{Object.keys(commodityData.manual).length === 1 ? "" : "s"} (✎)
                  </button>
                )}
                <button onClick={checkCommodities} disabled={commodityChecking} className="underline hover:text-amber-900">
                  {commodityChecking ? "Refreshing…" : "Refresh auto 3PTL"}
                </button>
                {commodityData?.timestamp && (
                  <span className="text-amber-500">updated {new Date(commodityData.timestamp).toLocaleDateString()}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Buyback manual entry panel */}
        {showBuybackPanel && (
          <BuybackPanel
            currentCodes={buybackData ? Object.keys(buybackData).filter((c) => buybackData[c]) : []}
            onSave={saveBuybacks}
            onClose={() => setShowBuybackPanel(false)}
          />
        )}

        {/* Rate settings panel */}
        {showRateSettings && (
          <div className="border-t border-indigo-100 bg-indigo-50 px-6 py-4">
            <div className="max-w-screen-2xl mx-auto flex flex-wrap items-end gap-8">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  RBA Cash Rate (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0} max={20} step={0.05} value={cashRate}
                    onChange={(e) => { cashRateEdited.current = true; setCashRate(parseFloat(e.target.value) || 0); }}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    → IV2 hurdle = {(marketHurdle * 100).toFixed(2)}%
                    <span className="ml-1 text-indigo-400">(6% + {cashRate}%)</span>
                  </span>
                </div>
                {cashRateLive && !cashRateLive.stale ? (
                  <p className="text-xs text-indigo-400">
                    RBA target {cashRateLive.rate}%
                    {cashRateLive.since ? ` since ${cashRateLive.since}` : ""}
                    {Math.abs(cashRateLive.rate - cashRate) > 1e-9 && (
                      <button
                        onClick={() => { cashRateEdited.current = false; setCashRate(cashRateLive.rate); }}
                        className="ml-1 underline hover:text-indigo-600"
                      >
                        use it
                      </button>
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-indigo-400">
                    RBA check unavailable — using the built-in {DEFAULT_CASH_RATE}%
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  IV1 Hurdle Rate (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={50} step={0.05} value={iv1Rate}
                    onChange={(e) => setIv1Rate(parseFloat(e.target.value) || DEFAULT_RRR * 100)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    Tony&apos;s default: {DEFAULT_RRR * 100}% — set to your mortgage rate
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  Borrowing Cost (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0} max={30} step={0.05} value={borrowingRate}
                    onChange={(e) => setBorrowingRate(parseFloat(e.target.value) || 0)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    Div yield above this → income covers borrowing cost
                  </span>
                </div>
              </div>
              <button
                onClick={() => {
                  cashRateEdited.current = false;
                  setCashRate(cashRateLive?.rate ?? DEFAULT_CASH_RATE);
                  setIv1Rate(DEFAULT_RRR * 100);
                  setBorrowingRate(DEFAULT_BORROWING_RATE);
                }}
                className="text-xs text-indigo-500 hover:text-indigo-700 underline pb-1.5"
              >
                Reset to defaults
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Reporting-season hold: numbers > 6 months old — and, from the ASX,
            WHY each one is. Doug, 2026-11-14: "double check the ASX for any
            announcements in relation to the numbers and why they are so late.
            This could basically be a new red flag scenario."

            One amber label was covering three different situations (see
            lib/reporting.ts): a report that is simply not due yet, a report
            that is out but not in Stock Doctor, and a report that is overdue.
            Only the last is a red flag; only the second means the score is
            built on superseded numbers. The hold itself is unchanged — all
            three are still "do not buy on these numbers". */}
        {(() => {
          if (!allStocks) return null;
          const today = todayIso();
          const onBuyList = new Set(buyList.map((b) => b.Code));
          type Row = {
            code: string; age: number; onBuyList: boolean; bucket: "overdue" | "reported" | "awaiting" | "unchecked";
            dueBy: string | null; since: string | null; title: string;
          };
          const rows: Row[] = allStocks
            .filter((s) => (s as Record<string, unknown>)._staleData === 1)
            .map((s) => {
              const balanceDate = String((s as Record<string, unknown>)._lastPeriod ?? "").slice(0, 10);
              const age = (s as Record<string, unknown>)._dataMonthsOld as number;
              const r = reportingFor(s.Code, balanceDate);
              const base = { code: s.Code, age, onBuyList: onBuyList.has(s.Code) };
              const prefix = `${s.Code} — Stock Doctor's numbers are for ${periodLabel(balanceDate)}, ${age.toFixed(1)} months old. `;
              if (r && r.state === "overdue") {
                return { ...base, bucket: "overdue" as const, dueBy: r.dueBy, since: null, title: prefix + r.detail };
              }
              if (r && r.state === "reported") {
                return { ...base, bucket: "reported" as const, dueBy: null, since: r.first?.date ?? null, title: prefix + r.detail };
              }
              if (r && (r.state === "awaiting" || r.state === "current")) {
                return { ...base, bucket: "awaiting" as const, dueBy: r.dueBy, since: null, title: prefix + r.detail };
              }
              // Not checked (or the feed could not answer). Before the earliest
              // possible deadline the dates alone settle it: it cannot be late.
              const earliest = balanceDate ? addMonths(balanceDate, EARLIEST_DEADLINE_MONTHS) : null;
              if (earliest && today <= earliest) {
                return {
                  ...base, bucket: "awaiting" as const, dueBy: earliest, since: null,
                  title: prefix + `Not late: the next report is not due before ${formatDay(earliest)}. Not yet checked against the ASX.`,
                };
              }
              return {
                ...base, bucket: "unchecked" as const, dueBy: null, since: null,
                title: prefix + (r ? r.detail : "Not yet checked against the ASX."),
              };
            })
            .sort((a, b) => Number(b.onBuyList) - Number(a.onBuyList) || b.age - a.age);
          if (rows.length === 0) return null;
          const listed = rows.filter((r) => r.onBuyList).length;
          const of = (bucket: Row["bucket"]) => rows.filter((r) => r.bucket === bucket);
          const overdue = of("overdue"), reported = of("reported"), awaiting = of("awaiting"), unchecked = of("unchecked");
          // "20 Aug" this year, "29 Sep 2023" otherwise — WMC's is three years old.
          const shortDay = (iso: string | null) =>
            !iso ? "" : iso.slice(0, 4) === today.slice(0, 4) ? formatDay(iso).replace(/ \d{4}$/, "") : formatDay(iso);
          const chip = (r: Row, note: string, tone: string) => (
            <a
              key={r.code}
              href={`https://www.asx.com.au/markets/company/${r.code}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`${r.title}${r.onBuyList ? " On your buy list." : ""} Opens the company's ASX page.`}
              className={`px-2 py-0.5 rounded-full border text-xs hover:brightness-95 transition ${tone} ${r.onBuyList ? "font-semibold" : "opacity-80"}`}
            >
              {r.code}{note && <span className="opacity-70"> {note}</span>}
            </a>
          );
          return (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-5 py-3 rounded-xl text-sm space-y-2">
              <p className="font-semibold">
                📅 Reporting-season hold: {rows.length} stock{rows.length !== 1 ? "s" : ""} running on numbers
                older than {STALE_MONTHS} months{listed > 0 && <> — {listed} on your buy list</>}.
                {reportingChecking && <span className="font-normal text-amber-600"> Checking the ASX…</span>}
              </p>
              {overdue.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-red-700">
                    ⚑ Results overdue — the deadline has passed and nothing has been lodged ({overdue.length}). Red flag.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {overdue.map((r) => chip(r, `due ${shortDay(r.dueBy)}`, "bg-red-50 border-red-300 text-red-700"))}
                  </div>
                </div>
              )}
              {reported.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold">
                    Reported on the ASX, not yet in Stock Doctor ({reported.length}) — the score is on the previous
                    period&apos;s numbers.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {reported.map((r) => chip(r, shortDay(r.since), "bg-white border-amber-400 text-amber-900"))}
                  </div>
                </div>
              )}
              {awaiting.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold">
                    Awaiting results — not late ({awaiting.length}).
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {awaiting.map((r) => chip(r, `due ${shortDay(r.dueBy)}`, "bg-amber-50 border-amber-300 text-amber-800"))}
                  </div>
                </div>
              )}
              {unchecked.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold">
                    Not checked against the ASX ({unchecked.length}) — past the earliest deadline, so these need a look.{" "}
                    {!reportingChecking && (
                      <button
                        onClick={() => {
                          reportingTried.current = "";
                          void checkReporting(
                            holdTargets.filter((t) => unchecked.some((u) => u.code === t.code)),
                            new Set(holdTargets.map((t) => t.code)),
                          );
                        }}
                        className="underline font-normal hover:text-amber-950"
                      >
                        Check now
                      </button>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {unchecked.map((r) => chip(r, `${r.age.toFixed(1)}mo`, "bg-amber-50 border-amber-300 text-amber-800"))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ASX reports standing in for Stock Doctor. Doug, 2026-11-14: "Download
            their updated reports from the ASX and read them to extract the
            relevant data to do our scoring. We keep that data stored until a SD
            update is available."

            Three groups, because a reading is only applied by itself when it
            reconciles with what Stock Doctor already holds (lib/asx-financials):
            in use; waiting for his OK, with the reason; and not readable. Every
            row links to the report and shows before -> after, so a reading can
            be checked against the PDF in one click. */}
        {(() => {
          if (!allStocks) return null;
          const records = Object.values(asxFinancials?.data ?? {})
            .filter((r) => sdPeriods[r.code] === r.basedOn)
            .sort((a, b) => a.code.localeCompare(b.code));
          if (records.length === 0 && !asxReading) return null;
          const inUse = records.filter((r) => isInForce(r, r.basedOn));
          const waiting = records.filter((r) => r.status === "review" && !r.accepted && !r.dismissed);
          const unread = records.filter((r) => r.status === "failed" && !r.dismissed);
          const ignored = records.filter((r) => r.dismissed);
          const millions = (v: number | null) =>
            v === null ? "—" : `${(v / 1e6).toLocaleString("en-AU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}m`;
          const centsOf = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}c`);
          const span = (r: AsxFinancialsRecord) =>
            `${r.months === 6 ? "Half year" : r.months === 12 ? "Year" : `${r.months} months`} to ${formatDay(r.period)}` +
            (r.reader === "claude" ? " · read by Claude" : "");
          const figures = (r: AsxFinancialsRecord) => (
            <span className="font-mono text-[11px]" title={r.basis.join("\n")}>
              Cash flow A${millions(r.was.cf)} → A${millions(r.values.cf)} · EPS {centsOf(r.was.eps)} → {centsOf(r.values.eps)} ·
              Equity A${millions(r.was.equity)} → A${millions(r.values.equity)}
            </span>
          );
          const link = (r: AsxFinancialsRecord) => r.source && (
            <a
              href={r.source.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-teal-950"
              title={`"${r.source.headline}", lodged ${formatDay(r.source.date)}. ` +
                     Object.keys(r.evidence).map((k) => `${k}: p.${r.evidence[k].page}`).join(", ")}
            >
              report ↗
            </a>
          );
          const button = (label: string, onClick: () => void, strong?: boolean) => (
            <button
              onClick={onClick}
              disabled={!!asxReading}
              className={`px-2 py-0.5 rounded-md border text-[11px] transition-colors disabled:opacity-50 ${
                strong ? "bg-teal-700 border-teal-700 text-white hover:bg-teal-800" : "bg-white border-teal-300 hover:bg-teal-100"
              }`}
            >
              {label}
            </button>
          );
          const reasons = (r: AsxFinancialsRecord) => r.checks.filter((k) => !k.ok).map((k) => k.detail).join(" ");
          return (
            <div className="bg-teal-50 border border-teal-200 text-teal-900 px-5 py-3 rounded-xl text-sm space-y-2">
              <p className="font-semibold">
                📄 Scored from the company&apos;s own ASX report where Stock Doctor is a period behind
                {inUse.length > 0 && <> — {inUse.length} in use</>}
                {waiting.length > 0 && <>, {waiting.length} waiting for your OK</>}.
                {asxReading && <span className="font-normal text-teal-600"> Reading {asxReading}…</span>}
              </p>
              {inUse.map((r) => (
                <div key={r.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-bold w-12">{r.code}</span>
                  <span>{span(r)}</span>
                  {figures(r)}
                  {link(r)}
                  {button("Read again", () => void readAsxReport(r.code))}
                  {button("Stop using", () => updateAsxRecord(r.code, { dismissed: true }))}
                </div>
              ))}
              {waiting.map((r) => (
                <div key={r.code} className="space-y-1 text-xs border-t border-teal-200 pt-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-bold w-12">{r.code}</span>
                    <span>{span(r)}</span>
                    {figures(r)}
                    {link(r)}
                    {button("Use these numbers", () => updateAsxRecord(r.code, { accepted: true }), true)}
                    {button("Ignore", () => updateAsxRecord(r.code, { dismissed: true }))}
                    {button("Read again", () => void readAsxReport(r.code))}
                  </div>
                  <p className="text-amber-800">
                    Needs your OK: {reasons(r)}
                    {r.readerNote ? ` ${r.readerNote}` : ""}
                  </p>
                </div>
              ))}
              {unread.map((r) => (
                <div key={r.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border-t border-teal-200 pt-2">
                  <span className="font-bold w-12">{r.code}</span>
                  <span className="text-amber-800">Could not be read: {reasons(r) || "no figures found"}</span>
                  {link(r)}
                  {button("Try again", () => void readAsxReport(r.code))}
                </div>
              ))}
              {ignored.length > 0 && (
                <p className="text-xs text-teal-700 border-t border-teal-200 pt-2">
                  Ignored — still on Stock Doctor&apos;s numbers and the hold:{" "}
                  {ignored.map((r) => (
                    <button
                      key={r.code}
                      onClick={() => updateAsxRecord(r.code, { dismissed: false })}
                      className="underline mr-2 hover:text-teal-950"
                      title="Bring this reading back"
                    >
                      {r.code}
                    </button>
                  ))}
                </p>
              )}
              <p className="text-[11px] text-teal-700">
                Cash flow and EPS are rolling twelve months in Australian dollars, the way Stock Doctor shows them. Financial
                Health, Star Stock, forecasts, dividend yield and share count are carried over from Stock Doctor. Each reading
                is dropped the day Stock Doctor shows the same period.
              </p>
            </div>
          );
        })()}

        {/* Phase 2 collection prompt: every stock in the export whose PE Hi/Lo
            and Equity history has never been collected from Stock Doctor.

            Was the buy list only. Doug, 2026-11-14: "given the Stock Doctor
            filter CSV is our first filter each time then at a minimum we should
            have data on everything in that list, as well as a cross check that
            we haven't missed any data on a stock." A missing score is also what
            can be keeping a stock OFF the buy list, so the buy list alone could
            never show those. Together with the out-of-date scan below this is
            the cross check, run on every scoring: nothing in the export without
            a history, nothing with a history older than Stock Doctor's.
            Buy-list names come first and are drawn solid; the rest are dimmed. */}
        {(() => {
          if (!allStocks || !phase2Loaded) return null;
          const onBuyList = new Set(buyList.map((b) => b.Code));
          const gaps = allStocks
            .filter((s) => (s as Record<string, unknown>)._missingPhase2 === 1)
            .map((s) => ({
              code: s.Code,
              which: (s as Record<string, unknown>)._missingWhich as string,
              qav: s.QAV,
              onBuyList: onBuyList.has(s.Code),
            }))
            .sort((a, b) => Number(b.onBuyList) - Number(a.onBuyList) || (b.qav ?? 0) - (a.qav ?? 0));
          if (gaps.length === 0) return null;
          const listed = gaps.filter((g) => g.onBuyList).length;
          return (
            <div className="bg-sky-50 border border-sky-200 text-sky-900 px-5 py-3 rounded-xl text-sm space-y-2">
              <p className="font-semibold">
                🔎 Phase 2 data needed: {gaps.length} stock{gaps.length !== 1 ? "s" : ""} in this export{" "}
                {gaps.length !== 1 ? "have" : "has"} no PE Hi/Lo or Equity score yet
                {listed > 0 && <> — {listed} on your buy list</>}. Collect from Stock Doctor and add to the
                Phase 2 sheet (columns D/E), then re-upload.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {gaps.map((g) => (
                  <a
                    key={g.code}
                    href={`https://www.stockdoctor.com.au/Company/${g.code}?page=financials`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`px-2 py-0.5 rounded-full border text-xs font-medium hover:bg-sky-100 transition-colors ${
                      g.onBuyList ? "bg-white border-sky-300" : "bg-sky-50 border-sky-200 text-sky-400"
                    }`}
                    title={`${g.code} — missing ${g.which}.${g.onBuyList ? " On your buy list." : " Not on your buy list."} Opens Stock Doctor financials: PE row for 'lowest in 3 years', Equity row for 'increasing YoY'.`}
                  >
                    {g.code} <span className={g.onBuyList ? "text-sky-500" : "text-sky-300"}>{g.which}</span> ↗
                  </a>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Phase 2 OUT OF DATE: stocks that have reported a newer period than
            the newest one their PE / Equity history holds. Scanned on every
            scoring run — see the note in enrichWithPhase2. The whole universe,
            not just the buy list: a stale history can be what is keeping a
            stock OFF the list, so the buy list alone would hide those. Buy-list
            names come first and are drawn solid; the rest are dimmed. */}
        {(() => {
          if (!allStocks || !phase2Loaded) return null;
          const onBuyList = new Set(buyList.map((b) => b.Code));
          const stale = allStocks
            .filter((s) => (s as Record<string, unknown>)._phase2Stale === 1)
            .map((s) => ({
              code: s.Code,
              has: (s as Record<string, unknown>)._phase2Has as string | null,
              now: (s as Record<string, unknown>)._phase2Now as string | null,
              qav: s.QAV,
              onBuyList: onBuyList.has(s.Code),
            }))
            .sort((a, b) => Number(b.onBuyList) - Number(a.onBuyList) || (b.qav ?? 0) - (a.qav ?? 0));
          if (stale.length === 0) return null;
          const listed = stale.filter((s) => s.onBuyList).length;
          return (
            <div className="bg-indigo-50 border border-indigo-200 text-indigo-900 px-5 py-3 rounded-xl text-sm space-y-2">
              <p className="font-semibold">
                ♻️ Phase 2 out of date: {stale.length} stock{stale.length !== 1 ? "s have" : " has"} reported
                since {stale.length !== 1 ? "their" : "its"} PE / Equity history was collected
                {listed > 0 && <> — {listed} on your buy list</>}. PE Hi/Lo and Equity Increasing are
                scored on the older history until it is re-collected from Stock Doctor.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {stale.map((g) => (
                  <a
                    key={g.code}
                    href={`https://www.stockdoctor.com.au/Company/${g.code}?page=financials`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`px-2 py-0.5 rounded-full border text-xs font-medium hover:bg-indigo-100 transition-colors ${
                      g.onBuyList
                        ? "bg-white border-indigo-300"
                        : "bg-indigo-50 border-indigo-200 text-indigo-400"
                    }`}
                    title={`${g.code} — Phase 2 history stops at ${periodLabel(g.has)}; Stock Doctor now has ${periodLabel(g.now)}.` +
                           `${g.onBuyList ? " On your buy list." : " Not on your buy list."} Opens Stock Doctor financials.`}
                  >
                    {g.code}{" "}
                    <span className={g.onBuyList ? "text-indigo-500" : "text-indigo-300"}>
                      {periodLabel(g.has)} → {periodLabel(g.now)}
                    </span>{" "}↗
                  </a>
                ))}
              </div>
            </div>
          );
        })()}

        {!allStocks && (
          <div className="flex flex-col items-center gap-8 py-16">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold text-gray-900">QAV Stock Scorecard</h2>
              <p className="text-gray-500 max-w-lg">
                Upload your Stock Doctor CSV export and get an instant{" "}
                <strong>Quality At Value</strong> scorecard — 15+ scoring criteria, ranked by QAV score.
              </p>
            </div>
            {account?.configured && !account.signedIn && <AccountControl account={account} sync={syncStatus} card />}
            <UploadZone onFile={handleFile} loading={loading} />
            <SdBookmarklet />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-center text-sm text-gray-500">
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Phase 0</p>
                <p>15 automated QAV scores from the CSV — instant, no network</p>
              </div>
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Phase 2</p>
                <p>PE Hi/Lo and Equity Inc — upload your QAV spreadsheet once via the <Link href="/phase2" target="_blank" rel="noopener noreferrer" className="text-teal-600 underline">Phase 2 page</Link></p>
              </div>
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Live checks</p>
                <p>3PTL, commodities and buybacks run by themselves once a CSV is in</p>
              </div>
            </div>
          </div>
        )}

        {allStocks && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="w-4 h-4" />
              <span>
                Loaded <strong className="text-gray-700">{fileName}</strong> —{" "}
                {allStocks.length} stocks scored
                {fundRows.length > 0 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => setShowFundCodes((v) => !v)}
                      className="underline decoration-dotted underline-offset-2 hover:text-gray-700"
                      title="ETFs, funds and listed investment companies are taken out before scoring. Click to see which."
                    >
                      {fundRows.length} ETFs, funds and LICs set aside
                    </button>
                  </>
                )}
                {csvMeta && (() => {
                  // How old the numbers on screen are. The CSV is now
                  // remembered between visits, so "loaded just now" can no
                  // longer be assumed — a three-day-old export looks the same
                  // as a fresh one unless it says so.
                  const age = daysSince(csvMeta.loadedAt);
                  const old = age !== null && age >= 1;
                  return (
                    <span className={old ? "text-amber-600 font-medium" : "text-gray-400"}>
                      {" · "}
                      {csvMeta.source === "stockdoctor" ? "sent from Stock Doctor" : "loaded"}{" "}
                      {formatLoadedAt(csvMeta.loadedAt)}
                      {old && ` — ${age} day${age === 1 ? "" : "s"} old`}
                      {csvMeta.remembered && !old && " (remembered)"}
                    </span>
                  );
                })()}
              </span>
              <SdBookmarklet compact />
            </div>
            {showFundCodes && fundRows.length > 0 && (() => {
              const codes = (kind: "etf" | "lic") =>
                fundRows.filter((r) => setAsideKind(r) === kind).map((r) => String(r.Code)).sort();
              const etfs = codes("etf"), lics = codes("lic");
              return (
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 space-y-2">
                  <p>
                    These {fundRows.length} rows of the export are portfolios, not businesses, and are
                    not scored here. Every other row is scored as a stock, including any company too new
                    to have an industry group.
                  </p>
                  {etfs.length > 0 && (
                    <p>
                      <span className="font-medium text-gray-700">{etfs.length} ETFs and funds</span>{" "}
                      — no industry group, and in the{" "}
                      <a href="/etf" className="text-indigo-600 underline">ETF &amp; LIC page</a>&rsquo;s
                      ETF list or named ETF or Fund; ranked there.
                      <span className="block mt-1 font-mono text-xs leading-relaxed text-gray-500 break-words">
                        {etfs.join(" · ")}
                      </span>
                    </p>
                  )}
                  {lics.length > 0 && (
                    <p>
                      <span className="font-medium text-gray-700">{lics.length} listed investment companies and trusts</span>{" "}
                      — by code, from the bundled LIC list; ranked on the same page.
                      <span className="block mt-1 font-mono text-xs leading-relaxed text-gray-500 break-words">
                        {lics.join(" · ")}
                      </span>
                    </p>
                  )}
                </div>
              );
            })()}

            <SummaryStats all={statsAll} buyList={statsBuyList} />

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => { setView("buy"); setShowAll(false); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  view === "buy" ? "bg-indigo-600 text-white shadow-sm" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Star className="w-4 h-4" />
                Buy List ({buyList.length})
              </button>
              <button
                onClick={() => { setView("all"); setShowAll(true); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  view === "all" ? "bg-indigo-600 text-white shadow-sm" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <ListFilter className="w-4 h-4" />
                All Stocks ({allStocks.length})
              </button>
              {/* The portfolio. The badge is the count that needs action, so a
                  broken sell line is visible without opening the tab. */}
              <button
                onClick={() => setView("holdings")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  view === "holdings" ? "bg-indigo-600 text-white shadow-sm" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Briefcase className="w-4 h-4" />
                My Holdings ({holdings.codes.length})
                {holdingAlertCount > 0 && (
                  <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[11px] font-bold ${
                    view === "holdings" ? "bg-white text-red-700" : "bg-red-600 text-white"
                  }`} title={`${holdingAlertCount} holding(s) below the sell line`}>
                    {holdingAlertCount}
                  </span>
                )}
              </button>
            </div>

            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              <span className="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-medium">QAV ≥ 20 — Strong buy</span>
              <span className="bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full font-medium">QAV 10–20 — Buy list</span>
              <span className="bg-red-100 text-red-700 px-2.5 py-1 rounded-full font-medium">QAV &lt; 10 — Watch only</span>
              <span className="text-gray-400 ml-2">Click <strong>ⓘ</strong> to expand per-stock score breakdown</span>
            </div>

            {view === "holdings" ? (
              <HoldingsPanel
                codes={holdings.codes}
                allStocks={allStocks}
                trendlineData={trendlineData}
                commodities={commodityData}
                onSave={saveHoldingCodes}
                onAdd={addHoldingCode}
                onCheckMissing={checkHoldings3PTL}
                checking={holdingsChecking}
              />
            ) : (
            <StockTable
              stocks={displayedStocks}
              showAll={showAll}
              ownedCodes={ownedCodes}
              redFlags={redFlagView}
              reporting={reporting?.data}
              filterSentiment={filterSentiment}
              onChangeFilterSentiment={setFilterSentiment}
              borrowingRate={borrowingRate}
              phase2Loaded={phase2Loaded}
              sentimentOverrides={sentimentOverrides}
              onSentimentOverride={saveSentimentOverride}
              history={history}
            />
            )}

            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500 space-y-2">
              <p className="font-semibold text-gray-700">Scoring notes</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>QAV</strong> = (TotalScore / ScoredCount) / PCF × 100 — higher means cheaper relative to quality</li>
                <li><strong>PCF</strong> = Share Price ÷ (Operating Cash Flow per Share) — computed from raw CSV data</li>
                <li><strong>IV1</strong> = EPS ÷ IV1 Hurdle ({iv1Rate.toFixed(2)}%) — use your mortgage rate as a personal benchmark</li>
                <li><strong>IV2</strong> = Forecast EPS ÷ Market Hurdle ({(marketHurdle * 100).toFixed(2)}%) — driven by RBA cash rate ({cashRate}%) + 6%</li>
                <li>Phase 1 (3PTL short sentiment) requires the manual Python pipeline</li>
                <li><strong>Phase 2</strong> — upload your QAV analysis workbook once via the <Link href="/phase2" target="_blank" rel="noopener noreferrer" className="text-teal-600 underline">Phase 2 page</Link>. Scores are stored in your browser and applied automatically every time you upload a CSV. PE Hi/Lo: +2 = lowest in 3yrs, 0 = middle, −1 = highest. Equity Inc: +1 = increasing, 0 = not</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white mt-16">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-gray-400">
          <span>QAV method by Tony Kynaston — automated scoring pipeline</span>
          <span>Phase 0 + Phase 2 (QAV Spreadsheet) + live 3PTL, commodities and buybacks</span>
        </div>
      </footer>
    </div>
  );
}
