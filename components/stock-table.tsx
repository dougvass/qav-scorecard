"use client";

import React, { useState, useMemo } from "react";
import { ScoredStock, SCORE_COL_META, ScoreColumns } from "@/lib/types";
import { qavColor, scoreColor } from "@/lib/qav-scoring";
import { ChevronDown, ChevronUp, ChevronsUpDown, Info } from "lucide-react";

interface StockTableProps {
  stocks: ScoredStock[];
  showAll: boolean;
}

type SortKey = "QAV" | "TotalScore" | "Count" | "Code" | keyof ScoreColumns | "adt";
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
  if (val === null)
    return <span className="text-xs text-gray-300 select-none">—</span>;
  const color =
    val > 0
      ? "bg-emerald-100 text-emerald-800"
      : val < 0
      ? "bg-red-100 text-red-700"
      : "bg-gray-100 text-gray-500";
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

function SentimentBadge({ stock }: { stock: ScoredStock }) {
  if (stock.S_sentiment_long === 1) {
    return (
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SENTIMENT_COLORS["bullish_proxy"]}`}>
        Bullish
      </span>
    );
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SENTIMENT_COLORS["—"]}`}>
      Bearish
    </span>
  );
}

function StarBadge({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-xs text-gray-300">—</span>;
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
  const color = rating >= 4 ? "text-emerald-600" : rating === 3 ? "text-amber-500" : "text-red-400";
  return <span className={`text-sm font-medium ${color}`} title={`${rating} stars`}>{stars}</span>;
}

export function StockTable({ stocks, showAll }: StockTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("QAV");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [minAdt, setMinAdt] = useState(0);
  const [filterSentiment, setFilterSentiment] = useState<"all" | "bullish" | "bearish">("all");

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
    if (minAdt > 0) {
      result = result.filter(
        (s) => (s["Avg Trade 3M ($000)"] ?? 0) >= minAdt
      );
    }
    if (filterSentiment === "bullish") result = result.filter((s) => s.S_sentiment_long === 1);
    if (filterSentiment === "bearish") result = result.filter((s) => s.S_sentiment_long !== 1);
    return result;
  }, [stocks, minAdt, filterSentiment]);

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
            onChange={(e) => setFilterSentiment(e.target.value as typeof filterSentiment)}
            className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="all">All</option>
            <option value="bullish">Bullish only</option>
            <option value="bearish">Bearish only</option>
          </select>
        </div>
        <span className="text-sm text-gray-400 ml-auto">
          {sorted.length} stock{sorted.length !== 1 ? "s" : ""}
          {!showAll && " in buy list"}
        </span>
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
              <Th label="ADT $k" col="adt" title="Average Daily Traded (3 month, $000)" className="text-right" />
              <Th label="QAV" col="QAV" title="Quality / PCF × 100 — the main ranking score" className="text-center" />
              <Th label="Score" col="TotalScore" title="Sum of all score columns" className="text-center" />
              <Th label="N" col="Count" title="Number of scored columns" className="text-center" />
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">Sentiment</th>
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
                    <td className="px-3 py-3 font-bold text-gray-900">{stock.Code}</td>
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
                    <td className="px-3 py-3 text-right text-gray-600">{adtStr}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center justify-center min-w-[52px] rounded-full px-2.5 py-1 text-sm font-bold ${qavColor(stock.QAV)}`}>
                        {stock.QAV !== null ? stock.QAV.toFixed(1) : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center font-semibold text-gray-700">
                      {stock.TotalScore.toFixed(1)}
                    </td>
                    <td className="px-3 py-3 text-center text-gray-400">{stock.Count}</td>
                    <td className="px-3 py-3 text-center">
                      <SentimentBadge stock={stock} />
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
                      <td colSpan={12} className="px-6 py-4">
                        <ScoreBreakdown stock={stock} />
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

function ScoreBreakdown({ stock }: { stock: ScoredStock }) {
  const adt = stock["Avg Trade 3M ($000)"];
  const price = stock["Share Price ($)"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-6 text-sm text-gray-600">
        <span><strong className="text-gray-800">Price:</strong> {price !== null ? `$${price.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">ADT:</strong> {adt !== null ? `$${adt.toFixed(0)}k` : "—"}</span>
        <span><strong className="text-gray-800">PCF:</strong> {stock.PCF !== null ? stock.PCF.toFixed(1) : "—"}</span>
        <span><strong className="text-gray-800">IV1:</strong> {stock.IV1 !== null ? `$${stock.IV1.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">IV2:</strong> {stock.IV2 !== null ? `$${stock.IV2.toFixed(2)}` : "—"}</span>
        <span><strong className="text-gray-800">PE:</strong> {stock.PE !== null ? stock.PE.toFixed(1) : "—"}</span>
        <span><strong className="text-gray-800">Div Yield:</strong> {stock["Div Yield (%)"] !== null ? `${stock["Div Yield (%)"]?.toFixed(1)}%` : "—"}</span>
        <span><strong className="text-gray-800">FH Rating:</strong> {stock["Financial Health Rating"] || "—"}</span>
        <span><strong className="text-gray-800">FH Trend:</strong> {stock["Financial Health Trend"] || "—"}</span>
        <span><strong className="text-gray-800">Star Status:</strong> {stock["Star Stock Status"] || "—"}</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {SCORE_COL_META.map((meta) => {
          const val = (stock as Record<string, unknown>)[meta.key] as number | null;
          return (
            <div
              key={meta.key}
              className="bg-white rounded-lg border border-gray-200 px-3 py-2 flex items-center justify-between gap-2"
              title={meta.description}
            >
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-700 truncate">{meta.label}</p>
                {meta.phase > 0 && (
                  <p className="text-xs text-indigo-400">Phase {meta.phase}</p>
                )}
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
