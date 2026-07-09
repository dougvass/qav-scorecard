"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { parseStockDoctorCSV } from "@/lib/csv-parser";
import { PHASE2_STORAGE_KEY, StoredPhase2 } from "@/lib/phase2-storage";
import { BUYBACK_STORAGE_KEY, StoredBuybacks } from "@/lib/buyback-storage";
import {
  SENTIMENT_STORAGE_KEY,
  StoredSentiments,
  SentimentOverride,
  SENTIMENT_SCORES,
} from "@/lib/sentiment-storage";
import {
  TRENDLINE_STORAGE_KEY,
  StoredTrendlines,
  TrendlineSentiment,
  TRENDLINE_SCORES,
} from "@/lib/trendline-storage";
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
  Activity,
} from "lucide-react";

const SCORE_KEYS = [
  "S_sentiment_long", "S_sentiment_short", "S_pcf", "S_div_yield",
  "S_pe_lt_dy", "S_pe_hi_lo", "S_equity_inc", "S_sp_lt_neps",
  "S_sp_lt_1.3neps", "S_geps_pe", "S_sp_lt_iv1", "S_sp_lt_iv2",
  "S_sp_lt_0.5iv2", "S_sp_lt_iv3", "S_sp_lt_iv4", "S_star",
  "S_fh_rating", "S_fh_trend", "S_ownership", "S_buyback", "S_new_upturn",
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

/** Apply auto-calculated 3PTL trendline results (overrides SDMAX, overridden by manual). */
function enrichWithTrendlines(stocks: ScoredStock[], trendlines: StoredTrendlines): ScoredStock[] {
  return stocks.map((stock) => {
    const entry = trendlines.data[stock.Code];
    if (!entry) return stock;
    const isPositiveJosephine =
      entry.sentiment === "Josephine" &&
      !!(entry.note?.toLowerCase().includes("josephine: positive") ||
         entry.note?.toLowerCase().includes("positive 3ptl"));

    const enriched = {
      ...stock,
      S_sentiment_long: TRENDLINE_SCORES[entry.sentiment],
      // Auto-set new upturn +1 when 3PTL detects a fresh breakout above resistance
      S_new_upturn: (entry as unknown as Record<string,unknown>).newUpturn ? 1 : null,
      // Flag positive Josephines (was Bullish, just a monthly dip) for teal badge (1=yes, null=no)
      _positiveJosephine: isPositiveJosephine ? 1 : null,
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
 * Apply the QAV commodity gate: a stock whose underlying commodity is in Sell
 * (Bearish) status is itself a sell / do-not-buy, regardless of its own chart
 * — force sentiment to Bearish and flag it for the table badge. Runs AFTER
 * the auto 3PTL layer and BEFORE manual per-stock overrides (manual wins).
 */
function enrichWithCommodityGate(stocks: ScoredStock[], commodities: StoredCommodities): ScoredStock[] {
  return stocks.map((stock) => {
    const commodityKey = STOCK_COMMODITY[stock.Code];
    if (!commodityKey) return stock;
    const sentiment = effectiveCommoditySentiment(commodities, commodityKey);
    const label = COMMODITIES.find((c) => c.key === commodityKey)?.label ?? commodityKey;
    if (sentiment !== "Bearish") {
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
    const enriched = { ...stock, S_sentiment_long: SENTIMENT_SCORES[override] } as ScoredStock;
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
  const [sentimentOverrides, setSentimentOverrides] = useState<StoredSentiments>({});
  const [trendlineData, setTrendlineData] = useState<StoredTrendlines | null>(null);
  const [trendlineChecking, setTrendlineChecking] = useState(false);
  const [trendlineProgress, setTrendlineProgress] = useState<{ done: number; total: number } | null>(null);
  const [trendlineLoaded, setTrendlineLoaded] = useState(false);
  const [commodityData, setCommodityData] = useState<StoredCommodities | null>(null);
  const [commodityChecking, setCommodityChecking] = useState(false);
  const [showCommodityPanel, setShowCommodityPanel] = useState(false);
  const [buybackData, setBuybackData] = useState<BuybackMap | null>(null);
  const [buybackLoaded, setBuybackLoaded] = useState(false);
  const [buybackCount, setBuybackCount] = useState(0);
  const [showBuybackPanel, setShowBuybackPanel] = useState(false);
  const [buybackChecking, setBuybackChecking] = useState(false);
  const [buybackProgress, setBuybackProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [showRateSettings, setShowRateSettings] = useState(false);
  const [hideEtfs, setHideEtfs] = useState(false);
  const [filterSentiment, setFilterSentiment] = useState<"all" | "bullish" | "josephine" | "bearish">("all");

  // Rate inputs
  const [cashRate, setCashRate] = useState(DEFAULT_CASH_RATE);
  const [iv1Rate, setIv1Rate] = useState(DEFAULT_RRR * 100);
  const [borrowingRate, setBorrowingRate] = useState(6.5);

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
  useEffect(() => {
    loadPhase2FromStorage();
    loadBuybacksFromStorage();
    loadSentimentsFromStorage();
    loadTrendlineFromStorage();
    loadCommoditiesFromStorage();

    function onStorageChange(e: StorageEvent) {
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

  // Re-score whenever raw rows, rates, or enrichment data changes
  useEffect(() => {
    if (!rawRows) return;
    const msMap = msRatings
      ? Object.fromEntries(Object.entries(msRatings).map(([k, v]) => [k, v.starRating ?? null]))
      : undefined;
    let scored = scoreStocks(rawRows, msMap, rates);
    if (msRatings)   scored = enrichWithMsRatings(scored, msRatings);
    if (phase2Data)  scored = enrichWithPhase2(scored, phase2Data);
    if (buybackData)  scored = enrichWithBuybacks(scored, buybackData);
    if (trendlineData) scored = enrichWithTrendlines(scored, trendlineData);   // auto 3PTL
    if (commodityData) scored = enrichWithCommodityGate(scored, commodityData); // commodity sell → gate
    if (Object.keys(sentimentOverrides).length > 0)
      scored = enrichWithSentimentOverrides(scored, sentimentOverrides);        // manual wins
    setAllStocks(scored);
    setBuyList(makeBuyList(scored));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, cashRate, iv1Rate, msRatings, phase2Data, buybackData, trendlineData, commodityData, sentimentOverrides]);

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
      localStorage.setItem(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
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
    const accumulated: StoredTrendlines["data"] = {};

    try {
      for (let i = 0; i < codes.length; i += CHUNK) {
        const chunk = codes.slice(i, i + CHUNK);
        const res = await fetch("/api/trendline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codes: chunk }),
        });
        if (!res.ok) throw new Error(`Trendline API error ${res.status}`);
        const data = await res.json() as Record<string, { sentiment: string; note?: string }>;
        for (const [code, entry] of Object.entries(data)) {
          accumulated[code] = {
            sentiment: (entry.sentiment ?? "Josephine") as "Bullish" | "Josephine" | "Bearish",
            note: entry.note,
            // Flag as "new upturn" if 3PTL detected a recent breakout above resistance
            newUpturn: !!(entry.note?.toLowerCase().includes("broke above") ||
                          entry.note?.toLowerCase().includes("trough recovery")),
          };
        }
        setTrendlineProgress({ done: Math.min(i + CHUNK, codes.length), total: codes.length });
      }

      const stored: StoredTrendlines = {
        timestamp: new Date().toISOString(),
        checkedCount: codes.length,
        data: accumulated,
      };
      localStorage.setItem(TRENDLINE_STORAGE_KEY, JSON.stringify(stored));
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
      const res = await fetch("/api/trendline?commodities=1");
      if (!res.ok) throw new Error(`Commodity API error ${res.status}`);
      const json = await res.json() as { commodities: Record<string, { sentiment?: string; note?: string; error?: string }> };
      const auto: StoredCommodities["auto"] = {};
      for (const [key, entry] of Object.entries(json.commodities)) {
        if (entry.error || !entry.sentiment) continue;
        auto[key] = {
          sentiment: entry.sentiment as TrendlineSentiment,
          note: entry.note,
        };
      }
      const stored: StoredCommodities = {
        timestamp: new Date().toISOString(),
        auto,
        manual: commodityData?.manual ?? {},
      };
      localStorage.setItem(COMMODITY_STORAGE_KEY, JSON.stringify(stored));
      setCommodityData(stored);
      setShowCommodityPanel(true);
    } catch (e) {
      setError(e instanceof Error ? `Commodity check: ${e.message}` : "Commodity check failed.");
    } finally {
      setCommodityChecking(false);
    }
  }, [commodityData]);

  /** Cycle a commodity's manual sentiment: (unset) → Bullish → Josephine → Bearish → (unset).
   *  Manual settings win over the auto calculation — used for the feedless
   *  commodities (iron ore, coal, lithium, nickel: read the TE chart) and to
   *  overrule the algorithm on any other. */
  const cycleCommodityOverride = useCallback((key: string) => {
    setCommodityData((prev) => {
      const base: StoredCommodities = prev ?? { timestamp: null, auto: {}, manual: {} };
      const order: (TrendlineSentiment | undefined)[] = [undefined, "Bullish", "Josephine", "Bearish"];
      const current = base.manual[key];
      const next = order[(order.indexOf(current) + 1) % order.length];
      const manual = { ...base.manual };
      if (next === undefined) delete manual[key];
      else manual[key] = next;
      const stored: StoredCommodities = { ...base, manual };
      localStorage.setItem(COMMODITY_STORAGE_KEY, JSON.stringify(stored));
      return stored;
    });
  }, []);

  /** Set or clear a manual 3PTL sentiment override for one stock. */
  const saveSentimentOverride = useCallback((code: string, value: SentimentOverride | null) => {
    setSentimentOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[code];
      else next[code] = value;
      localStorage.setItem(SENTIMENT_STORAGE_KEY, JSON.stringify(next));
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
    localStorage.setItem(BUYBACK_STORAGE_KEY, JSON.stringify(stored));
    setBuybackData(map);
    setBuybackCount(activeCodes.length);
    setBuybackLoaded(true);
    setShowBuybackPanel(false);
  }, []);

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
    if (filterSentiment === "bullish")   result = result.filter((s) => s.S_sentiment_long === 2);
    if (filterSentiment === "josephine") result = result.filter((s) => s.S_sentiment_long === 0);
    if (filterSentiment === "bearish")   result = result.filter((s) => s.S_sentiment_long === -1);
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

                {/* 3PTL auto-calculation */}
                {!trendlineChecking && (
                  <button
                    onClick={calculateTrendlines}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                      trendlineLoaded
                        ? "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
                        : "text-gray-500 border-gray-300 hover:bg-gray-50"
                    }`}
                    title="Calculate 3PTL (3-Point Trendline) from 5yr monthly Yahoo Finance data"
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
                  const palette =
                    eff === "Bullish"   ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
                    eff === "Bearish"   ? "bg-red-100 text-red-800 border-red-300" :
                    eff === "Josephine" ? "bg-yellow-100 text-yellow-800 border-yellow-300" :
                                          "bg-white text-gray-400 border-dashed border-gray-300";
                  return (
                    <button
                      key={c.key}
                      onClick={() => cycleCommodityOverride(c.key)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${palette}`}
                      title={`${c.label}: ${eff ?? "not set"}${manual ? " (manual)" : auto ? " (auto 3PTL)" : ""}${auto?.note ? `\n${auto.note}` : ""}${c.symbol ? "" : "\nNo live feed — read the Trading Economics chart and click to set"}\nClick to cycle manual override: Bullish → Josephine → Bearish → auto`}
                    >
                      {c.label} {eff === "Bullish" ? "▲" : eff === "Bearish" ? "▼" : eff === "Josephine" ? "◆" : "—"}
                      {manual && <span className="ml-1 opacity-60">✎</span>}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-amber-700">
                <span>
                  Stocks whose underlying commodity is <strong>Bearish</strong> are forced to Bearish sentiment (QAV commodity rule).
                  Feedless commodities (Iron Ore, Coal, Lithium, Nickel) — read{" "}
                  <a href="https://tradingeconomics.com/commodities" target="_blank" rel="noreferrer" className="underline">Trading Economics</a>{" "}
                  and click the chip to set. Click any chip to override; ✎ = manual.
                </span>
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
              sentimentOverrides={sentimentOverrides}
              onSentimentOverride={saveSentimentOverride}
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
