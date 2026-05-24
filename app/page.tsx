"use client";

import { useState, useCallback } from "react";
import { parseStockDoctorCSV } from "@/lib/csv-parser";
import { scoreStocks, makeBuyList, starToIv3Score } from "@/lib/qav-scoring";
import { ScoredStock, MSRatings } from "@/lib/types";
import { UploadZone } from "@/components/upload-zone";
import { SummaryStats } from "@/components/summary-stats";
import { StockTable } from "@/components/stock-table";
import {
  UploadCloud,
  RefreshCw,
  Star,
  ListFilter,
  BarChart2,
} from "lucide-react";

export default function HomePage() {
  const [loading, setLoading] = useState(false);
  const [allStocks, setAllStocks] = useState<ScoredStock[] | null>(null);
  const [buyList, setBuyList] = useState<ScoredStock[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [msLoading, setMsLoading] = useState(false);
  const [msLoaded, setMsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [msRatings, setMsRatings] = useState<MSRatings | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setFileName(file.name);
    try {
      const rows = await parseStockDoctorCSV(file);
      if (rows.length === 0) throw new Error("No stock rows found in CSV.");

      // Score without MS data first (instant)
      const scored = scoreStocks(rows);
      const bl = makeBuyList(scored);
      setAllStocks(scored);
      setBuyList(bl);

      // If MS ratings are already loaded, apply them
      if (msRatings) {
        applyMsRatings(scored, msRatings);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse CSV.");
    } finally {
      setLoading(false);
    }
  }, [msRatings]);

  function applyMsRatings(stocks: ScoredStock[], ratings: MSRatings): void {
    // Build a Code → starRating map
    const ratingMap: Record<string, number | null> = {};
    for (const [ticker, entry] of Object.entries(ratings)) {
      ratingMap[ticker] = entry.starRating ?? null;
    }

    // Re-score with MS data injected
    // We mutate in-place for performance (table re-renders via state)
    for (const stock of stocks) {
      const rawStar = ratingMap[stock.Code] ?? null;
      stock.S_sp_lt_iv3 = starToIv3Score(rawStar);
      // Attach raw star rating for display (not in ScoreColumns but useful for UI)
      (stock as Record<string, unknown>)._msStarRating = rawStar;

      // Recompute count, total, quality, qav with the new S_sp_lt_iv3
      const scoreKeys: (keyof typeof stock)[] = [
        "S_sentiment_long", "S_sentiment_short", "S_pcf", "S_div_yield",
        "S_pe_lt_dy", "S_pe_hi_lo", "S_equity_inc", "S_sp_lt_neps",
        "S_sp_lt_1.3neps", "S_geps_pe", "S_sp_lt_iv1", "S_sp_lt_iv2",
        "S_sp_lt_0.5iv2", "S_sp_lt_iv3", "S_sp_lt_iv4", "S_star",
        "S_fh_rating", "S_fh_trend", "S_ownership",
      ];
      const vals = scoreKeys
        .map((k) => (stock as Record<string, unknown>)[k as string] as number | null)
        .filter((v): v is number => v !== null);

      stock.Count = vals.length;
      stock.TotalScore = vals.reduce((a, b) => a + b, 0);
      stock.Quality = vals.length > 0 ? stock.TotalScore / vals.length : null;
      stock.QAV =
        stock.Quality !== null && stock.PCF !== null && stock.PCF !== 0
          ? Math.round((stock.Quality / stock.PCF) * 100 * 100) / 100
          : null;
    }

    const bl = makeBuyList(stocks);
    setAllStocks([...stocks]); // trigger re-render
    setBuyList(bl);
  }

  const loadMorningstar = useCallback(async () => {
    if (!allStocks) return;
    setMsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/morningstar");
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const ratings: MSRatings = await res.json();
      setMsRatings(ratings);
      setMsLoaded(true);
      applyMsRatings(allStocks, ratings);
    } catch (e) {
      setError(
        e instanceof Error
          ? `MorningStar fetch failed: ${e.message}`
          : "Failed to load MorningStar ratings."
      );
    } finally {
      setMsLoading(false);
    }
  }, [allStocks]);

  const reset = () => {
    setAllStocks(null);
    setBuyList([]);
    setShowAll(false);
    setMsLoaded(false);
    setMsRatings(null);
    setFileName(null);
    setError(null);
  };

  const displayedStocks = showAll ? (allStocks ?? []) : buyList;

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

            {/* Summary stats */}
            <SummaryStats all={allStocks} buyList={buyList} msLoaded={msLoaded} />

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

            {/* Score key */}
            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              <span className="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-medium">QAV ≥ 20 — Strong buy</span>
              <span className="bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full font-medium">QAV 10–20 — Buy list</span>
              <span className="bg-red-100 text-red-700 px-2.5 py-1 rounded-full font-medium">QAV &lt; 10 — Watch only</span>
              <span className="text-gray-400 ml-2">
                Click <strong>ⓘ</strong> to expand per-stock score breakdown
              </span>
            </div>

            {/* Table */}
            <StockTable stocks={displayedStocks} showAll={showAll} />

            {/* Scoring notes */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500 space-y-2">
              <p className="font-semibold text-gray-700">Scoring notes</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>QAV</strong> = (TotalScore / ScoredCount) / PCF × 100 — higher is cheaper relative to quality</li>
                <li><strong>PCF</strong> = Share Price / (Operating Cash Flow per Share) — calculated from raw data</li>
                <li><strong>IV1</strong> = EPS / RRR (19.5%) — intrinsic value based on earnings and hurdle rate</li>
                <li><strong>IV2</strong> = Forecast EPS / Market Hurdle (10.1%) — forward-looking intrinsic value</li>
                <li>Phase 1 (3PTL) and Phase 2 (historical PE/equity) scores are blank on web — run the Python pipeline for those</li>
                <li>MorningStar: 4–5★ = stock trading below analyst fair value → S_sp_lt_iv3 = 1</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white mt-16">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-gray-400">
          <span>QAV method by Tony Kynaston — automated scoring pipeline</span>
          <span>Phase 0 + Phase 3 (MorningStar)</span>
        </div>
      </footer>
    </div>
  );
}
