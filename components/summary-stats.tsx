"use client";

import { ScoredStock } from "@/lib/types";
import { TrendingUp, Star, BarChart2, DollarSign } from "lucide-react";

interface SummaryStatsProps {
  all: ScoredStock[];
  buyList: ScoredStock[];
}

export function SummaryStats({ all, buyList }: SummaryStatsProps) {
  const topStock = buyList[0];
  // The third tile used to be MorningStar coverage. MorningStar was dropped on
  // 2026-11-14 (its public API stopped returning star ratings), so the tile
  // now answers a question that is always live: how much of the buy list the
  // 3PTL currently reads as a buy.
  const bullish = buyList.filter((s) => s.S_sentiment_long === 2).length;

  const stats = [
    {
      icon: <BarChart2 className="w-5 h-5 text-indigo-600" />,
      label: "Stocks analysed",
      value: all.length.toString(),
      sub: `${buyList.length} qualify (QAV ≥ 10)`,
      bg: "bg-indigo-50",
    },
    {
      icon: <TrendingUp className="w-5 h-5 text-emerald-600" />,
      label: "Top QAV score",
      value: topStock ? topStock.QAV?.toFixed(1) ?? "—" : "—",
      sub: topStock ? `${topStock.Code} — ${topStock.Name.split(" ").slice(0, 3).join(" ")}` : "No results",
      bg: "bg-emerald-50",
    },
    {
      icon: <Star className="w-5 h-5 text-amber-600" />,
      label: "Bullish on the buy list",
      value: buyList.length > 0 ? `${bullish}` : "—",
      sub: buyList.length > 0
        ? `of ${buyList.length} — above both 3PTL lines`
        : "Load a CSV to see",
      bg: "bg-amber-50",
    },
    {
      icon: <DollarSign className="w-5 h-5 text-blue-600" />,
      label: "Avg buy-list QAV",
      value:
        buyList.length > 0
          ? (
              buyList.reduce((a, s) => a + (s.QAV ?? 0), 0) / buyList.length
            ).toFixed(1)
          : "—",
      sub: "Higher = cheaper relative to quality",
      bg: "bg-blue-50",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div key={s.label} className={`${s.bg} rounded-xl p-4 flex flex-col gap-2`}>
          <div className="flex items-center gap-2">
            {s.icon}
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {s.label}
            </span>
          </div>
          <p className="text-3xl font-bold text-gray-900">{s.value}</p>
          <p className="text-xs text-gray-500">{s.sub}</p>
        </div>
      ))}
    </div>
  );
}
