"use client";

import React, { useMemo, useState } from "react";
import { AlertTriangle, Check, Pencil, RefreshCw, X } from "lucide-react";
import { ScoredStock } from "@/lib/types";
import { StoredTrendlines, TrendlineSentiment } from "@/lib/trendline-storage";
import { parseHoldings, isHoldingAlert } from "@/lib/holdings-storage";
import { isJosephineDip } from "@/lib/sentiment-storage";

interface Props {
  codes: string[];
  allStocks: ScoredStock[] | null;
  trendlineData: StoredTrendlines | null;
  onSave: (codes: string[]) => void;
  /** Fetch 3PTL for held codes the CSV does not cover. Resolves when stored. */
  onCheckMissing: (codes: string[]) => Promise<void>;
  checking: boolean;
}

const TONE: Record<string, string> = {
  Bearish:   "bg-red-100 text-red-800 border-red-300",
  Watch:     "bg-sky-100 text-sky-800 border-sky-300",
  Josephine: "bg-teal-100 text-teal-800 border-teal-300",
  Bullish:   "bg-emerald-100 text-emerald-800 border-emerald-300",
};

/** Alerts first, then Watch, then the rest — the order he needs to act in. */
const RANK: Record<string, number> = { Bearish: 0, Watch: 1, Josephine: 2, Bullish: 3 };

export default function HoldingsPanel({
  codes, allStocks, trendlineData, onSave, onCheckMissing, checking,
}: Props) {
  const [editing, setEditing] = useState(codes.length === 0);
  const [draft, setDraft] = useState(codes.join(", "));
  const [skipped, setSkipped] = useState<string[]>([]);

  const rows = useMemo(() => {
    const byCode = new Map((allStocks ?? []).map((s) => [s.Code, s]));
    return codes.map((code) => {
      const stock = byCode.get(code);
      const tl = trendlineData?.data?.[code];
      // The 3PTL entry is the sell-line truth. A stock's displayed sentiment can
      // also have been forced by the commodity gate or a manual override, which
      // is worth seeing but is not "it broke its line".
      const sentiment = (tl?.sentiment ?? null) as TrendlineSentiment | null;
      const effective = stock
        ? (stock.S_sentiment_long === 2 ? "Bullish"
          : stock.S_sentiment_long === -1 ? "Bearish"
          : stock.S_sentiment_long === 0 ? (isJosephineDip(stock) ? "Josephine" : "Watch")
          : null)
        : null;
      return {
        code, stock, sentiment, effective,
        note: tl?.note ?? null,
        alert: isHoldingAlert(sentiment) || isHoldingAlert(effective),
        rank: RANK[sentiment ?? ""] ?? 4,
      };
    }).sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  }, [codes, allStocks, trendlineData]);

  const alerts = rows.filter((r) => r.alert);
  const unknown = rows.filter((r) => !r.sentiment).map((r) => r.code);

  function commit() {
    const { codes: parsed, skipped: skip } = parseHoldings(draft);
    setSkipped(skip);
    onSave(parsed);
    setDraft(parsed.join(", "));
    if (parsed.length) setEditing(false);
  }

  return (
    <div className="space-y-3">
      {/* What needs action, before anything else on the page. */}
      {codes.length > 0 && (
        <div className={`rounded-lg border px-4 py-3 ${
          alerts.length ? "bg-red-50 border-red-200" : "bg-emerald-50 border-emerald-200"}`}>
          <div className="flex items-start gap-2.5">
            {alerts.length
              ? <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              : <Check className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />}
            <div className="text-sm">
              {alerts.length ? (
                <>
                  <strong className="text-red-800">
                    {alerts.length} of your {codes.length} holdings {alerts.length === 1 ? "has" : "have"} broken a sell line
                  </strong>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {alerts.map((r) => (
                      <span key={r.code} className="px-2 py-0.5 rounded bg-red-100 text-red-800 border border-red-300 text-xs font-semibold">
                        {r.code}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <strong className="text-emerald-800">
                  None of your {codes.length} holdings {codes.length === 1 ? "has" : "have"} broken a sell line
                </strong>
              )}
              {unknown.length > 0 && (
                <div className="mt-1.5 text-xs text-gray-600">
                  No 3PTL yet for {unknown.join(", ")} —{" "}
                  <button onClick={() => onCheckMissing(unknown)} disabled={checking}
                          className="underline hover:text-gray-900 disabled:opacity-50">
                    {checking ? "checking…" : "check these now"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The list itself. */}
      {codes.length > 0 && !editing && (
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="text-left px-3 py-2 font-semibold">Code</th>
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold">3PTL</th>
                <th className="text-left px-3 py-2 font-semibold">Line</th>
                <th className="text-right px-3 py-2 font-semibold">QAV</th>
                <th className="text-center px-3 py-2 font-semibold">Buy list</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className={`border-b border-gray-100 last:border-0 ${r.alert ? "bg-red-50/60" : ""}`}>
                  <td className="px-3 py-2">
                    <a href={`https://www.tradingview.com/chart/?symbol=ASX:${r.code}&interval=1M`}
                       target="_blank" rel="noreferrer"
                       className="font-semibold text-indigo-700 hover:underline"
                       title={`Open ${r.code} on TradingView`}>
                      {r.code}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate">
                    {r.stock?.Name ?? <span className="text-gray-400">not in the loaded CSV</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.sentiment ? (
                      <span className={`px-2 py-0.5 rounded border text-xs font-medium ${TONE[r.sentiment] ?? "bg-gray-100 text-gray-500 border-gray-300"}`}>
                        {r.sentiment}
                      </span>
                    ) : <span className="text-gray-400 text-xs">—</span>}
                    {r.effective && r.sentiment && r.effective !== r.sentiment && (
                      <span className="ml-1.5 text-[11px] text-gray-500" title="The scorecard shows this instead — a commodity gate or a manual override is in force">
                        → {r.effective}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[260px] truncate" title={r.note ?? ""}>
                    {r.note ?? ""}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.stock?.QAV ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.stock && typeof r.stock.QAV === "number" && r.stock.QAV >= 10
                      ? <span className="text-emerald-600" title="Qualifies for the buy list">●</span>
                      : <span className="text-gray-300">·</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Entry / editing. */}
      {editing ? (
        <div className="border border-gray-200 rounded-lg bg-white p-4 space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            Your holdings — paste codes, or paste a whole Sharesight export
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="BHP, CBA, WES&#10;or one per line, or paste the CSV straight out of Sharesight"
            className="w-full text-sm font-mono px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <p className="text-xs text-gray-500">
            Codes only — Sharesight keeps your units and cost base, and this list exists to tell you
            when one of them breaks its 3PTL sell line. <code className="bg-gray-100 px-1 rounded">BHP.AX</code> and{" "}
            <code className="bg-gray-100 px-1 rounded">ASX:BHP</code> are both understood; other markets are skipped.
            Stored in this browser only.
          </p>
          {skipped.length > 0 && (
            <p className="text-xs text-amber-700">
              Skipped {skipped.length} non-ASX {skipped.length === 1 ? "holding" : "holdings"}: {skipped.join(", ")}
            </p>
          )}
          <div className="flex gap-2">
            <button onClick={commit}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
              Save holdings
            </button>
            {codes.length > 0 && (
              <button onClick={() => { setDraft(codes.join(", ")); setEditing(false); setSkipped([]); }}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                <X className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <button onClick={() => setEditing(true)} className="underline hover:text-gray-900">
            <Pencil className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Edit holdings ({codes.length})
          </button>
          <button onClick={() => onCheckMissing(codes)} disabled={checking}
                  className="underline hover:text-gray-900 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 inline -mt-0.5 mr-1 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Refreshing 3PTL…" : "Refresh 3PTL for these"}
          </button>
          <span className="text-gray-400">
            Bearish = price below the sell line. Watch is between the lines, not an alert.
          </span>
        </div>
      )}
    </div>
  );
}
