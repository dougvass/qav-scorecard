"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import { ScoredStock, SCORE_COL_META, ScoreColumns } from "@/lib/types";
import { qavColor, scoreColor, isEtfOrFund } from "@/lib/qav-scoring";
import { ChevronDown, ChevronUp, ChevronsUpDown, Info } from "lucide-react";
import { StoredSentiments, SentimentOverride } from "@/lib/sentiment-storage";

interface StockTableProps {
  stocks: ScoredStock[];
  showAll: boolean;
  hideEtfs: boolean;
  onToggleEtfs: () => void;
  filterSentiment: "all" | "bullish" | "bearish";
  onChangeFilterSentiment: (v: "all" | "bullish" | "bearish") => void;
  borrowingRate: number;
  phase2Loaded?: boolean;
  sentimentOverrides?: StoredSentiments;
  onSentimentOverride?: (code: string, value: SentimentOverride | null) => void;
}

type SortKey = "QAV" | "Quality" | "PCF" | "Code" | keyof ScoreColumns | "adt";
type SortDir = "asc" | "desc";

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-800",
  josephine: "bg-sky-100 text-sky-800",
  schrodinger: "bg-orange-100 text-orange-800",
  negative: "bg-red-100 text-red-700",
  insufficient_data: "bg-gray-100 text-gray-500",
  bullish_proxy: "bg-green-100 text-green-800",
  "—": "bg-gray-100 text-gray-400",
};

function ScorePill({ val }: { val: number | null }) {
  // null  = no data at all (not scored)            → dash
  // 0     = scored but did not pass the test       → amber "0" so it's clearly different from null
  // > 0   = scored and passed (or bonus points)    → green
  // < 0   = scored but negative (deteriorating)    → red
  if (val === null)
    return <span className="text-xs text-gray-300 select-none">—</span>;
  const color =
    val > 0
      ? "bg-emerald-100 text-emerald-800"
      : val < 0
      ? "bg-red-100 text-red-700"
      : "bg-amber-50 text-amber-700 border border-amber-200"; // 0 = data present, test failed
  return (
    <span className={`inline-flex items-center justify-center min-w-[28px] rounded px-1.5 py-0.5 text-xs font-semibold ${color}`}>
      {val > 0 ? `+${val}` : val}
    </span>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: string; sortKey: string; sortDir: SortDir }) {
  if (col !== sortKey) return <ChevronsUpDown className="w-3 h-3 text-gray-300" />;
  return sortDir === "asc"
    ? <ChevronUp className="w-3 h-3 text-indigo-500" />
    : <ChevronDown className="w-3 h-3 text-indigo-500" />;
}

const SENTIMENT_OPTIONS: { label: SentimentOverride | "Auto"; value: SentimentOverride | null }[] = [
  { label: "Auto", value: null },
  { label: "Bullish", value: "Bullish" },
  { label: "Josephine", value: "Josephine" },
  { label: "Bearish", value: "Bearish" },
];

function SentimentBadge({
  stock,
  override,
  onOverride,
}: {
  stock: ScoredStock;
  override?: SentimentOverride;
  onOverride?: (code: string, value: SentimentOverride | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const v = stock.S_sentiment_long;
  const isOverridden = override !== undefined;
  let label = "Josephine";
  let colorCls = SENTIMENT_COLORS["josephine"];
  if (v === 2)  { label = "Bullish";   colorCls = SENTIMENT_COLORS["bullish_proxy"]; }
  if (v === -1) { label = "Bearish";   colorCls = SENTIMENT_COLORS["negative"]; }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((x) => !x)}
        className={`text-xs px-2 py-0.5 rounded-full font-medium transition-opacity hover:opacity-80 ${colorCls}`}
        title={isOverridden ? `Manual override: ${override}. Click to change.` : "Click to manually set 3PTL sentiment"}
      >
        {label}{isOverridden && " ✎"}
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-1/2 -translate-x-1/2 bg-white border border-gray-200 rounded-lg shadow-lg p-1.5 min-w-[140px]">
          <p className="text-xs text-gray-400 px-2 pb-1 border-b border-gray-100 mb-1">3PTL override</p>
          {SENTIMENT_OPTIONS.map(({ label: l, value }) => (
            <button
              key={l}
              onClick={() => { onOverride?.(stock.Code, value); setOpen(false); }}
              className={`w-full text-left text-xs px-2 py-1.5 rounded hover:bg-gray-50 flex items-center justify-between ${
                (value === null && !isOverridden) || (value === override) ? "font-semibold text-indigo-600" : "text-gray-700"
              }`}
            >
              {l}
              {((value === null && !isOverridden) || (value === override)) && <span>✓</span>}
            </button>
          ))}
          <a
            href={`https://www.tradingview.com/chart/?symbol=ASX:${stock.Code}&interval=1M`}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-indigo-500 hover:text-indigo-700 px-2 py-1.5 border-t border-gray-100 mt-1"
            onClick={() => setOpen(false)}
          >
            Open {stock.Code} on TradingView ↗
          </a>
        </div>
      )}
    </div>
  );
}

function StarBadge({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-xs text-gray-300">—</span>;
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
  const color = rating >= 4 ? "text-emerald-600" : rating === 3 ? "text-amber-500" : "text-red-400";
  return <span className={`text-sm font-medium ${color}`} title={`${rating} stars`}>{stars}</span>;
}

export function StockTable({ stocks, showAll, hideEtfs, onToggleEtfs, filterSentiment, onChangeFilterSentiment, borrowingRate, phase2Loaded, sentimentOverrides, onSentimentOverride }: StockTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("QAV");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [minAdt, setMinAdt] = useState(0);
  const [search, setSearch] = useState("");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const filtered = useMemo(() => {
    let result = [...stocks];
    if (hideEtfs) result = result.filter((s) => !isEtfOrFund(s));
    if (minAdt > 0) {
      result = result.filter(
        (s) => (s["Avg Trade 3M ($000)"] ?? 0) >= minAdt
      );
    }
    if (filterSentiment === "bullish") result = result.filter((s) => s.S_sentiment_long === 2);
    if (filterSentiment === "bearish") result = result.filter((s) => s.S_sentiment_long === -1);
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      result = result.filter(
        (s) => s.Code.toUpperCase().includes(q) || s.Name.toUpperCase().includes(q)
      );
    }
    return result;
  }, [stocks, minAdt, filterSentiment, hideEtfs, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string | null = null;
      let bv: number | string | null = null;
      if (sortKey === "Code") {
        av = a.Code; bv = b.Code;
      } else if (sortKey === "adt") {
        av = a["Avg Trade 3M ($000)"] ?? -Infinity;
        bv = b["Avg Trade 3M ($000)"] ?? -Infinity;
      } else {
        av = (a as Record<string, unknown>)[sortKey] as number | null;
        bv = (b as Record<string, unknown>)[sortKey] as number | null;
        av = av ?? -Infinity;
        bv = bv ?? -Infinity;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });
  }, [filtered, sortKey, sortDir]);

  const Th = ({
    label,
    col,
    title,
    className = "",
  }: {
    label: string;
    col: SortKey;
    title?: string;
    className?: string;
  }) => (
    <th
      className={`px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800 ${className}`}
      onClick={() => toggleSort(col)}
      title={title}
    >
      <div className="flex items-center gap-1">
        {label}
        <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
      </div>
    </th>
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600">Min ADT $</label>
          <select
            value={minAdt}
            onChange={(e) => setMinAdt(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value={0}>Any</option>
            <option value={100}>≥ $100k</option>
            <option value={250}>≥ $250k</option>
            <option value={500}>≥ $500k</option>
            <option value={1000}>≥ $1M</option>
            <option value={2000}>≥ $2M</option>
            <option value={5000}>≥ $5M</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600">Sentiment</label>
          <select
            value={filterSentiment}
            onChange={(e) => onChangeFilterSentiment(e.target.value as "all" | "bullish" | "bearish")}
            className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="all">All</option>
            <option value="bullish">Bullish only</option>
            <option value="bearish">Bearish only</option>
          </select>
        </div>
        <button
          onClick={onToggleEtfs}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
            hideEtfs
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
          }`}
          title="Hide ETFs, managed funds, and LICs — also updates summary stats"
        >
          {hideEtfs ? "ETFs hidden" : "Hide ETFs/Funds"}
        </button>
        <div className="flex items-center gap-1.5 ml-auto">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code or name…"
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white w-48 focus:outline-none focus:ring-2 focus:ring-indigo-400 placeholder-gray-400"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          )}
          <span className="text-sm text-gray-400 whitespace-nowrap">
            {sorted.length} stock{sorted.length !== 1 ? "s" : ""}
            {!showAll && " in buy list"}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
              <Th label="Code" col="Code" className="min-w-[80px]" />
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[160px]">Company</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Sector</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Price</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide" title="Intrinsic Value 1 — EPS ÷ 19.5% (Tony's hurdle)">IV1</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide" title="Intrinsic Value 2 — Forecast EPS ÷ 10.1% (market hurdle)">IV2</th>
              <Th label="ADT $k" col="adt" title="Average Daily Traded (3 month, $000)" className="text-right" />
              <Th label="QAV" col="QAV" title="Quality / PCF × 100 — the main ranking score" className="text-center" />
              <Th label="Quality" col="Quality" title="Average score per column (TotalScore ÷ Count) — green ≥ 75%" className="text-center" />
              <Th label="PCF" col="PCF" title="Price to Cash Flow — lower is cheaper" className="text-center" />
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">Sentiment</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide" title="Active on-market buyback detected via ASX announcements">BB</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">MS ★</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">Breakdown</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((stock, idx) => {
              const isExpanded = expandedCode === stock.Code;
              const adt = stock["Avg Trade 3M ($000)"];
              const adtStr =
                adt === null
                  ? "—"
                  : adt >= 1000
                  ? `$${(adt / 1000).toFixed(1)}M`
                  : `$${adt.toFixed(0)}k`;

              // MorningStar star rating from S_sp_lt_iv3 score + raw rating
              const msRating = (stock as Record<string, unknown>)._msStarRating as number | undefined;

              return (
                <React.Fragment key={stock.Code}>
                  <tr
                    className={`transition-colors ${
                      isExpanded ? "bg-indigo-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <td className="px-3 py-3 text-xs text-gray-400">{idx + 1}</td>
                    <td className="px-3 py-3 font-bold">
                      <a
                        href={`https://finance.yahoo.com/quote/${stock.Code}.AX/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-700 hover:text-indigo-900 hover:underline"
                        title={`Open ${stock.Code}.AX on Yahoo Finance`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {stock.Code}
                      </a>
                    </td>
                    <td className="px-3 py-3 text-gray-700 max-w-[220px] truncate" title={stock.Name}>
                      {stock.Name}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-500 max-w-[130px] truncate" title={stock["Industry Group"]}>
                      {stock["Industry Group"]}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-gray-700">
                      {stock["Share Price ($)"] !== null
                        ? `$${stock["Share Price ($)"]?.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-indigo-600">
                      {stock.IV1 !== null ? `$${stock.IV1.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs text-violet-600">
                      {stock.IV2 !== null ? `$${stock.IV2.toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-3 text-right text-gray-600">{adtStr}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center justify-center min-w-[52px] rounded-full px-2.5 py-1 text-sm font-bold ${qavColor(stock.QAV)}`}>
                        {stock.QAV !== null ? stock.QAV.toFixed(1) : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      {stock.Quality !== null ? (
                        <span className={`inline-flex items-center justify-center min-w-[52px] rounded-full px-2 py-0.5 text-xs font-bold ${
                          stock.Quality >= 0.75
                            ? "bg-emerald-100 text-emerald-800"
                            : stock.Quality > 0
                            ? "bg-amber-100 text-amber-800"
                            : "bg-gray-100 text-gray-500"
                        }`}>
                          {(stock.Quality * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs text-gray-600">
                      {stock.PCF !== null ? stock.PCF.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <SentimentBadge
                        stock={stock}
                        override={sentimentOverrides?.[stock.Code]}
                        onOverride={onSentimentOverride}
                      />
                    </td>
                    <td className="px-3 py-3 text-center">
                      {stock.S_buyback === 1 ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-100 text-orange-700 text-xs font-bold" title="Active buyback detected">↑</span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <StarBadge rating={msRating ?? null} />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => setExpandedCode(isExpanded ? null : stock.Code)}
                        className="p-1 rounded hover:bg-indigo-100 transition-colors"
                        title="Show score breakdown"
                      >
                        <Info className="w-4 h-4 text-indigo-400 hover:text-indigo-600" />
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${stock.Code}-expand`} className="bg-indigo-50 border-b border-indigo-100">
                      <td colSpan={15} className="px-6 py-4">
                        <ScoreBreakdown stock={stock} borrowingRate={borrowingRate} phase2Loaded={phase2Loaded} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>

        {sorted.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            No stocks match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreBreakdown({ stock, borrowingRate, phase2Loaded }: { stock: ScoredStock; borrowingRate: number; phase2Loaded?: boolean }) {
  const adt = stock["Avg Trade 3M ($000)"];
  const price = stock["Share Price ($)"];
  const divYield = stock["Div Yield (%)"];
  const divCoversDebt = divYield !== null && divYield > borrowingRate;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-6 text-sm text-gray-600">
        <span><strong className="text-gray-800">Price:</strong> {price !== null ? `$${price.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">ADT:</strong> {adt !== null ? `$${adt.toFixed(0)}k` : "—"}</span>
        <span><strong className="text-gray-800">PCF:</strong> {stock.PCF !== null ? stock.PCF.toFixed(1) : "—"}</span>
        <span><strong className="text-gray-800">IV1:</strong> {stock.IV1 !== null ? `$${stock.IV1.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">IV2:</strong> {stock.IV2 !== null ? `$${stock.IV2.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">PE:</strong> {stock.PE !== null ? stock.PE.toFixed(1) : "—"}</span>
        <span>
          <strong className="text-gray-800">Div Yield:</strong>{" "}
          {divYield !== null ? (
            <span className={divCoversDebt ? "text-emerald-700 font-semibold" : ""}>
              {divYield.toFixed(1)}%
              {divCoversDebt ? (
                <span className="ml-1.5 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">
                  &gt; {borrowingRate}% ✓
                </span>
              ) : (
                <span className="ml-1.5 text-xs text-gray-400">
                  &lt; {borrowingRate}% borrow cost
                </span>
              )}
            </span>
          ) : "—"}
        </span>
        <span><strong className="text-gray-800">FH Rating:</strong> {stock["Financial Health Rating"] || "—"}</span>
        <span><strong className="text-gray-800">FH Trend:</strong> {stock["Financial Health Trend"] || "—"}</span>
        <span><strong className="text-gray-800">Star Status:</strong> {stock["Star Stock Status"] || "—"}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {SCORE_COL_META.map((meta) => {
          const val = (stock as Record<string, unknown>)[meta.key] as number | null;

          // Sub-label under the score name — phase-specific context
          let subLabel: React.ReactNode = null;
          if (meta.key === "S_sentiment_long") {
            // Source label: manual override > 3PTL calc > SDMAX
            const src = " · auto 3PTL";
            if (val === 2)  subLabel = <span className="text-xs font-medium text-emerald-600">↑ Bullish{src}</span>;
            else if (val === -1) subLabel = <span className="text-xs font-medium text-red-500">↓ Bearish{src}</span>;
            else subLabel = <span className="text-xs text-sky-600">⇔ Josephine{src}</span>;
          } else if (meta.key === "S_buyback") {
            if (val === 1)  subLabel = <span className="text-xs font-medium text-emerald-600">✓ Active · ASX</span>;
            else subLabel = <span className="text-xs text-gray-400">Not detected · ASX</span>;
          } else if (meta.phase === 2) {
            if (val !== null && val > 0) {
              subLabel = <span className="text-xs font-medium text-emerald-600">✓ Pass · Spreadsheet</span>;
            } else if (val === 0) {
              subLabel = <span className="text-xs font-medium text-amber-600">✗ Fail · Spreadsheet</span>;
            } else if (val !== null && val < 0) {
              subLabel = <span className="text-xs font-medium text-red-500">✗ Worst · Spreadsheet</span>;
            } else if (phase2Loaded) {
              subLabel = <span className="text-xs text-gray-400">Not in spreadsheet</span>;
            } else {
              subLabel = <span className="text-xs text-teal-600">↑ Load Phase 2 Spreadsheet</span>;
            }
          } else if (meta.phase === 1) {
            subLabel = <span className="text-xs text-indigo-400">3PTL (manual)</span>;
          } else if (meta.phase === 3) {
            subLabel = <span className="text-xs text-amber-500">MorningStar</span>;
          }

          return (
            <div
              key={meta.key}
              className="bg-white rounded-lg border border-gray-200 px-3 py-2 flex items-center justify-between gap-2"
              title={meta.description}
            >
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-700 truncate">{meta.label}</p>
                {subLabel}
              </div>
              <ScorePill val={val} />
            </div>
          );
        })}
      </div>

      <div className="text-xs text-gray-400">
        Total: <strong className="text-gray-600">{stock.TotalScore.toFixed(1)}</strong> across{" "}
        <strong className="text-gray-600">{stock.Count}</strong> scored columns ·{" "}
        Quality (avg): <strong className="text-gray-600">{stock.Quality?.toFixed(3) ?? "—"}</strong> ·{" "}
        QAV: <strong className="text-gray-700">{stock.QAV?.toFixed(2) ?? "—"}</strong>
      </div>
    </div>
  );
}
