"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { parseStockDoctorCSV } from "@/lib/csv-parser";
import { PHASE2_STORAGE_KEY, StoredPhase2 } from "@/lib/phase2-storage";
import { BUYBACK_STORAGE_KEY, StoredBuybacks, BUYBACK_KEYWORDS, BUYBACK_LOOKBACK_MONTHS } from "@/lib/buyback-storage";
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
  Database,
  TrendingUp,
} from "lucide-react";

const SCORE_KEYS = [
  "S_sentiment_long", "S_sentiment_short", "S_pcf", "S_div_yield",
  "S_pe_lt_dy", "S_pe_hi_lo", "S_equity_inc", "S_sp_lt_neps",
  "S_sp_lt_1.3neps", "S_geps_pe", "S_sp_lt_iv1", "S_sp_lt_iv2",
  "S_sp_lt_0.5iv2", "S_sp_lt_iv3", "S_sp_lt_iv4", "S_star",
  "S_fh_rating", "S_fh_trend", "S_ownership", "S_buyback",
] as const;

// Phase 2 payload: Code → { S_equity_inc, S_pe_hi_lo }
type Phase2Map = Record<string, { S_equity_inc: number | null; S_pe_hi_lo: number | null }>;

// Buyback payload: Code → active flag
type BuybackMap = Record<string, boolean>;

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

/** Apply Phase 2 scores (equity trend + PE hi-lo) and recompute derived stats. */
function enrichWithPhase2(stocks: ScoredStock[], phase2: Phase2Map): ScoredStock[] {
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

/** Shown when ASX is unreachable — lets the user paste codes manually */
function BuybackManualEntry({ onSave }: { onSave: (codes: string[]) => void }) {
  const [text, setText] = useState("");
  function save() {
    const codes = text
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length) onSave(codes);
  }
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 border border-orange-200 rounded-lg">
      <TrendingUp className="w-4 h-4 text-orange-600 shrink-0" />
      <span className="text-xs text-orange-700 font-medium whitespace-nowrap">ASX blocked — enter codes:</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="BHP,CBA,ANZ…"
        className="text-xs border border-orange-200 rounded px-2 py-1 w-36 focus:outline-none focus:ring-1 focus:ring-orange-400 bg-white"
      />
      <button
        onClick={save}
        className="text-xs font-medium text-orange-700 hover:text-orange-900 px-2 py-1 rounded border border-orange-300 hover:bg-orange-100 transition-colors"
      >
        Save
      </button>
    </div>
  );
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
  const [phase2Loaded, setPhase2Loaded] = useState(false);
  const [phase2StockCount, setPhase2StockCount] = useState(0);
  const [phase2Data, setPhase2Data] = useState<Phase2Map | null>(null);
  const [buybackData, setBuybackData] = useState<BuybackMap | null>(null);
  const [buybackLoading, setBuybackLoading] = useState(false);
  const [buybackProgress, setBuybackProgress] = useState<{ done: number; total: number } | null>(null);
  const [buybackLoaded, setBuybackLoaded] = useState(false);
  const [buybackCount, setBuybackCount] = useState(0);
  const [buybackBlocked, setBuybackBlocked] = useState(false);
  const [buybackManual, setBuybackManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [showRateSettings, setShowRateSettings] = useState(false);
  const [hideEtfs, setHideEtfs] = useState(false);
  const [filterSentiment, setFilterSentiment] = useState<"all" | "bullish" | "bearish">("all");

  // Rate inputs
  const [cashRate, setCashRate] = useState(DEFAULT_CASH_RATE);
  const [iv1Rate, setIv1Rate] = useState(DEFAULT_RRR * 100);
  const [borrowingRate, setBorrowingRate] = useState(6.5);

  const rates: ScoringRates = {
    rrr: iv1Rate / 100,
    marketHurdle: (6 + cashRate) / 100,
  };

  // Auto-load Phase 2 + buybacks from localStorage on mount
  useEffect(() => {
    try {
      const raw2 = localStorage.getItem(PHASE2_STORAGE_KEY);
      if (raw2) {
        const stored = JSON.parse(raw2) as StoredPhase2;
        const count = Object.values(stored.data).filter(
          (v) => v.S_pe_hi_lo !== null || v.S_equity_inc !== null
        ).length;
        setPhase2Data(stored.data as Phase2Map);
        setPhase2StockCount(count);
        setPhase2Loaded(true);
      }
    } catch { /* corrupt storage — ignore */ }

    try {
      const rawBB = localStorage.getItem(BUYBACK_STORAGE_KEY);
      if (rawBB) {
        const stored = JSON.parse(rawBB) as StoredBuybacks;
        const bbMap: BuybackMap = {};
        let active = 0;
        for (const [code, entry] of Object.entries(stored.data)) {
          bbMap[code] = entry.active;
          if (entry.active) active++;
        }
        setBuybackData(bbMap);
        setBuybackCount(active);
        setBuybackLoaded(true);
      }
    } catch { /* corrupt storage — ignore */ }
  }, []);

  // Re-score whenever raw rows, rates, or enrichment data changes
  useEffect(() => {
    if (!rawRows) return;
    const msMap = msRatings
      ? Object.fromEntries(Object.entries(msRatings).map(([k, v]) => [k, v.starRating ?? null]))
      : undefined;
    let scored = scoreStocks(rawRows, msMap, rates);
    if (msRatings)   scored = enrichWithMsRatings(scored, msRatings);
    if (phase2Data)  scored = enrichWithPhase2(scored, phase2Data);
    if (buybackData) scored = enrichWithBuybacks(scored, buybackData);
    setAllStocks(scored);
    setBuyList(makeBuyList(scored));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, cashRate, iv1Rate, msRatings, phase2Data, buybackData]);

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
    } catch (e) {
      setError(e instanceof Error ? `MorningStar fetch failed: ${e.message}` : "Failed to load MorningStar ratings.");
    } finally {
      setMsLoading(false);
    }
  }, [rawRows]);

  /**
   * Check ASX announcements for on-market buybacks (Appendix 3C / 3D).
   *
   * Strategy (tries in order, stops at first success):
   *  1. Server-side via /api/buybacks (Vercel Edge Runtime — different IPs from Lambda)
   *  2. Client-side browser fetch directly to ASX (user's IP, no CORS if ASX allows it)
   *
   * If both fail we set buybackBlocked=true so the UI shows the manual entry fallback.
   */
  const loadBuybacks = useCallback(async () => {
    if (!rawRows) return;
    setBuybackLoading(true);
    setBuybackProgress({ done: 0, total: rawRows.length });
    setBuybackBlocked(false);
    setError(null);

    const codes = rawRows.map((r) => r.Code);
    const accumulated: BuybackMap = {};
    let activeCount = 0;
    const CHUNK = 20;
    const CONCURRENCY = 8;

    // ── Strategy 1: edge server-side ────────────────────────────────────────
    async function checkViaServer(chunk: string[]): Promise<Record<string, boolean> | null> {
      try {
        const res = await fetch("/api/buybacks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: chunk }),
        });
        if (!res.ok) return null;
        const data = await res.json() as Record<string, { active: boolean; _status?: number; _err?: string }>;
        // If every result has _status:403 or _err, the edge is also blocked
        const allFailed = chunk.every((c) => !data[c]?.active && (data[c]?._status === 403 || data[c]?._err));
        if (allFailed && chunk.length > 1) return null; // signal: fall through to browser
        return Object.fromEntries(chunk.map((c) => [c, data[c]?.active ?? false]));
      } catch {
        return null;
      }
    }

    // ── Strategy 2: browser direct to ASX ────────────────────────────────────
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - BUYBACK_LOOKBACK_MONTHS);

    async function checkViaBrowser(code: string): Promise<boolean | "cors"> {
      try {
        const res = await fetch(
          `https://www.asx.com.au/asx/1/company/${code}/announcements?count=50&market_sensitive=false`,
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) }
        );
        if (!res.ok) return false;
        const json = await res.json();
        const anns: Array<{ header?: string; document_type?: string; document_release_date?: string }> =
          json?.data ?? [];
        return anns.some((ann) => {
          const dateStr = ann.document_release_date ?? "";
          if (dateStr && new Date(dateStr) < cutoff) return false;
          const text = `${ann.header ?? ""} ${ann.document_type ?? ""}`.toLowerCase();
          return BUYBACK_KEYWORDS.some((kw) => text.includes(kw));
        });
      } catch (e) {
        // TypeError = almost certainly a CORS block
        if (e instanceof TypeError) return "cors";
        return false;
      }
    }

    try {
      let useBrowser = false;
      let corsBlocked = false;

      // Probe: try first chunk via server to detect edge blocking
      const probeChunk = codes.slice(0, Math.min(5, codes.length));
      const probeResult = await checkViaServer(probeChunk);
      if (probeResult === null) {
        useBrowser = true;
        // Probe browser too — check one code to see if CORS allows it
        const browserProbe = await checkViaBrowser(probeChunk[0]);
        if (browserProbe === "cors") corsBlocked = true;
      }

      if (corsBlocked) {
        // Neither server nor browser can reach ASX — show manual entry UI
        setBuybackBlocked(true);
        return;
      }

      if (useBrowser) {
        // Browser-side: parallel batches
        for (let i = 0; i < codes.length; i += CONCURRENCY) {
          const chunk = codes.slice(i, i + CONCURRENCY);
          const results = await Promise.all(chunk.map(checkViaBrowser));
          chunk.forEach((code, j) => {
            const r = results[j];
            const active = r === true;
            accumulated[code] = active;
            if (active) activeCount++;
          });
          setBuybackProgress({ done: Math.min(i + CONCURRENCY, codes.length), total: codes.length });
        }
      } else {
        // Server-side: merge probe, then continue in chunks
        Object.assign(accumulated, probeResult ?? {});
        activeCount = Object.values(accumulated).filter(Boolean).length;
        setBuybackProgress({ done: probeChunk.length, total: codes.length });

        for (let i = probeChunk.length; i < codes.length; i += CHUNK) {
          const chunk = codes.slice(i, i + CHUNK);
          const result = await checkViaServer(chunk);
          if (result) {
            Object.assign(accumulated, result);
            activeCount = Object.values(accumulated).filter(Boolean).length;
          }
          setBuybackProgress({ done: Math.min(i + CHUNK, codes.length), total: codes.length });
        }
      }

      const stored: StoredBuybacks = {
        timestamp: new Date().toISOString(),
        checkedCount: codes.length,
        data: Object.fromEntries(
          Object.entries(accumulated).map(([code, active]) => [code, { active }])
        ),
      };
      localStorage.setItem(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
      setBuybackData(accumulated);
      setBuybackCount(activeCount);
      setBuybackLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? `Buyback check: ${e.message}` : "Buyback check failed.");
    } finally {
      setBuybackLoading(false);
      setBuybackProgress(null);
    }
  }, [rawRows]);

  const reset = useCallback(() => {
    setRawRows(null);
    setAllStocks(null);
    setBuyList([]);
    setShowAll(false);
    setMsLoaded(false);
    setMsRatings(null);
    // Phase 2 + buybacks are stored in localStorage — persist across CSV uploads intentionally
    setFileName(null);
    setError(null);
  }, []);

  const displayedStocks = showAll ? (allStocks ?? []) : buyList;

  function applyTableFilters(arr: ScoredStock[]): ScoredStock[] {
    let result = arr;
    if (hideEtfs) result = result.filter((s) => !isEtfOrFund(s));
    if (filterSentiment === "bullish") result = result.filter((s) => s.S_sentiment_long === 2);
    if (filterSentiment === "bearish") result = result.filter((s) => s.S_sentiment_long === -1);
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

                {/* MorningStar */}
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

                {/* Buyback checker */}
                {!buybackLoaded && !buybackLoading && !buybackBlocked && (
                  <button
                    onClick={loadBuybacks}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100 transition-colors"
                  >
                    <TrendingUp className="w-4 h-4" />
                    Check Buybacks
                  </button>
                )}
                {buybackLoading && buybackProgress && (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-orange-700 bg-orange-50 border border-orange-200 rounded-lg">
                    <TrendingUp className="w-4 h-4 animate-pulse" />
                    <span>Buybacks {buybackProgress.done}/{buybackProgress.total}</span>
                    <div className="w-20 h-1.5 bg-orange-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500 rounded-full transition-all"
                        style={{ width: `${(buybackProgress.done / buybackProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                {buybackLoaded && !buybackLoading && (
                  <button
                    onClick={loadBuybacks}
                    className="flex items-center gap-1.5 text-sm text-orange-700 bg-orange-50 px-3 py-1.5 rounded-lg border border-orange-200 hover:bg-orange-100 transition-colors"
                    title="Re-check ASX announcements for buybacks"
                  >
                    <TrendingUp className="w-4 h-4" />
                    {buybackCount} buyback{buybackCount !== 1 ? "s" : ""}
                  </button>
                )}
                {buybackBlocked && !buybackLoading && (
                  <BuybackManualEntry
                    onSave={(codes) => {
                      const map: BuybackMap = {};
                      codes.forEach((c) => { map[c] = true; });
                      const stored: StoredBuybacks = {
                        timestamp: new Date().toISOString(),
                        checkedCount: codes.length,
                        data: Object.fromEntries(codes.map((c) => [c, { active: true }])),
                      };
                      localStorage.setItem(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
                      setBuybackData(map);
                      setBuybackCount(codes.length);
                      setBuybackLoaded(true);
                      setBuybackBlocked(false);
                    }}
                  />
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
                    onChange={(e) => setCashRate(parseFloat(e.target.value) || 0)}
                    className="w-24 text-sm border border-indigo-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                  />
                  <span className="text-xs text-indigo-500">
                    → IV2 hurdle = {(marketHurdle * 100).toFixed(2)}%
                    <span className="ml-1 text-indigo-400">(6% + {cashRate}%)</span>
                  </span>
                </div>
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
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {!allStocks && (
          <div className="flex flex-col items-center gap-8 py-16">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold text-gray-900">QAV Stock Scorecard</h2>
              <p className="text-gray-500 max-w-lg">
                Upload your Stock Doctor CSV export and get an instant{" "}
                <strong>Quality At Value</strong> scorecard — 15+ scoring criteria, ranked by QAV score.
              </p>
            </div>
            <UploadZone onFile={handleFile} loading={loading} />
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
                <p className="font-semibold text-gray-700 mb-1">Phase 3</p>
                <p>MorningStar analyst star ratings for 200+ ASX stocks</p>
              </div>
            </div>
          </div>
        )}

        {allStocks && (
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="w-4 h-4" />
              <span>
                Loaded <strong className="text-gray-700">{fileName}</strong> —{" "}
                {allStocks.length} stocks scored
              </span>
            </div>

            <SummaryStats all={statsAll} buyList={statsBuyList} msLoaded={msLoaded} />

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAll(false)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  !showAll ? "bg-indigo-600 text-white shadow-sm" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Star className="w-4 h-4" />
                Buy List ({buyList.length})
              </button>
              <button
                onClick={() => setShowAll(true)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showAll ? "bg-indigo-600 text-white shadow-sm" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                <ListFilter className="w-4 h-4" />
                All Stocks ({allStocks.length})
              </button>
            </div>

            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              <span className="bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-full font-medium">QAV ≥ 20 — Strong buy</span>
              <span className="bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full font-medium">QAV 10–20 — Buy list</span>
              <span className="bg-red-100 text-red-700 px-2.5 py-1 rounded-full font-medium">QAV &lt; 10 — Watch only</span>
              <span className="text-gray-400 ml-2">Click <strong>ⓘ</strong> to expand per-stock score breakdown</span>
            </div>

            <StockTable
              stocks={displayedStocks}
              showAll={showAll}
              hideEtfs={hideEtfs}
              onToggleEtfs={() => setHideEtfs((v) => !v)}
              filterSentiment={filterSentiment}
              onChangeFilterSentiment={setFilterSentiment}
              borrowingRate={borrowingRate}
              phase2Loaded={phase2Loaded}
            />

            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500 space-y-2">
              <p className="font-semibold text-gray-700">Scoring notes</p>
              <ul className="list-disc list-inside space-y-1">
                <li><strong>QAV</strong> = (TotalScore / ScoredCount) / PCF × 100 — higher means cheaper relative to quality</li>
                <li><strong>PCF</strong> = Share Price ÷ (Operating Cash Flow per Share) — computed from raw CSV data</li>
                <li><strong>IV1</strong> = EPS ÷ IV1 Hurdle ({iv1Rate.toFixed(2)}%) — use your mortgage rate as a personal benchmark</li>
                <li><strong>IV2</strong> = Forecast EPS ÷ Market Hurdle ({(marketHurdle * 100).toFixed(2)}%) — driven by RBA cash rate ({cashRate}%) + 6%</li>
                <li>Phase 1 (3PTL short sentiment) requires the manual Python pipeline</li>
                <li><strong>Phase 2</strong> — upload your QAV analysis workbook once via the <Link href="/phase2" target="_blank" rel="noopener noreferrer" className="text-teal-600 underline">Phase 2 page</Link>. Scores are stored in your browser and applied automatically every time you upload a CSV. PE Hi/Lo: +2 = lowest in 3yrs, 0 = middle, −1 = highest. Equity Inc: +1 = increasing, 0 = not</li>
                <li>MorningStar: 4–5★ = stock trading below analyst fair value → S_sp_lt_iv3 = 1</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white mt-16">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between text-xs text-gray-400">
          <span>QAV method by Tony Kynaston — automated scoring pipeline</span>
          <span>Phase 0 + Phase 2 (QAV Spreadsheet) + Phase 3 (MorningStar)</span>
        </div>
      </footer>
    </div>
  );
}
