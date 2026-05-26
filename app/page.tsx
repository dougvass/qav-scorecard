"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { parseStockDoctorCSV } from "@/lib/csv-parser";
import {
  scoreStocks,
  makeBuyList,
  starToIv3Score,
  isEtfOrFund,
  DEFAULT_CASH_RATE,
  DEFAULT_RRR,
  ScoringRates,
} from "@/lib/qav-scoring";
import { StockRow, ScoredStock, MSRatings } from "@/lib/types";
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
  TrendingUp,
} from "lucide-react";

const SCORE_KEYS = [
  "S_sentiment_long", "S_sentiment_short", "S_pcf", "S_div_yield",
  "S_pe_lt_dy", "S_pe_hi_lo", "S_equity_inc", "S_sp_lt_neps",
  "S_sp_lt_1.3neps", "S_geps_pe", "S_sp_lt_iv1", "S_sp_lt_iv2",
  "S_sp_lt_0.5iv2", "S_sp_lt_iv3", "S_sp_lt_iv4", "S_star",
  "S_fh_rating", "S_fh_trend", "S_ownership",
] as const;

// Yahoo Finance Phase 2 payload type
type YFPhase2Map = Record<string, { S_equity_inc: number | null; S_pe_hi_lo: number | null }>;

function enrichWithMsRatings(stocks: ScoredStock[], ratings: MSRatings): ScoredStock[] {
  const ratingMap: Record<string, number | null> = {};
  for (const [ticker, entry] of Object.entries(ratings)) {
    ratingMap[ticker] = entry.starRating ?? null;
  }

  return stocks.map((stock) => {
    const rawStar = ratingMap[stock.Code] ?? null;
    const iv3 = starToIv3Score(rawStar);
    const enriched = { ...stock, S_sp_lt_iv3: iv3, _msStarRating: rawStar } as ScoredStock & { _msStarRating: number | null };

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

/** Apply Yahoo Finance Phase 2 scores (equity trend + PE hi-lo) and recompute derived stats. */
function enrichWithYahooPhase2(stocks: ScoredStock[], phase2: YFPhase2Map): ScoredStock[] {
  return stocks.map((stock) => {
    const data = phase2[stock.Code];
    if (!data) return stock;

    const enriched = { ...stock } as ScoredStock;
    if (data.S_equity_inc !== null) enriched.S_equity_inc = data.S_equity_inc;
    if (data.S_pe_hi_lo !== null) enriched.S_pe_hi_lo = data.S_pe_hi_lo;

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

export default function HomePage() {
  const [loading, setLoading] = useState(false);
  const [rawRows, setRawRows] = useState<StockRow[] | null>(null);
  const [allStocks, setAllStocks] = useState<ScoredStock[] | null>(null);
  const [buyList, setBuyList] = useState<ScoredStock[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [msLoading, setMsLoading] = useState(false);
  const [msLoaded, setMsLoaded] = useState(false);
  const [msRatings, setMsRatings] = useState<MSRatings | null>(null);
  const [yfLoading, setYfLoading] = useState(false);
  const [yfLoaded, setYfLoaded] = useState(false);
  const [yfProgress, setYfProgress] = useState(0);       // 0-100
  const [yahooPhase2, setYahooPhase2] = useState<YFPhase2Map | null>(null);
  const yfAutoStarted = useRef(false);                   // guard: fire auto-load once per CSV
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [showRateSettings, setShowRateSettings] = useState(false);
  const [hideEtfs, setHideEtfs] = useState(false);
  const [filterSentiment, setFilterSentiment] = useState<"all" | "bullish" | "bearish">("all");

  // Rate inputs — cash rate drives IV2 market hurdle; iv1Rate drives IV1; borrowingRate for div-yield comparison
  const [cashRate, setCashRate] = useState(DEFAULT_CASH_RATE);         // %
  const [iv1Rate, setIv1Rate] = useState(DEFAULT_RRR * 100);           // %
  const [borrowingRate, setBorrowingRate] = useState(6.5);              // % personal borrowing cost

  const rates: ScoringRates = {
    rrr: iv1Rate / 100,
    marketHurdle: (6 + cashRate) / 100,
  };

  // Re-score whenever raw rows, rates, or enrichment data changes
  useEffect(() => {
    if (!rawRows) return;
    const msMap = msRatings
      ? Object.fromEntries(
          Object.entries(msRatings).map(([k, v]) => [k, v.starRating ?? null])
        )
      : undefined;
    let scored = scoreStocks(rawRows, msMap, rates);
    if (msRatings) scored = enrichWithMsRatings(scored, msRatings);
    if (yahooPhase2) scored = enrichWithYahooPhase2(scored, yahooPhase2);
    setAllStocks(scored);
    setBuyList(makeBuyList(scored));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, cashRate, iv1Rate, msRatings, yahooPhase2]);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setFileName(file.name);
    try {
      const rows = await parseStockDoctorCSV(file);
      if (rows.length === 0) throw new Error("No stock rows found in CSV.");
      setRawRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse CSV.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMorningstar = useCallback(async () => {
    if (!rawRows) return;
    setMsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/morningstar");
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const ratings: MSRatings = await res.json();
      setMsRatings(ratings);
      setMsLoaded(true);
      // useEffect will re-score with MS ratings included
    } catch (e) {
      setError(
        e instanceof Error
          ? `MorningStar fetch failed: ${e.message}`
          : "Failed to load MorningStar ratings."
      );
    } finally {
      setMsLoading(false);
    }
  }, [rawRows]);

  const loadYahooFinance = useCallback(async () => {
    if (!allStocks) return;
    setYfLoading(true);
    setYfProgress(0);
    setError(null);

    const allResults: YFPhase2Map = {};
    // Build PE map from current CSV data (fallback if Yahoo trailingPE is unavailable)
    const peMap: Record<string, number | null> = {};
    for (const s of allStocks) peMap[s.Code] = s.PE;

    const codes = allStocks.map((s) => s.Code);
    const BATCH = 12; // stocks per API call — balances speed vs Vercel timeout

    try {
      for (let i = 0; i < codes.length; i += BATCH) {
        const batch = codes.slice(i, i + BATCH);
        const res = await fetch("/api/yahoo-finance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: batch, pes: peMap }),
        });
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data: YFPhase2Map = await res.json();
        Object.assign(allResults, data);
        setYfProgress(Math.min(99, Math.round(((i + BATCH) / codes.length) * 100)));
      }
      setYahooPhase2(allResults);
      setYfLoaded(true);
      setYfProgress(100);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Yahoo Finance failed: ${e.message}`
          : "Yahoo Finance Phase 2 fetch failed."
      );
    } finally {
      setYfLoading(false);
    }
  }, [allStocks]);

  // Auto-load Phase 2 as soon as stocks are available (once per CSV upload)
  useEffect(() => {
    if (
      allStocks && allStocks.length > 0 &&
      !yfLoaded && !yfLoading &&
      !yfAutoStarted.current
    ) {
      yfAutoStarted.current = true;
      loadYahooFinance();
    }
  // loadYahooFinance is stable per allStocks reference; yfLoaded/yfLoading guard re-runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStocks, yfLoaded, yfLoading, loadYahooFinance]);

  const reset = useCallback(() => {
    setRawRows(null);
    setAllStocks(null);
    setBuyList([]);
    setShowAll(false);
    setMsLoaded(false);
    setMsRatings(null);
    setYfLoaded(false);
    setYahooPhase2(null);
    setYfProgress(0);
    setFileName(null);
    setError(null);
    yfAutoStarted.current = false;   // allow auto-load on the next CSV upload
  }, []);

  const displayedStocks = showAll ? (allStocks ?? []) : buyList;

  // Summary stats mirror the active table filters (ETF toggle + sentiment)
  function applyTableFilters(arr: ScoredStock[]): ScoredStock[] {
    let result = arr;
    if (hideEtfs) result = result.filter((s) => !isEtfOrFund(s));
    if (filterSentiment === "bullish") result = result.filter((s) => s.S_sentiment_long === 1);
    if (filterSentiment === "bearish") result = result.filter((s) => s.S_sentiment_long !== 1);
    return result;
  }
  const statsAll = applyTableFilters(allStocks ?? []);
  const statsBuyList = applyTableFilters(buyList);

  const marketHurdle = (6 + cashRate) / 100;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 rounded-lg p-2">
              <BarChart2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 leading-none">QAV Scorecard</h1>
              <p className="text-xs text-gray-400 mt-0.5">ASX Stock Ranker — Tony Kynaston method</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
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
                {!msLoaded && (
                  <button
                    onClick={loadMorningstar}
                    disabled={msLoading}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-60 transition-colors"
                  >
                    <Star className={`w-4 h-4 ${msLoading ? "animate-spin" : ""}`} />
                    {msLoading ? "Loading MS ratings…" : "Load MS Ratings"}
                  </button>
                )}
                {msLoaded && (
                  <span className="flex items-center gap-1.5 text-sm text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200">
                    <Star className="w-4 h-4" />
                    MorningStar loaded
                  </span>
                )}
                {yfLoading && (
                  <span className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-teal-300 bg-teal-50 text-teal-800">
                    <TrendingUp className="w-4 h-4 animate-pulse" />
                    Yahoo Finance… {yfProgress}%
                    <span className="w-24 h-1.5 rounded-full bg-teal-100 overflow-hidden">
                      <span
                        className="block h-full bg-teal-500 transition-all duration-300"
                        style={{ width: `${yfProgress}%` }}
                      />
                    </span>
                  </span>
                )}
                {!yfLoading && yfLoaded && (
                  <span className="flex items-center gap-1.5 text-sm text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg border border-teal-200">
                    <TrendingUp className="w-4 h-4" />
                    Phase 2 loaded
                  </span>
                )}
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

        {/* Rate settings panel — slides in under header */}
        {showRateSettings && (
          <div className="border-t border-indigo-100 bg-indigo-50 px-6 py-4">
            <div className="max-w-screen-2xl mx-auto flex flex-wrap items-end gap-8">
              {/* Cash Rate */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  RBA Cash Rate (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={0.05}
                    value={cashRate}
                    onChange={(e) => setCashRate(parseFloat(e.target.value) || 0)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    → IV2 hurdle = {(marketHurdle * 100).toFixed(2)}%
                    <span className="ml-1 text-indigo-400">(6% + {cashRate}%)</span>
                  </span>
                </div>
              </div>

              {/* IV1 Personal Hurdle */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  IV1 Hurdle Rate (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    step={0.05}
                    value={iv1Rate}
                    onChange={(e) => setIv1Rate(parseFloat(e.target.value) || DEFAULT_RRR * 100)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    Tony&apos;s default: {DEFAULT_RRR * 100}% — set to your mortgage rate to use as personal benchmark
                  </span>
                </div>
              </div>

              {/* Borrowing Cost Rate */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-indigo-700 uppercase tracking-wide">
                  Borrowing Cost (%)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={30}
                    step={0.05}
                    value={borrowingRate}
                    onChange={(e) => setBorrowingRate(parseFloat(e.target.value) || 0)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    Div yield above this → income covers borrowing cost (shown in breakdown)
                  </span>
                </div>
              </div>

              <button
                onClick={() => { setCashRate(DEFAULT_CASH_RATE); setIv1Rate(DEFAULT_RRR * 100); setBorrowingRate(6.5); }}
                className="text-xs text-indigo-500 hover:text-indigo-700 underline pb-1.5"
              >
                Reset to defaults
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-8 space-y-8">
        {/* Error banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Pre-upload state */}
        {!allStocks && (
          <div className="flex flex-col items-center gap-8 py-16">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold text-gray-900">
                QAV Stock Scorecard
              </h2>
              <p className="text-gray-500 max-w-lg">
                Upload your Stock Doctor CSV export and get an instant{" "}
                <strong>Quality At Value</strong> scorecard — 15+ scoring
                criteria, ranked by QAV score.
              </p>
            </div>
            <UploadZone onFile={handleFile} loading={loading} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-center text-sm text-gray-500">
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Phase 0</p>
                <p>15 automated QAV scores from the CSV — instant, no network</p>
              </div>
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Phase 3</p>
                <p>MorningStar analyst star ratings for 200+ ASX stocks</p>
              </div>
              <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
                <p className="font-semibold text-gray-700 mb-1">Ranked output</p>
                <p>Buy list sorted by QAV, filterable by ADT and sentiment</p>
              </div>
            </div>
          </div>
        )}

        {/* Post-upload state */}
        {allStocks && (
          <div className="space-y-6">
            {/* File info */}
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="w-4 h-4" />
              <span>
                Loaded <strong className="text-gray-700">{fileName}</strong> —{" "}
                {allStocks.length} stocks scored
              </span>
            </div>

            {/* Summary stats — filtered when ETF toggle is active */}
            <SummaryStats all={statsAll} buyList={statsBuyList} msLoaded={msLoaded} />

            {/* View toggle */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAll(false)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  !showAll
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Star className="w-4 h-4" />
                Buy List ({buyList.length})
              </button>
              <button
                onClick={() => setShowAll(true)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showAll
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <ListFilter className="w-4 h-4" />
                All Stocks ({allStocks.length})
              </button>
            </div>

            {/* Score colour key */}
            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              <span className="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-medium">QAV ≥ 20 — Strong buy</span>
              <span className="bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full font-medium">QAV 10–20 — Buy list</span>
              <span className="bg-red-100 text-red-700 px-2.5 py-1 rounded-full font-medium">QAV &lt; 10 — Watch only</span>
              <span className="text-gray-400 ml-2">
                Click <strong>ⓘ</strong> to expand per-stock score breakdown
              </span>
            </div>

            {/* Table */}
            <StockTable
              stocks={displayedStocks}
              showAll={showAll}
              hideEtfs={hideEtfs}
              onToggleEtfs={() => setHideEtfs((v) => !v)}
              filterSentiment={filterSentiment}
              onChangeFilterSentiment={setFilterSentiment}
              borrowingRate={borrowingRate}
              yfLoaded={yfLoaded}
            />

            {/* Scoring notes */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500 space-y-2">
              <p className="font-semibold text-gray-700">Scoring notes</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>QAV</strong> = (TotalScore / ScoredCount) / PCF × 100 — higher means cheaper relative to quality</li>
                <li><strong>PCF</strong> = Share Price ÷ (Operating Cash Flow per Share) — computed from raw CSV data</li>
                <li><strong>IV1</strong> = EPS ÷ IV1 Hurdle ({iv1Rate.toFixed(2)}%) — intrinsic value; use your mortgage rate as a personal benchmark</li>
                <li><strong>IV2</strong> = Forecast EPS ÷ Market Hurdle ({(marketHurdle * 100).toFixed(2)}%) — forward-looking; driven by RBA cash rate ({cashRate}%) + 6%</li>
                <li>Phase 1 (3PTL short sentiment) requires the manual Python pipeline</li>
                <li><strong>Phase 2</strong> (equity trend + PE hi-lo) auto-fetched from Yahoo Finance on upload. Equity scores 1 if stockholders&apos; equity increased YoY for 3 consecutive years; PE hi-lo scores 1 if current trailing PE is at or within 10% of its 3-year historical minimum</li>
                <li>MorningStar: 4–5★ = stock trading below analyst fair value → S_sp_lt_iv3 = 1</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white mt-16">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-gray-400">
          <span>QAV method by Tony Kynaston — automated scoring pipeline</span>
          <span>Phase 0 + Phase 2 (Yahoo Finance) + Phase 3 (MorningStar)</span>
        </div>
      </footer>
    </div>
  );
}
