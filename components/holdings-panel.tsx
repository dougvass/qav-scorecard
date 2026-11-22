"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, Check, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { ScoredStock } from "@/lib/types";
import { StoredTrendlines, TrendlineSentiment } from "@/lib/trendline-storage";
import { parseHoldings, isHoldingAlert } from "@/lib/holdings-storage";
import { isJosephineDip } from "@/lib/sentiment-storage";
import {
  COMMODITIES, STOCK_COMMODITY, StoredCommodities, effectiveCommoditySentiment,
} from "@/lib/commodities";
import {
  MAJORITY_PCT, StoredExposure, commodityLabel, formatReviewLines, gateCommodity, majorityCommodity,
} from "@/lib/revenue-exposure";

interface Props {
  codes: string[];
  allStocks: ScoredStock[] | null;
  trendlineData: StoredTrendlines | null;
  onSave: (codes: string[]) => void;
  /** Add one code AND run its 3PTL straight away. A holding added by hand is
   *  almost always one just bought, so the first thing wanted is its reading —
   *  Doug, 2026-10-24: "also make the 3PTL run when a new stock is added." */
  onAdd: (code: string) => Promise<void>;
  /** The commodity complex, so the QAV commodity gate can be applied HERE too.
   *  enrichWithCommodityGate only runs over the scored CSV rows, so a holding
   *  absent from the CSV — which is most of the reason this list exists — was
   *  never gated. Doug, 2026-11-03: "It needs to flag them as sells/bearish if
   *  the commodity for that stock is a sell." */
  commodities?: StoredCommodities | null;
  /** Reviewed revenue mixes — which commodity, if any, is the majority of a
   *  holding's revenue. See lib/revenue-exposure.ts. */
  exposure: StoredExposure | null;
  /** Save the reviews from the editor's lines; returns the lines it could not read. */
  onSaveExposure: (text: string) => string[];
  /** Signed in to the server store — the alert job reads the holdings from there. */
  signedIn: boolean;
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
  codes, allStocks, trendlineData, commodities, exposure, onSaveExposure, signedIn, onSave, onAdd, onCheckMissing, checking,
}: Props) {
  const [editing, setEditing] = useState(codes.length === 0);
  const [draft, setDraft] = useState(codes.join(", "));
  const [skipped, setSkipped] = useState<string[]>([]);
  const [newCode, setNewCode] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewRejected, setReviewRejected] = useState<string[]>([]);

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
      // The QAV commodity gate, applied directly rather than inherited from a
      // scored CSV row — a holding the CSV does not carry must still be flagged
      // when its underlying commodity is a sell. Mirrors enrichWithCommodityGate,
      // including the rule that a PROXY commodity is advisory and never gates on
      // its own automatic read.
      // WHICH commodity governs it comes from its reviewed revenue mix where
      // there is one — the majority of revenue, or none — and from the sector
      // map only for a holding nobody has reviewed.
      const review = exposure?.reviews[code] ?? null;
      const commodityKey = gateCommodity(code, exposure);
      const share = review ? majorityCommodity(review) : null;
      const def = commodityKey ? COMMODITIES.find((c) => c.key === commodityKey) : undefined;
      const commoditySentiment = commodityKey && commodities
        ? effectiveCommoditySentiment(commodities, commodityKey) : null;
      const advisory = !!def?.proxy && commodities?.manual[commodityKey] === undefined;
      const gated = commoditySentiment === "Bearish" && !advisory;
      return {
        code, stock, sentiment, effective, gated,
        // No 3PTL could be drawn for it (under a year of history). Known, not
        // missing — so it must not be offered for a re-check that cannot help.
        noChart: !!tl?.unreadable,
        commodity: def ? (def.label + (def.proxy ? "*" : "")) : null,
        review,
        share: share ? Math.round(share.pct) : null,
        sectorMap: !review && STOCK_COMMODITY[code] ? commodityLabel(STOCK_COMMODITY[code]) : null,
        note: tl?.note ?? null,
        alert: gated || isHoldingAlert(sentiment) || isHoldingAlert(effective),
        rank: gated ? 0 : (RANK[sentiment ?? ""] ?? 4),
      };
    }).sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  }, [codes, allStocks, trendlineData, commodities, exposure]);

  const alerts = rows.filter((r) => r.alert);
  const gatedCount = rows.filter((r) => r.gated).length;
  const unknown = rows.filter((r) => !r.sentiment && !r.noChart).map((r) => r.code);
  const unreviewed = rows.filter((r) => !r.review).map((r) => r.code);

  function openReviews() {
    // Every holding gets a line, reviewed or not, so a new one is a matter of
    // filling in the mix rather than remembering the format.
    const have = exposure?.reviews ?? {};
    const lines = formatReviewLines(have).split("\n").filter(Boolean);
    for (const code of codes) if (!have[code]) lines.push(`${code} | `);
    setReviewDraft(lines.join("\n"));
    setReviewRejected([]);
    setReviewing(true);
  }

  function saveReviews() {
    // A holding left with nothing after its code has not been reviewed: drop
    // the line rather than record "reviewed, no commodity" by accident.
    const kept = reviewDraft.split(/\r?\n/).filter((l) => l.split("|").slice(1).join("").trim() !== "");
    const rejected = onSaveExposure(kept.join("\n"));
    setReviewRejected(rejected);
    if (!rejected.length) setReviewing(false);
  }

  function removeCode(code: string) {
    onSave(codes.filter((c) => c !== code));
    setDraft(codes.filter((c) => c !== code).join(", "));
  }

  async function addCode() {
    const raw = newCode.trim().toUpperCase();
    if (!raw) return;
    // Reuse the same parser the bulk paste uses, so "BHP.AX" and "ASX:BHP"
    // behave identically however the code arrives.
    const { codes: parsed, skipped: skip } = parseHoldings(raw);
    if (!parsed.length) {
      setAddError(skip.length ? `${skip.join(", ")} is not an ASX code` : `"${raw}" is not an ASX code`);
      return;
    }
    const code = parsed[0];
    if (codes.includes(code)) {
      setAddError(`${code} is already in your holdings`);
      return;
    }
    setAddError(null);
    setNewCode("");
    setAdding(true);
    try {
      await onAdd(code);
      setDraft([...codes, code].sort().join(", "));
    } finally {
      setAdding(false);
    }
  }

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
                    {alerts.length} of your {codes.length} holdings {alerts.length === 1 ? "needs" : "need"} attention
                  </strong>
                  {gatedCount > 0 && (
                    <div className="text-xs text-red-700 mt-0.5">
                      {alerts.length - gatedCount > 0 && `${alerts.length - gatedCount} broke a sell line; `}
                      {gatedCount} forced Bearish by the commodity rule
                    </div>
                  )}
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
                  {commodities ? " or been made a sell by its commodity" : ""}
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
          <table className="w-full text-sm md:min-w-[640px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="text-left px-3 py-2 font-semibold">Code</th>
                <th className="hidden md:table-cell text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold">3PTL</th>
                <th className="hidden md:table-cell text-left px-3 py-2 font-semibold">Line</th>
                <th className="hidden md:table-cell text-left px-3 py-2 font-semibold"
                    title="Where its revenue comes from, as the company reports it. A commodity that is more than half of revenue governs the holding: if it becomes a sell, so does the holding.">
                  Revenue
                </th>
                <th className="text-right px-3 py-2 font-semibold">QAV</th>
                <th className="text-center px-3 py-2 font-semibold"
                    title="Average score per column (TotalScore ÷ Count) — green ≥ 75%">
                  Quality
                </th>
                <th className="hidden md:table-cell text-center px-3 py-2 font-semibold">Buy list</th>
                <th className="w-8 px-2 py-2"><span className="sr-only">Remove</span></th>
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
                  <td className="hidden md:table-cell px-3 py-2 text-gray-600 max-w-[220px] truncate">
                    {r.stock?.Name ?? <span className="text-gray-400">not in the loaded CSV</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.gated ? (
                      <span className="px-2 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 border-red-300"
                            title={`${r.commodity} is a sell, so the QAV commodity rule forces this holding to Bearish`}>
                        Bearish
                      </span>
                    ) : r.sentiment ? (
                      <span className={`px-2 py-0.5 rounded border text-xs font-medium ${TONE[r.sentiment] ?? "bg-gray-100 text-gray-500 border-gray-300"}`}>
                        {r.sentiment}
                      </span>
                    ) : r.noChart && r.effective ? (
                      // No 3PTL could be drawn, but he has read the chart and
                      // set a sentiment by hand on the scorecard — show that.
                      <span className={`px-2 py-0.5 rounded border text-xs font-medium ${TONE[r.effective] ?? "bg-gray-100 text-gray-500 border-gray-300"}`}
                            title="Set by hand — there is too little price history for an automatic 3PTL">
                        {r.effective} ✎
                      </span>
                    ) : r.noChart ? (
                      <span className="px-2 py-0.5 rounded border text-xs font-medium bg-gray-100 text-gray-500 border-gray-300"
                            title="Under a year of price history, so no 3PTL can be drawn yet. Set a sentiment by hand from the scorecard's Sentiment column once you have read the chart.">
                        No chart
                      </span>
                    ) : <span className="text-gray-400 text-xs">—</span>}
                    {r.gated && (
                      <span className="ml-1.5 text-[11px] text-red-600" title="QAV commodity rule">
                        ⛏ {r.commodity}
                      </span>
                    )}
                    {r.effective && r.sentiment && r.effective !== r.sentiment && (
                      <span className="ml-1.5 text-[11px] text-gray-500" title="The scorecard shows this instead — a commodity gate or a manual override is in force">
                        → {r.effective}
                      </span>
                    )}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-xs text-gray-500 max-w-[260px] truncate"
                      title={r.gated ? `${r.commodity} is a sell (QAV commodity rule)` : (r.note ?? "")}>
                    {r.gated
                      ? `${r.commodity} is a sell${r.share ? ` — ${r.share}% of revenue` : ""}`
                      : (r.note ?? "")}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-xs max-w-[300px]">
                    {r.review ? (
                      <span className="flex flex-wrap gap-1"
                            title={[r.review.business, [r.review.period, r.review.source].filter(Boolean).join(", "), `Reviewed ${r.review.reviewed}`].filter(Boolean).join("\n")}>
                        {r.review.slices.length === 0 && <span className="text-gray-400">no commodity</span>}
                        {r.review.slices.slice().sort((a, b) => b.pct - a.pct).slice(0, 4).map((sl) => {
                          const reading = sl.key && commodities ? effectiveCommoditySentiment(commodities, sl.key) : null;
                          const governs = sl.key !== null && sl.key === gateCommodity(r.code, exposure);
                          return (
                            <span key={sl.label}
                                  className={`px-1.5 py-0.5 rounded border ${
                                    reading === "Bearish" ? "bg-red-50 text-red-700 border-red-200"
                                    : sl.key ? "bg-amber-50 text-amber-800 border-amber-200"
                                    : "bg-gray-50 text-gray-600 border-gray-200"} ${governs ? "font-semibold" : ""}`}
                                  title={`${sl.label}: ${sl.pct < 1 ? "under 1" : sl.pct}% of revenue`
                                    + (sl.key ? ` · ${commodityLabel(sl.key)} reads ${reading ?? "not run"}` : " · not a commodity the site reads")
                                    + (governs ? ` · more than ${MAJORITY_PCT}%, so it governs this holding` : "")}>
                              {sl.label} {sl.pct < 1 ? "<1" : Math.round(sl.pct)}%
                            </span>
                          );
                        })}
                      </span>
                    ) : (
                      <span className="text-gray-400"
                            title="Nobody has read this company's revenue split yet, so the commodity rule falls back to the sector map.">
                        not reviewed{r.sectorMap ? ` · sector map: ${r.sectorMap}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.stock?.QAV ?? <span className="text-gray-300">—</span>}
                  </td>
                  {/* Same pill and thresholds as the main tables, so the number
                      reads identically wherever he meets it. */}
                  <td className="px-3 py-2 text-center">
                    {typeof r.stock?.Quality === "number" ? (
                      <span className={`inline-flex items-center justify-center min-w-[52px] rounded-full px-2 py-0.5 text-xs font-bold ${
                        r.stock.Quality >= 0.75
                          ? "bg-emerald-100 text-emerald-800"
                          : r.stock.Quality > 0
                          ? "bg-amber-100 text-amber-800"
                          : "bg-gray-100 text-gray-500"
                      }`}>
                        {(r.stock.Quality * 100).toFixed(1)}%
                      </span>
                    ) : <span className="text-xs text-gray-300">—</span>}
                  </td>
                  <td className="hidden md:table-cell px-3 py-2 text-center">
                    {r.stock && typeof r.stock.QAV === "number" && r.stock.QAV >= 10
                      ? <span className="text-emerald-600" title="Qualifies for the buy list">●</span>
                      : <span className="text-gray-300">·</span>}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button
                      onClick={() => removeCode(r.code)}
                      className="text-gray-300 hover:text-red-600 transition-colors p-1 rounded hover:bg-red-50"
                      title={`Remove ${r.code} from your holdings`}
                      aria-label={`Remove ${r.code}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add one code. The common case by far — a holding changes one stock at
          a time — so it sits right under the list rather than behind the bulk
          paste editor, and it runs the new code's 3PTL on the way in. */}
      {codes.length > 0 && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <input
              value={newCode}
              onChange={(e) => { setNewCode(e.target.value); setAddError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addCode(); } }}
              placeholder="Add ASX code"
              aria-label="Add an ASX code to your holdings"
              maxLength={12}
              disabled={adding}
              className="w-36 text-sm font-mono uppercase px-2.5 py-1.5 border border-gray-300 rounded-lg
                         focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            />
            <button
              onClick={() => void addCode()}
              disabled={adding || !newCode.trim()}
              className="flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium rounded-lg border
                         border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100
                         disabled:opacity-40 disabled:hover:bg-indigo-50 transition-colors"
              title="Add this code and run its 3PTL"
            >
              {adding
                ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                : <Plus className="w-3.5 h-3.5" />}
              {adding ? "Checking 3PTL…" : "Add"}
            </button>
          </div>
          {addError && <span className="text-xs text-red-600">{addError}</span>}
          {!addError && (
            <span className="text-xs text-gray-400">
              Adding a code runs its 3PTL straight away.
            </span>
          )}
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
            {!commodities && " Run Commodities to apply the commodity rule here too."}
          </span>
        </div>
      )}

      {/* Where each holding's revenue comes from — what the commodity rule runs on. */}
      {codes.length > 0 && !editing && (
        reviewing ? (
          <div className="border border-gray-200 rounded-lg bg-white p-4 space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Revenue reviews — one holding per line
            </label>
            <textarea
              value={reviewDraft}
              onChange={(e) => setReviewDraft(e.target.value)}
              rows={Math.min(16, Math.max(5, reviewDraft.split("\n").length + 1))}
              spellCheck={false}
              aria-label="Revenue reviews, one holding per line"
              className="w-full text-xs font-mono px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="text-xs text-gray-500">
              <code className="bg-gray-100 px-1 rounded">CODE | Gold 76, Copper 8, Other 16 | FY26 | where it was read | what the business does</code>
              <br />
              Percentages of revenue, as the company reports them. A commodity above {MAJORITY_PCT}% governs the
              holding. A line with a code and a source but no mix records that it was reviewed and no commodity
              drives it. Labels the site reads: {COMMODITIES.map((c) => c.label).join(", ")} — anything else
              (Met coal, Civil, Other) is shown and never triggers a sell.
            </p>
            {reviewRejected.length > 0 && (
              <p className="text-xs text-red-600">Could not read: {reviewRejected.join(" · ")}</p>
            )}
            <div className="flex gap-2">
              <button onClick={saveReviews}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
                Save reviews
              </button>
              <button onClick={() => setReviewing(false)}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                <X className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <button onClick={openReviews} className="underline hover:text-gray-900">
              <Pencil className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />Edit revenue reviews
            </button>
            {unreviewed.length > 0 && (
              <span className="text-amber-700">
                Not reviewed yet: {unreviewed.join(", ")}
              </span>
            )}
          </div>
        )
      )}

      {codes.length > 0 && !editing && <AlertsBox signedIn={signedIn} holdings={codes.length} />}
    </div>
  );
}

// ── Alerts ───────────────────────────────────────────────────────────────────

interface AlertStatus {
  configured?: boolean;
  signedIn?: boolean;
  channels?: { email: boolean; sms: boolean };
  database?: boolean;
  state?: { lastRun: string | null; lastSent: string | null; lastError: string | null; alerts: Record<string, unknown> };
}

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "never" : d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * The email / text-message alert: what is switched on, when it last looked,
 * and a way to prove it reaches him. The job itself runs on the server each
 * weekday evening (app/api/alerts/cron) from the holdings mirrored there, so
 * this is a status panel, not the thing that does the work.
 */
function AlertsBox({ signedIn, holdings }: { signedIn: boolean; holdings: number }) {
  const [status, setStatus] = useState<AlertStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      setStatus(res.ok ? ((await res.json()) as AlertStatus) : { configured: true, signedIn: false });
    } catch { setStatus(null); }
  }, []);

  useEffect(() => { if (signedIn) void refresh(); }, [signedIn, refresh, holdings]);

  async function act(action: "run" | "test") {
    setBusy(action); setSaid(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const d = (await res.json()) as {
        sent?: string[]; errors?: string[];
        change?: { fresh: { code: string }[]; cleared: string[]; standing: { code: string }[] } | null;
      };
      if (d.errors?.length) setSaid(d.errors.join(" · "));
      else if (action === "test") setSaid(`Test sent by ${(d.sent ?? []).join(" and ")}.`);
      else {
        const fresh = d.change?.fresh.map((v) => v.code) ?? [];
        const cleared = d.change?.cleared ?? [];
        const standing = d.change?.standing.length ?? 0;
        setSaid(
          fresh.length || cleared.length
            ? [fresh.length ? `New sells: ${fresh.join(", ")}` : "", cleared.length ? `no longer a sell: ${cleared.join(", ")}` : "",
               d.sent?.length ? `sent by ${d.sent.join(" and ")}` : "nothing sent — no channel is switched on"].filter(Boolean).join(" · ")
            : `Nothing has changed${standing ? ` (${standing} still a sell)` : ""}, so nothing was sent.`,
        );
      }
      await refresh();
    } catch { setSaid("The check could not be run."); }
    finally { setBusy(null); }
  }

  const on = status?.channels;
  const anyChannel = !!(on?.email || on?.sms);
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
      <div className="flex items-start gap-2.5">
        <Bell className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
        <div className="space-y-1.5 min-w-0">
          <div className="text-sm font-semibold text-gray-800">Sell alerts by email or text</div>
          {!signedIn ? (
            <p>Sign in with your passcode to use these: the nightly check reads your holdings from the server copy.</p>
          ) : !status ? (
            <p>Checking…</p>
          ) : status.configured === false ? (
            <p>Server storage is off (no passcode set), so there is nowhere for the nightly check to read your holdings from.</p>
          ) : (
            <>
              <p>
                Each weekday evening the site re-reads every holding and the commodities, and writes to you when one
                becomes a sell — its own sell line, or the commodity that is most of its revenue — or stops being one.
              </p>
              <p>
                Email: <strong className={on?.email ? "text-emerald-700" : "text-amber-700"}>{on?.email ? "on" : "not set up"}</strong>
                {" · "}Text message: <strong className={on?.sms ? "text-emerald-700" : "text-gray-500"}>{on?.sms ? "on" : "not set up"}</strong>
                {" · "}Last check: {when(status.state?.lastRun)}
                {" · "}Last message: {when(status.state?.lastSent)}
              </p>
              {status.state?.lastError && <p className="text-red-600">Last problem: {status.state.lastError}</p>}
              <div className="flex flex-wrap gap-2 pt-0.5">
                <button onClick={() => void act("run")} disabled={busy !== null}
                        className="px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40"
                        title="Run the nightly check now. It writes to you only if something has changed.">
                  {busy === "run" ? "Checking…" : "Run the check now"}
                </button>
                <button onClick={() => void act("test")} disabled={busy !== null || !anyChannel}
                        className="px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                        title={anyChannel ? "Send a test message down every channel that is on" : "Nothing to test until a channel is set up"}>
                  {busy === "test" ? "Sending…" : "Send a test message"}
                </button>
              </div>
              {said && <p className="text-gray-800">{said}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
