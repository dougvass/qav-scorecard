"use client";

/**
 * The buy list's track record: every stock that has been on it, measured on
 * TOTAL return from the day it joined, beside the ASX 200's total return over
 * exactly the same days.
 *
 * Doug, 2026-11-15: "Is there a way we could measure and track 1YR, 3YR, and
 * 5YR returns all in Total return ... to help track our QAV stocks? Could be
 * interesting and useful data to track." The 1/3/5-year columns on the stock
 * table look backwards. This is the half that looks forwards from the signal:
 * was a high QAV score FOLLOWED by a better return than the market's?
 *
 * WHERE THE DATES COME FROM. The scorecard has recorded every stock's QAV score
 * each day it has been run (lib/history-storage.ts). "Joined the list" is the
 * first recorded day a stock's QAV was 10 or more — or, on the stricter basis,
 * the first day it was also a 3PTL Buy. A stock that was already on the list on
 * its first recorded day is measured from that day and marked: when it really
 * joined is before the records began.
 *
 * WHAT IT IS NOT. It is buy-and-hold from the join date to today, whatever the
 * stock has done to its score or its sell line since; it is not a record of
 * trades. And the series behind it carries dividends but not franking credits.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { HistoryPoint, HistorySeries, todayIso } from "@/lib/history-storage";
import { ScoredStock } from "@/lib/types";

const MIN_QAV = 10;
const CACHE_KEY = "qav_track_record_v1";
const BATCH = 25;

type Basis = "list" | "buy";

interface Entry {
  code: string;
  name: string;
  joined: string;
  /** On the list on its first recorded day: the real join date is earlier. */
  fromStart: boolean;
  qavThen: number | null;
  qavNow: number | null;
  onNow: boolean;
  sentimentNow: string | null;
  /** In the most recent snapshot at all (false = dropped out of the export). */
  current: boolean;
}

interface Measured {
  startDate: string | null;
  startClose: number | null;
  endDate: string | null;
  endClose: number | null;
  total: number | null;
  price: number | null;
  error?: string;
}

interface ApiResponse {
  results?: Record<string, Measured>;
  benchmark?: { symbol?: string; bySince?: Record<string, number | null> };
}

interface Cached {
  day: string;
  basis: Basis;
  measured: Record<string, Measured>;
  bench: Record<string, number | null>;
}

type SortKey = "code" | "joined" | "days" | "total" | "bench" | "excess" | "qav";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function niceDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  return `${d} ${MONTHS[(m || 1) - 1]} ${String(y).slice(2)}`;
}
function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000));
}
function pct(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function tone(v: number | null): string {
  if (v === null) return "text-gray-300";
  return v > 0 ? "text-emerald-700" : v < 0 ? "text-red-600" : "text-gray-500";
}

export function TrackRecord({
  history, stocks, isFund,
}: {
  history: HistorySeries;
  stocks: ScoredStock[];
  /** Codes that are funds or LICs: the history still holds them from before
   *  they were set aside, and they are not QAV stocks. */
  isFund: (code: string) => boolean;
}) {
  const [basis, setBasis] = useState<Basis>("list");
  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  const [bench, setBench] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [measuredFor, setMeasuredFor] = useState<string | null>(null);   // `${day}:${basis}`
  const [sortKey, setSortKey] = useState<SortKey>("excess");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const today = todayIso();

  // ── Who has been on the list, and since when ───────────────────────────────
  const entries = useMemo<Entry[]>(() => {
    const names = new Map(stocks.map((s) => [s.Code, String(s.Name ?? "")]));
    // A code the export no longer carries cannot be classified by its row, and
    // the records go back to when funds were still scored. ASX ordinary shares
    // have three-character codes; a longer one that has dropped out of the
    // export is a retired fund (TCAP, QGRU, KSM, MGOC), not a stock. A longer
    // code that IS in the export is kept: it was classified there (SGLLV).
    const notAStock = (code: string): boolean => isFund(code) || (!names.has(code) && code.length > 3);
    let latest = "";
    for (const pts of Object.values(history)) {
      const last = pts[pts.length - 1];
      if (last && last.d > latest) latest = last.d;
    }
    const on = (p: HistoryPoint): boolean =>
      typeof p.qav === "number" && p.qav >= MIN_QAV && (basis === "list" || p.sentiment === "Bullish");
    const out: Entry[] = [];
    for (const [code, raw] of Object.entries(history)) {
      if (notAStock(code) || raw.length === 0) continue;
      const pts = [...raw].sort((a, b) => a.d.localeCompare(b.d));
      const i = pts.findIndex(on);
      if (i < 0) continue;
      const first = pts[i], last = pts[pts.length - 1];
      out.push({
        code,
        name: names.get(code) ?? "",
        joined: first.d,
        fromStart: i === 0,
        qavThen: first.qav,
        qavNow: last.qav,
        onNow: last.d === latest && on(last),
        sentimentNow: last.sentiment,
        current: last.d === latest,
      });
    }
    return out;
  }, [history, stocks, isFund, basis]);

  // ── Measure ────────────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    if (entries.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const outM: Record<string, Measured> = {};
      const outB: Record<string, number | null> = {};
      for (let i = 0; i < entries.length; i += BATCH) {
        const items = entries.slice(i, i + BATCH).map((e) => ({ code: e.code, since: e.joined }));
        const res = await fetch("/api/total-return", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) throw new Error(`Total return API error ${res.status}`);
        const json = await res.json() as ApiResponse;
        Object.assign(outM, json.results ?? {});
        Object.assign(outB, json.benchmark?.bySince ?? {});
        setProgress(Math.min(entries.length, i + BATCH));
      }
      setMeasured(outM);
      setBench(outB);
      setMeasuredFor(`${today}:${basis}`);
      try {
        const cached: Cached = { day: today, basis, measured: outM, bench: outB };
        localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
      } catch { /* quota or private mode — it is simply measured again next time */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not measure returns.");
    } finally {
      setBusy(false);
    }
  }, [entries, basis, today]);

  // Once a day per basis: reuse today's measurement if this browser has it,
  // otherwise measure when the tab is opened.
  useEffect(() => {
    if (busy || entries.length === 0 || measuredFor === `${today}:${basis}`) return;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw) as Cached;
        if (c && c.day === today && c.basis === basis && entries.every((e) => e.code in (c.measured ?? {}))) {
          setMeasured(c.measured);
          setBench(c.bench ?? {});
          setMeasuredFor(`${today}:${basis}`);
          return;
        }
      }
    } catch { /* unreadable cache: measure afresh */ }
    void run();
  // `run` changes with `entries`; listing it would re-fire on every re-score.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, basis, today, measuredFor]);

  // ── Rows ───────────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    return entries.map((e) => {
      const m = measured[e.code];
      const total = m?.total ?? null;
      const b = bench[e.joined] ?? null;
      return {
        ...e,
        days: daysBetween(e.joined, today),
        total,
        price: m?.price ?? null,
        bench: b,
        excess: total !== null && b !== null ? Math.round((total - b) * 10) / 10 : null,
        startClose: m?.startClose ?? null,
        endClose: m?.endClose ?? null,
      };
    });
  }, [entries, measured, bench, today]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: typeof rows[number]): number | string | null => {
      switch (sortKey) {
        case "code": return r.code;
        case "joined": return r.joined;
        case "days": return r.days;
        case "total": return r.total;
        case "bench": return r.bench;
        case "qav": return r.qavNow;
        case "excess":
        default: return r.excess;
      }
    };
    return [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av === null && bv === null) return a.code.localeCompare(b.code);
      if (av === null) return 1;            // nothing to show goes to the bottom
      if (bv === null) return -1;
      const d = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
      return d !== 0 ? d * dir : a.code.localeCompare(b.code);
    });
  }, [rows, sortKey, sortDir]);

  const summary = useMemo(() => {
    const done = rows.filter((r) => r.total !== null && r.bench !== null);
    const mean = (xs: number[]): number | null =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
    return {
      n: done.length,
      total: mean(done.map((r) => r.total as number)),
      bench: mean(done.map((r) => r.bench as number)),
      excess: mean(done.map((r) => r.excess as number)),
      ahead: done.filter((r) => (r.excess as number) > 0).length,
      tooNew: rows.length - done.length,
    };
  }, [rows]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "code" || k === "joined" ? "asc" : "desc"); }
  }
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const th = "px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800";

  const earliest = entries.length ? entries.map((e) => e.joined).sort()[0] : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-gray-900">Track record</h2>
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => setBasis("list")}
              className={`px-3 py-1.5 ${basis === "list" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
              title="Counted from the first recorded day the stock's QAV was 10 or more"
            >
              From joining the list
            </button>
            <button
              type="button"
              onClick={() => setBasis("buy")}
              className={`px-3 py-1.5 border-l border-gray-300 ${basis === "buy" ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
              title="Counted from the first recorded day it was on the list AND a 3PTL Buy"
            >
              From first being a buy
            </button>
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || entries.length === 0}
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? `Measuring… ${progress}/${entries.length}` : "Measure again"}
          </button>
        </div>
        <p className="text-sm text-gray-600 max-w-3xl">
          Each stock that has been on the buy list, measured on <strong>total return</strong> (price plus dividends
          reinvested) from {basis === "list" ? "the day it joined the list" : "the day it was first a buy"} to today,
          beside the <strong>ASX 200 total return</strong> over the same days. It is buy-and-hold from that day, not a
          record of trades, and franking credits are not counted on either side.
          {earliest && <> The scorecard&rsquo;s records begin {niceDate(earliest)}.</>}
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 px-1">
          Nothing to measure yet: no stock in the scorecard&rsquo;s records has
          {basis === "list" ? " had a QAV of 10 or more." : " been on the list and a 3PTL Buy on the same day."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stocks measured</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{summary.n}</p>
              <p className="text-xs text-gray-500">
                {summary.tooNew > 0 ? `${summary.tooNew} more too new to measure` : `of ${rows.length} on the list at some point`}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Average total return</p>
              <p className={`mt-1 text-2xl font-bold ${tone(summary.total)}`}>{pct(summary.total)}</p>
              <p className="text-xs text-gray-500">each from its own join date</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">ASX 200 over the same days</p>
              <p className={`mt-1 text-2xl font-bold ${tone(summary.bench)}`}>{pct(summary.bench)}</p>
              <p className="text-xs text-gray-500">total return index, averaged the same way</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Ahead of the index</p>
              <p className={`mt-1 text-2xl font-bold ${tone(summary.excess)}`}>{pct(summary.excess)}</p>
              <p className="text-xs text-gray-500">
                {summary.n > 0 ? `${summary.ahead} of ${summary.n} stocks ahead` : "no stock measured yet"}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className={`${th} text-left`} onClick={() => toggleSort("code")}>Code{arrow("code")}</th>
                  <th className="hidden md:table-cell px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Company</th>
                  <th className={`${th} text-left`} onClick={() => toggleSort("joined")}>Joined{arrow("joined")}</th>
                  <th className={`${th} text-right hidden sm:table-cell`} onClick={() => toggleSort("days")}>Days{arrow("days")}</th>
                  <th className={`${th} text-right hidden md:table-cell`} onClick={() => toggleSort("qav")} title="QAV on the day it joined, and now">QAV then → now{arrow("qav")}</th>
                  <th className="hidden md:table-cell px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Now</th>
                  <th className={`${th} text-right`} onClick={() => toggleSort("total")} title="Price change plus dividends reinvested, from the join date to today">Total return{arrow("total")}</th>
                  <th className={`${th} text-right`} onClick={() => toggleSort("bench")} title="S&P/ASX 200 Gross Total Return index over the same days">ASX 200{arrow("bench")}</th>
                  <th className={`${th} text-right`} onClick={() => toggleSort("excess")} title="Total return minus the ASX 200's over the same days">Difference{arrow("excess")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((r) => (
                  <tr key={r.code} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5">
                      <a
                        href={`https://www.tradingview.com/chart/?symbol=ASX:${r.code}&interval=1M`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-indigo-700 hover:underline"
                      >
                        {r.code}
                      </a>
                    </td>
                    <td className="hidden md:table-cell px-3 py-2.5 text-gray-600 max-w-[220px] truncate">{r.name || "—"}</td>
                    <td
                      className="px-3 py-2.5 whitespace-nowrap text-gray-700"
                      title={r.fromStart ? "Already on the list on its first recorded day: it joined before the scorecard's records for it begin" : undefined}
                    >
                      {r.fromStart && <span className="text-gray-400">≤ </span>}
                      {niceDate(r.joined)}
                    </td>
                    <td className="hidden sm:table-cell px-3 py-2.5 text-right font-mono text-xs text-gray-600">{r.days}</td>
                    <td className="hidden md:table-cell px-3 py-2.5 text-right font-mono text-xs text-gray-600">
                      {r.qavThen !== null ? r.qavThen.toFixed(1) : "—"} → {r.qavNow !== null ? r.qavNow.toFixed(1) : "—"}
                    </td>
                    <td className="hidden md:table-cell px-3 py-2.5 text-xs">
                      {!r.current ? (
                        <span className="text-gray-400">not in the latest list</span>
                      ) : r.onNow ? (
                        <span className="text-emerald-700 font-medium">{basis === "list" ? "on the list" : "still a buy"}</span>
                      ) : (
                        <span className="text-amber-700">{basis === "list" ? "off the list" : "no longer a buy"}</span>
                      )}
                      {r.current && r.sentimentNow && <span className="text-gray-400"> · {r.sentimentNow}</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono text-sm font-semibold ${tone(r.total)}`}>
                      {r.total === null && r.days <= 4 ? <span className="text-xs font-normal text-gray-400">too new</span> : pct(r.total)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono text-sm ${tone(r.bench)}`}>{pct(r.bench)}</td>
                    <td className={`px-3 py-2.5 text-right font-mono text-sm font-semibold ${tone(r.excess)}`}>{pct(r.excess)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
