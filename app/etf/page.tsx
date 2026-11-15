"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ETFS, type EtfMeta } from "@/lib/etfs";
import { LICS } from "@/lib/lics";
import { loadFundScores, type StoredFundScores } from "@/lib/fund-scores";

// ── This page used to be its own site ────────────────────────────────────────
//
// The ETF ranker lived at qav-etf-ranker.vercel.app as a fork of the scorecard.
// Doug, 2026-11-14: "combine the ETF ranker as a separate page." It is now
// /etf here: one home-screen app, one sign-in, and ONE copy of the 3PTL engine
// (lib/trendline-v3.ts) where there were two that had to be kept identical by
// hand. Its ranking is unchanged.
//
// The one join with the scorecard: a fund the Stock Doctor list has and this
// page's bundled universe does not is ADDED to the run, so it gets a 3PTL, a
// yield and a Quality like any other, and the list can be used as a filter.
// (The scorecard no longer scores any of them: ETFs, funds, LICs and PMGOLD are
// set aside when the CSV is loaded and ranked only here.)
//
// There WAS a QAV column, showing the scorecard's own score for each fund in
// that list ("the ETFs from the QAV list do have scores, even though they're
// not businesses"). Measured across the 68 funds the two pages share, it had no
// relation to this page's rank (correlation 0.27, driven by near-zero
// price-to-cashflow), and Doug had it removed on 2026-11-15: "we've proven
// there is no correlation."

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The scorecard's four sentiments, as the v3 engine returns them. The ranker
 * used to carry three — Bullish / Josephine / Bearish — because the v1 engine
 * could not express the fourth. v3 can: WATCH is a fund between its buy and
 * sell lines, which Doug describes as "not a sell nor a buy".
 *
 * Watch and Josephine both score 0 but are not the same reading: Watch is
 * between the lines, Josephine is above both lines but below last month's
 * close — the uptick dip. They stay separate so the filter can tell them apart.
 */
type Sentiment = "Buy" | "Watch" | "Josephine" | "Sell";

// Trailing TOTAL return (%) over each horizon — distributions reinvested (Yahoo
// dividend-adjusted closes), the basis Market Index quotes. null when the ETF's
// history doesn't reach that far back (e.g. a fund younger than 5 years has no r5y).
interface Perf {
  r6m: number | null;
  r1y: number | null;
  r3y: number | null;
  r5y: number | null;
}

const EMPTY_PERF: Perf = { r6m: null, r1y: null, r3y: null, r5y: null };

// Shape-of-the-ride numbers from the same total-return series, for the Quality
// checks. posFrac = fraction of rolling 12-month windows that ended positive;
// maxDD = worst peak-to-trough fall on monthly closes over the last 5 years (%).
interface Risk {
  posFrac: number | null;
  maxDD: number | null;
}

const EMPTY_RISK: Risk = { posFrac: null, maxDD: null };

interface TrendResult {
  sentiment?: Sentiment;
  // Which series the 3PTL read. "totalReturn" is the shipped basis; "price" is
  // the fallback for a fund whose adjusted series couldn't be lined up.
  basis?: "totalReturn" | "price";
  // The raw-price reading, present ONLY when it differs from `sentiment`.
  priceSentiment?: Sentiment | null;
  price?: number | null;
  yieldPct?: number | null;
  perf?: Perf | null;
  risk?: Risk | null;
  avgDailyValue?: number | null;  // 3M average daily traded value ($)
  buyLine?: number | null;
  sellLine?: number | null;
  note?: string;
  error?: string;
  months?: number;
}

interface RankedEtf {
  code: string;
  name: string;
  mer: number | null;        // % p.a.
  sentiment: Sentiment | null;      // total-return basis — this is what ranks
  basis: "totalReturn" | "price";
  priceSentiment: Sentiment | null; // raw-price reading, only when it differs
  price: number | null;
  yieldPct: number | null;   // trailing distribution yield %
  netYield: number | null;   // yield − mer
  perf: Perf;                // 6m / 1y / 3y / 5y total return
  risk: Risk;                // rolling-12m win rate + worst 5y drawdown
  sellLine: number | null;   // rising support extrapolated to today; null = falling knife
  avgDailyValue: number | null; // 3M average daily traded value ($)
  qavScore: number | null;   // composite rank score
  quality: number | null;    // ETF Quality pass rate, 0–1 (see below)
  qualityChecks: CheckResult[]; // the individual pass/fail/n-a, for the tooltip
  note: string;
  error?: string;
  /** Not in the bundled universe — it is here because the scorecard's Stock
   *  Doctor list has it. No fee on file, so its net yield is its gross yield. */
  fromQavList?: boolean;
}

// ── ETF "Quality" ─────────────────────────────────────────────────────────────
//
// The stock QAV score is Quality ÷ price-to-cashflow, where Quality is the
// unweighted mean of ~21 pass/fail checks. Neither half transplants whole:
//
//   * a fund has no cashflow per unit, so **there is no QAV score for an ETF**.
//     What this app calls `qavScore` is its own composite (sentiment tier then
//     net yield) and should not be read as a QAV number.
//   * of the 21 Quality columns, only THREE have a fund analogue —
//     S_sentiment_long (the 3PTL), S_div_yield (yield > borrowing rate) and
//     S_new_upturn (a buy-line breach, though its "since the last results
//     balance date" anchor has no meaning for a fund). S_sp_lt_neps and
//     S_sp_lt_1.3neps technically exist — NAV per unit is the exact analogue of
//     net equity per share — but market-maker arbitrage pins an open-ended ETF
//     to its NAV, so the test always reads "about equal" and carries no signal.
//     The remaining 16 are company fundamentals or analyst coverage: PCF, EPS,
//     PE, IV1–IV4, star stock, financial health, director ownership, buybacks.
//
// So Quality here is the same STRUCTURE — an unweighted mean over whatever
// checks are assessable, exactly as the stock side divides by its own `Count`
// rather than by 21 — over a checklist that suits a fund. Seven checks:
//
//   1. the 3PTL reads Buy                            41.0% of the universe pass
//   2. a sell line is drawable at all                90.9%
//   3. MER at or below the universe median            50.4%
//   4. 1y total return beats the benchmark            28.6%
//   5. 5y (else 3y) total return beats the benchmark  45.0%  (105 not assessable)
//   6. ≥80% of rolling 12m windows positive           53.8%
//   7. 5y drawdown shallower than the benchmark's     36.7%
//
// Measured across 385 funds on 2026-11-07 with VAS as the benchmark. 17 score
// 1.00 (A200, AQLT, E200, G200, GLIN, IHD, ILC, INCM, IOZ, QOZ, SFY, STW, SYI,
// VAS, VHY, VLC, VVLU — cheap Australian large-cap and dividend funds, which is
// the answer you'd hope for); 8 score 0.00 (BEAR, FHCO, FIIN, GGAB, GGFD, IMPQ,
// LEND, URAN); the mode is 3 of 7 at 79 funds, with 68 at 4 of 7. Check 2 is
// weak on its own at 90.9% and largely tracks check 1, but it is the one that
// separates "Sell because it is falling" from "Sell because nothing can be
// drawn", which is a different problem with a fund.
//
// Doug chose this list on 2026-11-07, explicitly WITHOUT an eighth check for
// "distribution yield > borrowing rate". That is the one QAV column that
// transplants mechanically, and on funds it lies: 23 of 385 show trailing
// yields above 15% and six above 25% (LNAS 74%, FTPG 64%, MAET 40%, FHCO,
// MCCL, ASAO ~32%) because they are paying out return of capital and realised
// gains, not income. With it in, LNAS scored 0.43 on a fake 74% yield; without
// it, it scores 0.43 on its actual record. Net yield still orders funds within
// a sentiment tier, so income is not ignored — just not double-counted through
// a number that misrepresents some funds.
//
// Quality is a COLUMN, not part of the rank. It sits beside the existing
// composite so the two can be compared before either is trusted.

/**
 * The benchmark every "beats the index" check is measured against. Doug chose
 * VAS over A200 on 2026-11-07 — "better than what I own" rather than "better
 * than the cheapest alternative".
 *
 * Worth knowing what that implies: VAS tracks the ASX 300 and the ASX 200 has
 * beaten it on both horizons (1y +8.2% vs +7.3%, 5y +50.3% vs +47.0%) with a
 * shallower worst drawdown (−11.7% vs −12.0%), so every ASX-200 tracker sweeps
 * all three benchmark checks. A200, IOZ, STW and E200 scoring 1.00 is that
 * effect, not an accident — the small-cap tail of the 300 has been the drag.
 */
const BENCHMARK = "VAS";

/** A fund has never had a losing year below this rolling-12m win rate. */
const CONSISTENCY_BAR = 0.8;

interface CheckResult {
  label: string;
  pass: boolean | null;   // null = not assessable, excluded from the mean
  detail: string;
}

/** Median MER over the whole bundled universe — deterministic, so it does not
 *  drift with which funds happened to fetch successfully on a given run. */
const MEDIAN_MER = (() => {
  const m = ETFS.map((e) => e.mer).filter((v): v is number => v != null).sort((a, b) => a - b);
  return m.length ? m[Math.floor(m.length / 2)] : null;
})();

interface QualityInput {
  code: string;
  sentiment: Sentiment | null;
  sellLine: number | null;
  mer: number | null;
  perf: Perf;
  risk: Risk;
}

/**
 * The seven checks for one fund. `bench` is the benchmark fund's own row, or
 * null when it failed to load — in which case the three benchmark-relative
 * checks are not assessable rather than silently failing.
 *
 * The benchmark fund itself also gets null for those three: "does VAS beat VAS"
 * is not a question, and answering it `false` would dock the benchmark two
 * checks for being the benchmark, which is how the first draft put VAS at
 * 0.714 while every ASX-200 tracker swept to 1.0.
 */
function qualityChecks(f: QualityInput, bench: QualityInput | null): CheckResult[] {
  const isBench = f.code === BENCHMARK;
  const b = isBench ? null : bench;

  // Long-run horizon: 5 years where the fund has it, otherwise 3. The horizon
  // is chosen from the FUND and then read off the benchmark at that SAME
  // horizon — picking each side's own longest would compare a 3-year-old fund's
  // 3y return against the benchmark's 5y return, which is how the first draft
  // failed GLIN (3y +46.4%) against VAS's 5y +47.0%.
  const horizon: "r5y" | "r3y" | null =
    f.perf.r5y != null ? "r5y" : f.perf.r3y != null ? "r3y" : null;
  const fLong = horizon ? f.perf[horizon] : null;
  // Pulled out as plain locals rather than read through `b?.…` inline, so the
  // null checks below narrow without relying on optional-chain narrowing.
  const bLong = horizon && b ? b.perf[horizon] : null;
  const b1y = b?.perf.r1y ?? null;
  const bDD = b?.risk.maxDD ?? null;

  return [
    {
      label: "3PTL reads Buy",
      pass: f.sentiment === null ? null : f.sentiment === "Buy",
      detail: f.sentiment ?? "no reading",
    },
    {
      label: "sell line drawable",
      pass: f.sentiment === null ? null : f.sellLine !== null,
      detail: f.sellLine !== null ? `support at ${f.sellLine.toFixed(2)}` : "falling knife — none",
    },
    {
      label: `MER ≤ universe median (${MEDIAN_MER?.toFixed(2) ?? "—"}%)`,
      pass: f.mer == null || MEDIAN_MER == null ? null : f.mer <= MEDIAN_MER,
      detail: f.mer == null ? "no fee on file" : `${f.mer.toFixed(2)}%`,
    },
    {
      label: `1y total return beats ${BENCHMARK}`,
      pass: f.perf.r1y == null || b1y == null ? null : f.perf.r1y > b1y,
      detail: f.perf.r1y == null ? "no 1y history"
        : isBench ? "is the benchmark"
        : b1y == null ? "no benchmark"
        : `${fmtPct(f.perf.r1y)} vs ${fmtPct(b1y)}`,
    },
    {
      label: `long-run total return beats ${BENCHMARK}`,
      pass: fLong == null || bLong == null ? null : fLong > bLong,
      detail: fLong == null ? "under 3 years old"
        : isBench ? "is the benchmark"
        : bLong == null ? `${BENCHMARK} has no ${horizon?.slice(1)} history`
        : `${horizon?.slice(1)} ${fmtPct(fLong)} vs ${fmtPct(bLong)}`,
    },
    {
      label: `≥${Math.round(CONSISTENCY_BAR * 100)}% of rolling 12m windows positive`,
      pass: f.risk.posFrac == null ? null : f.risk.posFrac >= CONSISTENCY_BAR,
      detail: f.risk.posFrac == null ? "no history" : `${Math.round(f.risk.posFrac * 100)}%`,
    },
    {
      label: `5y drawdown shallower than ${BENCHMARK}`,
      pass: f.risk.maxDD == null || bDD == null ? null : f.risk.maxDD >= bDD,
      detail: f.risk.maxDD == null ? "no history"
        : isBench ? "is the benchmark"
        : bDD == null ? "no benchmark"
        : `${fmtPct(f.risk.maxDD)} vs ${fmtPct(bDD)}`,
    },
  ];
}

/** Mean of the assessable checks, 0–1. Null when nothing can be assessed. */
function qualityScore(checks: CheckResult[]): number | null {
  const scored = checks.filter((c) => c.pass !== null);
  if (!scored.length) return null;
  return Math.round((scored.filter((c) => c.pass).length / scored.length) * 1000) / 1000;
}

// ── Composite scoring ─────────────────────────────────────────────────────────
//
// ETFs have none of the company fundamentals the stock QAV score is built from,
// so the "QAV" rank for ETFs combines the three things that DO apply:
//   1. 3PTL trend  — the sentiment: Buy (+2) / Watch (0) / Josephine (0) / Sell (−1)
//      read off the TOTAL-RETURN series (distributions reinvested), not the raw
//      price: a fund that pays its return out has no rising price support to
//      draw, so on price alone half the universe read Sell and sank below every
//      fund that happened to retain. See the BASIS note in app/api/trendline.
//   2. Distribution yield (higher is better)
//   3. Management fee / MER (lower is better)
//
// Sentiment is the dominant tier (×100 keeps Buy strictly above the two
// zero-scoring states, which sit strictly above Sell), and within a tier ETFs
// are ordered by NET yield (distribution yield minus fee) — the income you
// actually keep. Watch and Josephine deliberately share a tier, as they do in
// the scorecard: neither is a buy, and a fund is ranked on its income once the
// trend has stopped arguing for it.

const SENTIMENT_POINTS: Record<Sentiment, number> = {
  Buy: 2,
  Watch: 0,
  Josephine: 0,
  Sell: -1,
};

function compositeScore(sentiment: Sentiment | null, netYield: number | null): number | null {
  if (sentiment === null) return null;
  return SENTIMENT_POINTS[sentiment] * 100 + (netYield ?? 0);
}

// ── Batched fetch of the whole ETF universe ───────────────────────────────────

const BATCH_SIZE = 25;   // server caps POST at 25 codes
const CONCURRENCY = 3;   // parallel batches — gentle on Yahoo's rate limit
// Cache SCHEMA version, which is not the engine version — the "v3" here meant
// "added perf + 3M avg daily value" and predates the v3 engine entirely. Bumped
// to v4 on 2026-11-07 because the stored rows carry the retired Bullish /
// Bearish sentiments: left in place they would miss every badge and filter.
// Bumped again to v5 the same day for the total-return basis: 103 of 385 stored
// sentiments are from the raw-price series and would otherwise rank on. And to
// v6 for the Quality column, whose checks need `risk` and `sellLine` — fields a
// v5 row doesn't carry, so a restored run would show an empty column.
const CACHE_KEY = "qav-etf-rankings-v6";

async function fetchBatch(codes: string[]): Promise<Record<string, TrendResult>> {
  const res = await fetch("/api/etf-trendline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codes }),
  });
  if (!res.ok) throw new Error(`trendline ${res.status}`);
  return res.json();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function sentimentBadge(s: Sentiment | null): string {
  if (s === "Buy") return "bg-emerald-100 text-emerald-800";
  if (s === "Sell") return "bg-red-100 text-red-700";
  // Both score 0, so they share the amber family but not the same swatch —
  // Watch (between the lines) reads cooler than Josephine (the uptick dip).
  if (s === "Watch") return "bg-sky-100 text-sky-800";
  if (s === "Josephine") return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-400";
}

function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(dp);
}

// Signed one-dp percentage for the performance columns (e.g. "+12.4", "−3.1").
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const s = n.toFixed(1);
  return n > 0 ? `+${s}` : s.replace("-", "−");
}

// Quality shading. Thresholds are display only — they don't enter the score.
function qualityColor(q: number): string {
  if (q >= 0.8) return "text-emerald-700";
  if (q >= 0.5) return "text-gray-800";
  if (q >= 0.3) return "text-amber-700";
  return "text-red-600";
}

function perfColor(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "text-gray-300";
  if (n > 0) return "text-emerald-700";
  if (n < 0) return "text-red-600";
  return "text-gray-500";
}

// Compact dollar value, e.g. 1_234_567 -> "$1.2M", 45_000 -> "$45k".
function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

// External chart links for a given ASX code.
const yahooUrl = (code: string) => `https://finance.yahoo.com/quote/${code}.AX`;
// Monthly interval — the 3PTL is drawn off the monthly chart.
const tradingViewUrl = (code: string) =>
  `https://www.tradingview.com/chart/?symbol=ASX%3A${code}&interval=1M`;

type SortKey = "rank" | "code" | "qual" | "yield" | "mer" | "net" | "price" | "r6m" | "r1y" | "r3y" | "r5y" | "liq";

// ── Listed investment companies ──────────────────────────────────────────────
//
// Doug, 2026-11-15: "LICs should go to the ETF page as with funds. We can
// compare them all in terms of their MER (if any) and return metrics." So the
// 91 LICs and LITs of lib/lics.ts are part of this page's universe, ranked in
// the same table by the same rule. Four of them (DN1, MA1, MRE, WMX) were
// already on Market Index's ETF list and keep the fee recorded there; the rest
// have no fee on file, so their net yield is their gross yield and the fee
// check is not assessed. A LIC is tagged in the table and can be filtered.
const LIC_CODES = new Set(LICS.map((l) => l.code));
const ETF_CODES = new Set(ETFS.map((e) => e.code));
const LIC_ONLY: EtfMeta[] = LICS
  .filter((l) => !ETF_CODES.has(l.code))
  .map((l) => ({ code: l.code, name: l.name, mer: null }));
const BASE_UNIVERSE: EtfMeta[] = ETFS.concat(LIC_ONLY);
const BUNDLED = new Set(BASE_UNIVERSE.map((e) => e.code));

export default function Page() {
  const [rows, setRows] = useState<RankedEtf[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const [sentimentFilter, setSentimentFilter] = useState<Sentiment | "All" | "NoData">("All");
  const [search, setSearch] = useState("");
  const [minLiquidity, setMinLiquidity] = useState("");  // min 3M avg daily $ traded ($k)
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [qavListOnly, setQavListOnly] = useState(false);
  const [kindFilter, setKindFilter] = useState<"All" | "ETF" | "LIC">("All");

  // The scorecard's scores for the funds in the Stock Doctor list. Read on
  // mount and again whenever this tab comes back into view, since the usual
  // way to change them is to load a CSV on the scorecard in another tab.
  const [fundScores, setFundScores] = useState<StoredFundScores | null>(null);
  useEffect(() => {
    const read = () => setFundScores(loadFundScores());
    read();
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", read);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", read);
    };
  }, []);

  // Funds the scorecard set aside from the Stock Doctor list that the bundled
  // universe (ETFs and LICs) does not have.
  const extras = useMemo<EtfMeta[]>(() => {
    const data = fundScores?.data ?? {};
    return Object.keys(data)
      .filter((code) => data[code].isFund && !BUNDLED.has(code))
      .sort()
      .map((code) => ({ code, name: data[code].name, mer: null }));
  }, [fundScores]);
  const universe = useMemo(() => BASE_UNIVERSE.concat(extras), [extras]);

  // In the universe but not in the run on screen: the run predates them. That
  // is a fund newly in the Stock Doctor list — or, for a run remembered from
  // before 2026-11-15, every LIC.
  const notYetRun = useMemo(() => {
    const have = new Set(rows.map((r) => r.code));
    return universe.filter((e) => !have.has(e.code)).map((e) => e.code);
  }, [rows, universe]);

  const total = universe.length;

  // Restore the last run from localStorage on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: string; rows: RankedEtf[] };
        // Defensively default the fields added after a given cache version, so
        // an older row renders as "no reading" instead of throwing on access.
        setRows(parsed.rows.map((r) => ({
          ...r,
          perf: r.perf ?? EMPTY_PERF,
          risk: r.risk ?? EMPTY_RISK,
          qualityChecks: r.qualityChecks ?? [],
          quality: r.quality ?? null,
        })));
        setLastRun(parsed.at);
      }
    } catch { /* ignore */ }
  }, []);

  async function run() {
    setRunning(true);
    setDone(0);

    // Build all batches.
    const batches: string[][] = [];
    for (let i = 0; i < universe.length; i += BATCH_SIZE) {
      batches.push(universe.slice(i, i + BATCH_SIZE).map((e) => e.code));
    }

    const merByCode = new Map(universe.map((e) => [e.code, e]));
    const collected: Record<string, TrendResult> = {};
    let completedCodes = 0;

    // Run batches with bounded concurrency.
    let cursor = 0;
    async function worker() {
      while (cursor < batches.length) {
        const myIdx = cursor++;
        const batch = batches[myIdx];
        try {
          const result = await fetchBatch(batch);
          Object.assign(collected, result);
        } catch {
          // mark this batch as errored so the rows still render
          for (const c of batch) collected[c] = { error: "fetch failed" };
        }
        completedCodes += batch.length;
        setDone(completedCodes);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Assemble rows. Quality needs the benchmark fund's own numbers, so it is a
    // second pass once every row exists.
    const base = universe.map((e) => {
      const r = collected[e.code] ?? {};
      const meta = merByCode.get(e.code)!;
      const sentiment = (r.sentiment as Sentiment) ?? null;
      const yieldPct = r.yieldPct ?? null;
      const mer = meta.mer;
      const netYield =
        yieldPct === null ? null : Math.round((yieldPct - (mer ?? 0)) * 100) / 100;
      return {
        code: e.code,
        name: e.name,
        mer,
        sentiment: r.error ? null : sentiment,
        basis: r.basis ?? "totalReturn",
        priceSentiment: r.error ? null : (r.priceSentiment ?? null),
        price: r.price ?? null,
        yieldPct,
        netYield,
        perf: r.perf ?? EMPTY_PERF,
        risk: r.risk ?? EMPTY_RISK,
        sellLine: r.sellLine ?? null,
        avgDailyValue: r.avgDailyValue ?? null,
        qavScore: r.error ? null : compositeScore(sentiment, netYield),
        note: r.note ?? r.error ?? "",
        error: r.error,
        fromQavList: !BUNDLED.has(e.code),
      };
    });

    const benchRow = base.find((b) => b.code === BENCHMARK && !b.error) ?? null;
    const ranked: RankedEtf[] = base.map((row) => {
      const checks = row.error ? [] : qualityChecks(row, benchRow);
      return { ...row, qualityChecks: checks, quality: qualityScore(checks) };
    });

    const at = new Date().toLocaleString("en-AU");
    setRows(ranked);
    setLastRun(at);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at, rows: ranked }));
    } catch { /* quota — ignore */ }
    setRunning(false);
  }

  // Rank position (1-based) by composite score, computed once over all rows.
  const rankByCode = useMemo(() => {
    const sorted = [...rows]
      .filter((r) => r.qavScore !== null)
      .sort((a, b) => (b.qavScore ?? 0) - (a.qavScore ?? 0));
    const m = new Map<string, number>();
    sorted.forEach((r, i) => m.set(r.code, i + 1));
    return m;
  }, [rows]);

  const view = useMemo(() => {
    let v = rows;
    // "No data" rows are those the engine couldn't classify (insufficient price
    // history, <12 monthly bars, or a failed fetch) — they carry an error and a
    // null sentiment, so they need their own filter branch.
    if (sentimentFilter === "NoData") v = v.filter((r) => !!r.error || r.sentiment === null);
    else if (sentimentFilter !== "All") v = v.filter((r) => r.sentiment === sentimentFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      v = v.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }
    // Min liquidity: input is in $thousands of 3M average daily traded value.
    const minLiq = parseFloat(minLiquidity);
    if (!Number.isNaN(minLiq) && minLiq > 0) {
      v = v.filter((r) => r.avgDailyValue !== null && r.avgDailyValue >= minLiq * 1000);
    }
    if (qavListOnly) v = v.filter((r) => !!fundScores?.data[r.code]);
    if (kindFilter !== "All") v = v.filter((r) => LIC_CODES.has(r.code) === (kindFilter === "LIC"));
    const dir = sortDir === "asc" ? 1 : -1;
    const keyVal = (r: RankedEtf): number | string => {
      switch (sortKey) {
        case "code": return r.code;
        case "qual": return r.quality ?? -Infinity;
        case "yield": return r.yieldPct ?? -Infinity;
        case "mer": return r.mer ?? Infinity;
        case "net": return r.netYield ?? -Infinity;
        case "price": return r.price ?? -Infinity;
        case "r6m": return r.perf.r6m ?? -Infinity;
        case "r1y": return r.perf.r1y ?? -Infinity;
        case "r3y": return r.perf.r3y ?? -Infinity;
        case "r5y": return r.perf.r5y ?? -Infinity;
        case "liq": return r.avgDailyValue ?? -Infinity;
        case "rank":
        default: return rankByCode.get(r.code) ?? Infinity;
      }
    };
    return [...v].sort((a, b) => {
      const av = keyVal(a), bv = keyVal(b);
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [rows, sentimentFilter, search, minLiquidity, sortKey, sortDir, rankByCode, qavListOnly, fundScores, kindFilter]);

  const counts = useMemo(() => {
    const c = { Buy: 0, Watch: 0, Josephine: 0, Sell: 0, errored: 0 };
    for (const r of rows) {
      if (r.error) c.errored++;
      else if (r.sentiment) c[r.sentiment]++;
    }
    return c;
  }, [rows]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "code" || k === "rank" ? "asc" : "desc"); }
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <header className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
          ← QAV scorecard
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-gray-900">QAV ETF &amp; LIC Ranker</h1>
        <p className="mt-1 text-sm text-gray-600">
          {total} ASX funds — {total - LIC_CODES.size} ETFs and {LIC_CODES.size} listed investment
          companies — ranked by Tony Kynaston&rsquo;s 3-Point Trendline trend, then by net
          distribution yield (yield − management fee). Trend, yield and returns are live from Yahoo
          Finance; ETF fees are from marketindex.com.au. Most LICs have no fee on file, so their
          net yield is their gross yield.
        </p>
        <p className="mt-2 text-xs text-gray-500">
          The 3PTL reads <span className="font-semibold">total return</span> — distributions
          reinvested — not the raw price, because a fund that pays its return out has no rising
          price support to draw. A <span className="font-medium">px</span> chip next to a badge is
          the price-only reading where the two disagree, which is what the TradingView chart link
          will show.
        </p>
        <p className="mt-1 text-xs text-gray-500">
          <span className="font-semibold">Quality</span> is a separate pass rate over seven checks
          — 3PTL Buy, a drawable sell line, MER at or below the universe median, 1y and long-run
          total return beating {BENCHMARK}, {Math.round(CONSISTENCY_BAR * 100)}% of rolling 12-month
          windows positive, and a shallower 5-year drawdown than {BENCHMARK}. Hover a score to see
          each check. It is <em>not</em> part of the rank.
        </p>
        {extras.length > 0 && (
          <p className="mt-1 text-xs text-gray-500">
            {extras.length} fund{extras.length !== 1 ? "s" : ""} from your Stock Doctor list {extras.length !== 1 ? "are" : "is"} not
            in this page&rsquo;s bundled universe and {extras.length !== 1 ? "are" : "is"} added to the
            run: {extras.map((e) => e.code).join(", ")}.
          </p>
        )}
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          {running ? `Ranking… ${done}/${total}` : rows.length ? "Re-run ranking" : "Run ranking"}
        </button>
        {lastRun && !running && (
          <span className="text-xs text-gray-500">Last run: {lastRun}</span>
        )}
        {rows.length > 0 && notYetRun.length > 0 && !running && (
          <span className="text-xs text-amber-700">
            {notYetRun.length <= 8
              ? `${notYetRun.join(", ")} ${notYetRun.length !== 1 ? "are" : "is"}`
              : `${notYetRun.length} funds and LICs are`}{" "}
            not in this run — re-run to include {notYetRun.length !== 1 ? "them" : "it"}.
          </span>
        )}
        {running && (
          <div className="h-2 w-48 overflow-hidden rounded-full bg-gray-200">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 px-2 py-1 font-semibold text-emerald-800">
              Buy {counts.Buy}
            </span>
            <span className="rounded-full bg-sky-100 px-2 py-1 font-semibold text-sky-800">
              Watch {counts.Watch}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-800">
              Josephine {counts.Josephine}
            </span>
            <span className="rounded-full bg-red-100 px-2 py-1 font-semibold text-red-700">
              Sell {counts.Sell}
            </span>
            {counts.errored > 0 && (
              <span className="rounded-full bg-gray-100 px-2 py-1 font-semibold text-gray-500">
                No data {counts.errored}
              </span>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search code or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
            <select
              value={sentimentFilter}
              onChange={(e) => setSentimentFilter(e.target.value as Sentiment | "All" | "NoData")}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value="All">All sentiments</option>
              <option value="Buy">Buy only</option>
              <option value="Watch">Watch only</option>
              <option value="Josephine">Josephine only</option>
              <option value="Sell">Sell only</option>
              <option value="NoData">No data only</option>
            </select>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as "All" | "ETF" | "LIC")}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              title="Listed investment companies and trusts are ranked in the same table as the ETFs"
            >
              <option value="All">ETFs and LICs</option>
              <option value="ETF">ETFs only</option>
              <option value="LIC">LICs only</option>
            </select>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min="0"
                placeholder="min liquidity"
                value={minLiquidity}
                onChange={(e) => setMinLiquidity(e.target.value)}
                className="w-32 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                title="Minimum 3-month average daily traded value, in $thousands"
              />
              <span className="text-xs text-gray-500">$k/day</span>
            </div>
            {fundScores && (
              <label className="flex items-center gap-1.5 text-sm text-gray-700" title="Show only the funds that are in your Stock Doctor list">
                <input type="checkbox" checked={qavListOnly} onChange={(e) => setQavListOnly(e.target.checked)} />
                In QAV list only
              </label>
            )}
            <span className="text-xs text-gray-500">{view.length} shown</span>
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <Th onClick={() => toggleSort("rank")} active={sortKey === "rank"} dir={sortDir}>Rank</Th>
                  <Th onClick={() => toggleSort("code")} active={sortKey === "code"} dir={sortDir}>Code</Th>
                  <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-700">Name</th>
                  <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-700">3PTL</th>
                  <Th onClick={() => toggleSort("qual")} active={sortKey === "qual"} dir={sortDir} right>Quality</Th>
                  <Th onClick={() => toggleSort("price")} active={sortKey === "price"} dir={sortDir} right>Price</Th>
                  <Th onClick={() => toggleSort("yield")} active={sortKey === "yield"} dir={sortDir} right>Yield %</Th>
                  <Th onClick={() => toggleSort("mer")} active={sortKey === "mer"} dir={sortDir} right>MER %</Th>
                  <Th onClick={() => toggleSort("net")} active={sortKey === "net"} dir={sortDir} right>Net %</Th>
                  <Th onClick={() => toggleSort("r6m")} active={sortKey === "r6m"} dir={sortDir} right>6M %</Th>
                  <Th onClick={() => toggleSort("r1y")} active={sortKey === "r1y"} dir={sortDir} right>1Y %</Th>
                  <Th onClick={() => toggleSort("r3y")} active={sortKey === "r3y"} dir={sortDir} right>3Y %</Th>
                  <Th onClick={() => toggleSort("r5y")} active={sortKey === "r5y"} dir={sortDir} right>5Y %</Th>
                  <Th onClick={() => toggleSort("liq")} active={sortKey === "liq"} dir={sortDir} right>3M $/day</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {view.map((r) => (
                  <tr key={r.code} className="hover:bg-gray-50" title={r.note}>
                    <td className="px-3 py-2 text-gray-500">{rankByCode.get(r.code) ?? "—"}</td>
                    <td className="px-3 py-2 font-semibold">
                      <a
                        href={yahooUrl(r.code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:underline"
                        title={`${r.code} on Yahoo Finance`}
                      >
                        {r.code}
                      </a>
                    </td>
                    <td className="max-w-md truncate px-3 py-2 text-gray-600">
                      {r.name}
                      {LIC_CODES.has(r.code) && (
                        <span
                          className="ml-2 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                          title={r.mer == null
                            ? "A listed investment company or trust. No fee is on file, so its net yield is its gross yield and the fee check is not assessed."
                            : "A listed investment company or trust."}
                        >
                          LIC
                        </span>
                      )}
                      {r.fromQavList && (
                        <span
                          className="ml-2 rounded-full border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-700"
                          title="Not in this page's bundled ETF universe — added because your Stock Doctor list has it. No fee is on file, so its net yield is its gross yield and the fee check is not assessed."
                        >
                          from QAV list
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${sentimentBadge(r.sentiment)}`}>
                        {r.error ? "No data" : r.sentiment ?? "—"}
                      </span>
                      {/* The raw-price reading, shown only where it disagrees.
                          The badge is the total-return 3PTL and is what ranks;
                          this is what a plain TradingView price chart shows, so
                          it explains a verdict that won't match the chart link. */}
                      {r.priceSentiment && (
                        <span
                          className="ml-1 rounded-full border border-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                          title={`Price-only 3PTL reads ${r.priceSentiment}. The badge is the total-return reading, which includes distributions and is what the rank uses.`}
                        >
                          px {r.priceSentiment}
                        </span>
                      )}
                      <a
                        href={tradingViewUrl(r.code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-xs text-gray-400 hover:text-indigo-600 hover:underline"
                        title={`Check ${r.code}'s 3PTL on the TradingView monthly chart`}
                      >
                        chart ↗
                      </a>
                    </td>
                    {/* Quality: the pass RATE as a percentage (it was shown as a
                        0–1 fraction until 2026-11-15), with the pass count
                        beside it and every check spelled out on
                        hover so a score is never a number you have to trust.
                        A check that can't be assessed (a fund under 3 years old,
                        a missing fee) is excluded from the denominator, which is
                        why the shown total varies between rows. */}
                    <td
                      className="whitespace-nowrap px-3 py-2 text-right tabular-nums"
                      title={
                        r.qualityChecks.length
                          ? r.qualityChecks
                              .map((c) => `${c.pass === null ? "–" : c.pass ? "✓" : "✗"} ${c.label} (${c.detail})`)
                              .join("\n")
                          : "no reading"
                      }
                    >
                      {r.quality === null ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <>
                          <span className={`font-semibold ${qualityColor(r.quality)}`}>
                            {Math.round(r.quality * 100)}%
                          </span>
                          <span className="ml-1 text-xs text-gray-400">
                            {r.qualityChecks.filter((c) => c.pass).length}/
                            {r.qualityChecks.filter((c) => c.pass !== null).length}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(r.price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmt(r.yieldPct, 1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmt(r.mer, 2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">{fmt(r.netYield, 2)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${perfColor(r.perf.r6m)}`}>{fmtPct(r.perf.r6m)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${perfColor(r.perf.r1y)}`}>{fmtPct(r.perf.r1y)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${perfColor(r.perf.r3y)}`}>{fmtPct(r.perf.r3y)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${perfColor(r.perf.r5y)}`}>{fmtPct(r.perf.r5y)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{fmtMoney(r.avgDailyValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rows.length === 0 && !running && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-gray-500">
          Click <span className="font-semibold">Run ranking</span> to score all {total} ASX ETFs.
          This pulls 6 years of monthly price history per ETF from Yahoo Finance and takes a minute or two.
        </div>
      )}
    </main>
  );
}

function Th({
  children, onClick, active, dir, right,
}: {
  children: ReactNode;
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
  right?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className={`sticky top-0 z-10 cursor-pointer select-none bg-gray-50 px-3 py-2 font-semibold text-gray-700 hover:text-indigo-600 ${right ? "text-right" : "text-left"}`}
    >
      {children}
      {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}
