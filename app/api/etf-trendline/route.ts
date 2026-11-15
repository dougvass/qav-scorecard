/**
 * 3PTL for the ASX-ETF ranker — running the SAME engine as the scorecard.
 *
 *   POST /api/etf-trendline { codes: string[] }   — batch ≤25
 *   GET  /api/etf-trendline?code=VAS              — debug single ticker
 *
 * MOVED HERE 2026-11-14. This was `/api/trendline` in the separate ETF ranker
 * site (qav-etf-ranker.vercel.app); Doug asked for the ranker to become a page
 * of this one. Everything below that speaks of "the fork", of copying
 * `lib/trendline-v3.ts` across and of keeping the two in step is HISTORY: the
 * route now imports the scorecard's own engine, so there is one copy and
 * nothing to re-sync. The data layer described below is unchanged.
 *
 * ENGINE, 2026-11-07. This route used to carry its own 1,289-line copy of
 * production's v1 classifier. Production has since moved to v3 — the sequential
 * walk built from Doug's own chart readings — and the fork was left behind, so
 * the ranker was reading ETFs by rules the scorecard had retired: highs/lows
 * rather than closes, the old "rightmost peak within 8% of the max" flat-top
 * band rather than the peak-by-peak step, nine-month pivot confirmation, a 3.5%
 * pierce tolerance, and no causal walk at all.
 *
 * Doug, 2026-11-07: "make sure the same 3pTL engine is running on the ETF
 * ranker."
 *
 * So the classifier is now `lib/trendline-v3.ts`, copied verbatim from
 * `web/lib/trendline-v3.ts` — one engine, two front ends. Re-sync by re-copying
 * that file and `lib/exchange-months.ts`; neither has a fork-specific edit, and
 * nothing in this route reaches into the engine's internals.
 *
 * What stays fork-specific is the DATA layer, which production has no use for:
 *
 *   1. trailing-12-month distributions per unit (`divTTM`), for the ranker's
 *      distribution yield — read from the same chart fetch as the price bars;
 *   2. total-return performance over 6m/1y/3y/5y, from the dividend-ADJUSTED
 *      closes, which is the basis Market Index quotes;
 *   3. three-month average daily traded value, for the liquidity filter.
 *
 * The commodity machinery production carries is still absent: an ETF is never a
 * commodity, so there is no gate to apply.
 *
 * ── BASIS: the 3PTL runs on TOTAL RETURN, not raw price ─────────────────────
 *
 * Doug, 2026-11-07: "Rank income funds on total return instead of raw price."
 *
 * It applies to every fund here, not a classified subset, because the subset
 * cannot be drawn reliably — see `BASIS` below for the measurement. Production
 * (stocks) still uses raw closes and should: there, Doug reads his anchors off
 * a TradingView price chart, and an adjusted series would not match it. A fund
 * is different. You cannot decline a distribution, so total return IS the
 * holder's return, and this app already quotes its performance columns that way.
 */
import { classifyV3, V3Bar } from "@/lib/trendline-v3";
import { monthOf, monthOrdinal, currentMonth } from "@/lib/exchange-months";
import { totalReturn, type AdjPoint } from "@/lib/total-return";

export const runtime = "edge";

// ── Data types ─────────────────────────────────────────────────────────────────

/**
 * v3's four sentiments. WATCH is the one v1 could not express — a fund sitting
 * between its buy and sell lines, which Doug describes as "not a sell nor a
 * buy". The ranker scores it 0, same as Josephine, but shows it separately
 * because the two mean different things: Watch is between the lines, Josephine
 * is above both but below last month's close.
 */
type Sentiment = "Buy" | "Watch" | "Josephine" | "Sell";

/**
 * Which price series the 3PTL reads. "totalReturn" is the shipped default;
 * "price" restores the old raw-close behaviour in one edit.
 *
 * WHY TOTAL RETURN, and why for ALL funds rather than only income funds.
 * Measured 2026-11-07 across 385 ASX ETFs, running this same engine over both
 * series with the live price and last month's close taken from daily data and
 * mapped onto the adjusted scale, exactly as the code below does. (The engine
 * was validated against production first: 70/70 exact matches on line values
 * AND anchor dates on the raw series.)
 *
 *   raw price basis : Sell 189, Buy  94, Josephine  93, Watch 9
 *   total return    : Sell  92, Buy 158, Josephine 131, Watch 4
 *   no sell line drawable at all: 91 on raw price, 35 on total return
 *
 * 189 of 385 — 49% of the ASX ETF universe — reading Sell is not a description
 * of the market, it is an artefact of stripping distributions out of the price.
 *
 * THE DECISIVE RESULT: 103 verdicts move and **every one of them moves away
 * from Sell** — Sell->Buy 59, Sell->Josephine 37, Sell->Watch 1, Watch->Buy 5,
 * Watch->Josephine 1. Not one fund in 385 reads more bearishly on total return
 * than on price. So this is not a trade of some stocks for others; it only
 * removes false Sells, which is why it was worth widening past income funds.
 *
 * Narrowed to the 68 funds whose NAME marks them as fixed income (bond, credit,
 * cash, hybrid, floating rate, treasury, money market, inflation-linked):
 *
 *   raw price basis : 64 Sell of 68, and 53 of 68 with NO sell line drawable
 *   total return    : 35 Buy, 27 Sell, and only 18 with no line
 *
 * A bond or cash fund's price cannot rise 8% off its low, so no rising support
 * can ever be drawn and v3 correctly reports "falling knife" on a series that
 * simply does not carry the return. That 27 of them still read Sell on total
 * return is the check that this is not a whitewash: a long-duration bond fund
 * in a genuine downtrend still reads Sell with its coupons counted.
 *
 * The obvious implementation — switch only income funds — was tried and
 * rejected. "Income fund" has no reliable test. The two best candidates agree
 * on only 38 of ~90 funds and fail in OPPOSITE directions:
 *   * by NAME: misses the income-MANDATE funds (JEPI, JHPI, YMAX, UYLD, MQYM,
 *     IYLD, HVST, VAP, MVA, SLF, DJRE, R3AL, DIFF, EBND) whose instrument is
 *     equity or property but whose whole design is to pay the return out.
 *   * by RETURN (price return <= 0 while total return > 0): wrongly catches
 *     ordinary equity funds whose price merely went nowhere (VSO, SSO, MVS,
 *     Claremont Global, Montgomery, Munro, Loomis Sayles), and splits the cash
 *     funds arbitrarily — AAA sits at +0.4% price return and FLOT at 0.0%, the
 *     same kind of fund either side of the boundary.
 * Adding the strategy words that would catch the first group ("yield",
 * "income") sweeps up VHY, an ordinary equity fund up 35% on price. So any
 * shipped classifier is a permanent source of wrong calls, and one rule for
 * every fund is both simpler and better founded.
 *
 * And the measurement says the subset would have missed most of the problem
 * anyway: 66 of the 317 funds OUTSIDE the fixed-income names move, 49 of them
 * from a position that already had a drawable sell line (so not a no-line
 * artefact). They are the listed-property and option-income funds that pay
 * their return out without being bond funds — SLF, MVA, DJRE, REIT, RCAP,
 * YMAX, QMAX, JPEQ, ZYUS — plus the high-yielding Australian equity funds
 * (VSO, MVS, OZR, OZXX) and the Vanguard diversified series (VDCO, VDBA, VDGR,
 * VDAL). Same cause, no name to catch it by.
 *
 * KNOWN COST, stated plainly: the anchors and the two line values now sit on
 * the ADJUSTED scale, so they will not match the raw TradingView monthly chart
 * the table links to — an older anchor reads LOWER than the chart shows, by the
 * distributions paid since. The verdicts of the big index funds are unaffected
 * (VAS, A200, IOZ, VHY all read Buy on either basis), but where the two bases
 * do disagree the response carries `priceSentiment` so the price reading stays
 * visible rather than being silently replaced.
 */
const BASIS: "totalReturn" | "price" = "totalReturn";

// Trailing TOTAL return (%) per horizon — distributions reinvested, from Yahoo's
// dividend-ADJUSTED monthly closes. This is the basis Market Index and most ETF
// tables quote; it intentionally differs from the raw-close 3PTL chart.
interface Perf { r6m: number | null; r1y: number | null; r3y: number | null; r5y: number | null }
const NULL_PERF: Perf = { r6m: null, r1y: null, r3y: null, r5y: null };

/**
 * The two shape-of-the-ride numbers the ETF Quality checks need, both read off
 * the TOTAL-RETURN monthly series — a fund's distributions are part of how
 * smooth the ride was, so excluding them would overstate every drawdown.
 *
 *   posFrac — the fraction of rolling 12-month windows that finished positive,
 *             over the fund's whole history here. A fund that has never had a
 *             losing year reads 1.0. This is deliberately not "annualised
 *             volatility": Doug's question about a fund is "would I have been
 *             down if I'd held it a year", and a high-vol fund that always
 *             recovered inside twelve months answers that better than its
 *             standard deviation does.
 *   maxDD   — the worst peak-to-trough fall on monthly closes over the last
 *             five years, as a negative percent. Monthly closes understate an
 *             intra-month low, which is fine: it is compared against another
 *             fund measured exactly the same way.
 */
interface Risk { posFrac: number | null; maxDD: number | null }
const NULL_RISK: Risk = { posFrac: null, maxDD: null };

// ── Yahoo Finance ──────────────────────────────────────────────────────────────

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

/** Resolve a request code to a Yahoo symbol. Every ETF code is a bare ASX
 *  ticker and gets the .AX suffix; a symbol-like code — one already carrying
 *  =, ^ or . — passes through unchanged. */
function yahooSymbol(code: string): string {
  return /[=^.]/.test(code) ? code : `${code}.AX`;
}

/**
 * Six years of monthly bars, raw closes, plus the two adjusted-series extras.
 *
 * Six and not five: v3's own `window5y` trims to five years from the last
 * complete month, and `pivots` needs a bar either side to call a peak or a
 * trough, so the extra year gives the oldest in-window bars room to be
 * confirmed rather than silently losing a genuine anchor at the edge.
 *
 * Month labels follow TradingView — the month the trading happened in — via
 * `monthOf` and the payload's own `meta.gmtoffset`. Yahoo stamps an ASX monthly
 * bar at local midnight on the 1st, which is the month BEFORE in UTC, so
 * reading the label off UTC (as this route did) labelled every bar a month
 * early. No arithmetic depended on it, but every date the ranker displayed was
 * out by one against Doug's charts.
 */
async function fetchMonthly(code: string): Promise<{
  bars: V3Bar[]; trBars: V3Bar[]; divTTM: number; perf: Perf; risk: Risk;
}> {
  const EMPTY = { bars: [], trBars: [], divTTM: 0, perf: NULL_PERF, risk: NULL_RISK };
  const end = Math.floor(Date.now() / 1000);
  const start = end - 6 * 365 * 24 * 3600;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(code))}?interval=1mo&period1=${start}&period2=${end}&includePrePost=false&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return EMPTY;
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return EMPTY;
    const ts   = result.timestamp as number[];
    const off  = ((result.meta as Record<string, unknown>)?.gmtoffset as number) ?? 0;
    const q    = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    const adjQ = ((result.indicators as Record<string, unknown>)?.adjclose as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    if (!ts || !q) return EMPTY;

    // Trailing-12-month distributions per unit — summed from the chart API's own
    // dividend events (we already request events=div), so the ETF distribution
    // yield comes from the SAME fetch as the price bars (no extra Yahoo request).
    // ETFs distribute frequently (often quarterly/monthly); summing the last
    // 365 days of per-unit cash gives a trailing distribution rate that, divided
    // by the current price downstream, yields the trailing distribution yield.
    const divCutoff = end - 365 * 24 * 3600;
    let divTTM = 0;
    const divEvents = ((result.events as Record<string, unknown>)?.dividends) as Record<string, { amount?: number; date?: number }> | undefined;
    if (divEvents) {
      for (const k of Object.keys(divEvents)) {
        const ev = divEvents[k];
        const when = ev?.date ?? Number(k);
        if (when >= divCutoff && typeof ev?.amount === "number") divTTM += ev.amount;
      }
    }

    // RAW closes for the 3PTL. v3 is a close-only engine, so the high/low pair
    // the old classifier used is no longer read at all.
    const raw: V3Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i] ?? adjQ?.adjclose?.[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      raw.push({ date: monthOf(ts[i], off), close: c });
    }
    // Yahoo can repeat the current month (a month-to-date bar plus a trailing
    // latest-days stub); keep the last close per calendar month, exactly as the
    // production v3 route does.
    const byMonth = new Map<string, V3Bar>();
    for (const b of raw) byMonth.set(b.date, b);
    const bars = Array.from(byMonth.values()).sort((a, b) => a.date.localeCompare(b.date));

    // TOTAL-RETURN series — the dividend-ADJUSTED monthly close, i.e. the same
    // fund with every distribution reinvested. It feeds two things now:
    //
    //   * `perf`, the 6m/1y/3y/5y columns, as it always did — tagged with its
    //     calendar month on the exchange's clock so a horizon offset counts the
    //     months Doug would;
    //   * `trBars`, the series the 3PTL itself reads under BASIS = "totalReturn".
    //
    // Falls back to the raw close where adjclose is absent (a fund that has
    // never distributed), which makes trBars identical to bars for those.
    const adjSeries: AdjPoint[] = [];
    const rawAdj: V3Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const a = adjQ?.adjclose?.[i] ?? q.close?.[i];
      if (a == null || isNaN(a) || a <= 0) continue;
      adjSeries.push({ m: monthOrdinal(ts[i], off), adj: a });
      rawAdj.push({ date: monthOf(ts[i], off), close: a });
    }
    // Same duplicate-month collapse as the raw series, and for the same reason.
    const adjByMonth = new Map<string, V3Bar>();
    for (const b of rawAdj) adjByMonth.set(b.date, b);
    const trBars = Array.from(adjByMonth.values()).sort((a, b) => a.date.localeCompare(b.date));

    const perf: Perf = {
      r6m: totalReturn(adjSeries, 6),
      r1y: totalReturn(adjSeries, 12),
      r3y: totalReturn(adjSeries, 36),
      r5y: totalReturn(adjSeries, 60),
    };

    return { bars, trBars, divTTM, perf, risk: riskOf(trBars) };
  } catch { return EMPTY; }
}

/**
 * ONE daily fetch serving the current price, the previous month's close, and
 * the liquidity figure.
 *
 * The previous month's close has to come from DAILY data: Yahoo's interval=1mo
 * endpoint backfills the live price into BOTH trailing monthly bars once a new
 * month has only a few sessions, so the second-to-last monthly bar is not
 * reliably last month's close. v3's Josephine test compares the live price
 * against it, so getting it wrong suppresses the signal entirely.
 *
 * `prevMonthClose` is the last close of the month BEFORE the latest price's
 * month, not before today's month: at the very start of a new month, before it
 * has traded, the live price IS the just-completed month's close, and anchoring
 * on today's month would compare that month against itself.
 */
async function fetchDaily(code: string): Promise<{
  price: number | null; prevMonthClose: number | null; prevMonth: string | null;
  avgDailyValue: number | null;
}> {
  const empty = { price: null, prevMonthClose: null, prevMonth: null, avgDailyValue: null };
  // 3mo window: a superset of the 2mo needed for prevMonthClose, and ~63
  // trading days for the 3-month average daily traded value.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(code))}?interval=1d&range=3mo&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return empty;
    const json = await res.json() as Record<string, unknown>;
    const result = ((json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[])?.[0];
    if (!result) return empty;
    const ts = result.timestamp as number[];
    const off = ((result.meta as Record<string, unknown>)?.gmtoffset as number) ?? 0;
    const quote = ((result.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[])?.[0] as Record<string, number[]> | undefined;
    const closes = quote?.close;
    const volumes = quote?.volume;
    if (!ts || !closes) return empty;

    // First pass: latest valid close, the month it falls in, and the 3M average
    // traded value. The month comes off the exchange calendar — the first
    // session of a month is 00:00 Sydney, which is still the month before in
    // UTC, so a UTC test took it for last month's close.
    let price: number | null = null;
    let priceYM = -1;
    let valueSum = 0, valueDays = 0;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      price = c;
      priceYM = monthOrdinal(ts[i], off);
      const v = volumes?.[i];
      if (v != null && !isNaN(v) && v > 0) { valueSum += c * v; valueDays += 1; }
    }
    // Second pass: the last close of a month strictly before the price's month.
    // Its month LABEL comes back too, so the total-return basis can look up the
    // dividend adjustment factor that applies at that same month rather than
    // assuming the one at the right edge (see `onAdjustedScale`).
    let prevMonthClose: number | null = null;
    let prevMonth: string | null = null;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || c <= 0) continue;
      if (monthOrdinal(ts[i], off) < priceYM) { prevMonthClose = c; prevMonth = monthOf(ts[i], off); }
    }
    const avgDailyValue = valueDays > 0 ? Math.round(valueSum / valueDays) : null;
    return { price, prevMonthClose, prevMonth, avgDailyValue };
  } catch { return empty; }
}

/** `posFrac` and `maxDD` from a total-return monthly series. See `Risk`. */
function riskOf(bars: V3Bar[]): Risk {
  if (bars.length < 13) return NULL_RISK;
  // Worst peak-to-trough fall over the last 5 years (61 monthly closes covers
  // five full years plus the month in progress).
  const w = bars.slice(-61);
  let peak = -Infinity, dd = 0;
  for (const b of w) {
    if (b.close > peak) peak = b.close;
    const d = (b.close / peak - 1) * 100;
    if (d < dd) dd = d;
  }
  // Rolling 12-month windows that finished positive, over the whole series.
  let total = 0, positive = 0;
  for (let i = 12; i < bars.length; i++) {
    if (bars[i - 12].close <= 0) continue;
    total += 1;
    if (bars[i].close > bars[i - 12].close) positive += 1;
  }
  return {
    posFrac: total > 0 ? Math.round((positive / total) * 1000) / 1000 : null,
    maxDD: Math.round(dd * 10) / 10,
  };
}

/**
 * Put the live price and last month's close onto the ADJUSTED scale, so the
 * total-return 3PTL compares like with like.
 *
 * Both of those numbers come from the DAILY fetch, which is raw. The adjusted
 * monthly series is anchored at its right edge — Yahoo's adjclose discounts a
 * bar only for distributions that went ex AFTER it, so the newest bar's
 * adjclose equals its close and older bars sit progressively lower. Feeding a
 * raw price into the adjusted series would therefore be nearly right at the
 * right edge and quietly wrong for a fund that has just gone ex.
 *
 * The conversion is the ratio `adjclose / close` observed at the SAME month,
 * which is that month's cumulative adjustment factor. Taking it per month
 * rather than once at the right edge also survives a distribution falling
 * between last month's close and today, and it is immune to Yahoo backfilling
 * the live price into a trailing monthly bar: both series are backfilled with
 * the same price times the same factor, so their ratio is unchanged.
 *
 * Measured over all 387 codes on 2026-11-07, which is why it is written this
 * way and not shorter:
 *   * the two series line up month for month for 387 of 387, so the null
 *     fallback below is a guard, not a routine path;
 *   * the factor at the newest bar is EXACTLY 1.0 for 387 of 387 — confirming
 *     the right-edge anchoring, and making the price scaling a no-op in
 *     practice. It stays because it is the correct conversion, not because it
 *     currently changes a number;
 *   * the factor at LAST MONTH differs from 1.0 for 46 of 387 — the funds that
 *     went ex-distribution since. For those the per-month lookup is the whole
 *     point: a single right-edge factor would compare an adjusted price against
 *     an unadjusted previous close and misread the Josephine test.
 *
 * Returns null when the two series do not line up month for month — better to
 * fall back to the price basis and say so than to scale by a guess.
 */
function onAdjustedScale(
  bars: V3Bar[], trBars: V3Bar[], price: number, lmc: number | null, lmcMonth: string | null,
): { price: number; lmc: number | null } | null {
  if (!trBars.length || trBars.length !== bars.length) return null;
  const factor = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date !== trBars[i].date) return null;
    if (bars[i].close > 0) factor.set(bars[i].date, trBars[i].close / bars[i].close);
  }
  const fLast = factor.get(bars[bars.length - 1].date);
  if (!fLast || !isFinite(fLast) || fLast <= 0) return null;
  const fLmc = (lmcMonth && factor.get(lmcMonth)) || fLast;
  return {
    price: price * fLast,
    lmc: lmc == null ? null : lmc * fLmc,
  };
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

/**
 * v3's result, in the field names the ranker page already reads. `buyLine` and
 * `sellLine` are the lines extrapolated to today, the same two numbers v1
 * returned under those names, so the table needed no change on that account.
 *
 * `basis` says which series produced this reading, so the page never has to
 * infer it: "totalReturn" normally, "price" for a fund whose adjusted series
 * could not be lined up with the raw one. The anchors and the two line values
 * are then on the ADJUSTED scale and will not match a raw TradingView chart —
 * which is the whole point, and why `priceSentiment` travels alongside.
 */
function shape(r: ReturnType<typeof classifyV3>, basis: "totalReturn" | "price") {
  return {
    sentiment: r.sentiment as Sentiment,
    basis,
    note: r.note,
    buyLine: r.buy,
    sellLine: r.sell,
    h1: r.h1, h2: r.h2, l1: r.l1, l2: r.l2,
  };
}

/**
 * Both readings of one fund: the shipped one under `BASIS`, plus the raw-price
 * sentiment for reference.
 *
 * The raw pass is cheap — same bars already in hand, no extra fetch — and it
 * keeps the price-basis verdict visible instead of replaced. `priceSentiment`
 * is null only when the two bases are the same series anyway (BASIS = "price",
 * or a fund that has never distributed, where adjclose IS close).
 */
function classifyBothBases(
  bars: V3Bar[], trBars: V3Bar[], price: number,
  lmc: number | null, lmcMonth: string | null,
) {
  const priceRes = classifyV3(bars, price, lmc);
  if (BASIS !== "totalReturn") {
    return { result: priceRes, basis: "price" as const, priceSentiment: null };
  }
  const scaled = onAdjustedScale(bars, trBars, price, lmc, lmcMonth);
  if (!scaled || trBars.length < 12) {
    // Adjusted series unusable — fall back to price rather than refuse a
    // reading, and let `basis` in the response say so.
    return { result: priceRes, basis: "price" as const, priceSentiment: null };
  }
  const trRes = classifyV3(trBars, scaled.price, scaled.lmc);
  return {
    result: trRes,
    basis: "totalReturn" as const,
    priceSentiment: trRes.sentiment === priceRes.sentiment
      ? null                                  // nothing to report
      : (priceRes.sentiment as Sentiment),
  };
}

async function processCode(code: string) {
  const [monthly, daily] = await Promise.all([fetchMonthly(code), fetchDaily(code)]);
  const { bars, trBars, divTTM, perf, risk } = monthly;
  if (bars.length < 12) {
    return { sentiment: null, error: "insufficient data", months: bars.length,
             avgDailyValue: daily.avgDailyValue };
  }
  const price = daily.price ?? bars[bars.length - 1].close;
  const { result, basis, priceSentiment } =
    classifyBothBases(bars, trBars, price, daily.prevMonthClose, daily.prevMonth);
  // Trailing distribution yield (%) = TTM distributions per unit / current price.
  // Raw price on purpose: that is what a unit actually costs today.
  const yieldPct = price > 0 ? Math.round((divTTM / price) * 1000) / 10 : null;
  return { ...shape(result, basis), priceSentiment, price, yieldPct, perf, risk,
           avgDailyValue: daily.avgDailyValue, months: bars.length };
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { codes } = (await request.json()) as { codes?: string[] };
  const batch = (codes ?? []).slice(0, 25);
  if (!batch.length) return Response.json({ error: "codes required" }, { status: 400 });
  // Not batch.map(processCode): map passes the index as a second argument.
  const results = await Promise.all(batch.map((c) => processCode(c)));
  const out: Record<string, object> = {};
  batch.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}

// ── GET — debug ────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "VAS").toUpperCase();

  const [monthly, daily] = await Promise.all([fetchMonthly(code), fetchDaily(code)]);
  const { bars, trBars, divTTM, perf, risk } = monthly;
  const base = {
    code, runtime: "edge", engine: "v3", configured_basis: BASIS,
    monthly_bars: bars.length,
    current_price: daily.price, last_month_close: daily.prevMonthClose,
    current_month: currentMonth(), avg_daily_value: daily.avgDailyValue,
  };
  if (bars.length < 12) return Response.json({ ...base, error: "insufficient data" });

  const price = daily.price ?? bars[bars.length - 1].close;
  const { result: r, basis, priceSentiment } =
    classifyBothBases(bars, trBars, price, daily.prevMonthClose, daily.prevMonth);
  const yieldPct = price > 0 ? Math.round((divTTM / price) * 1000) / 10 : null;
  const detail = (p: { date: string; close: number } | null) =>
    p ? `${p.date} @ ${p.close.toFixed(3)}` : null;

  // The series the reading above was actually taken from, so every anchor,
  // line value and bar dump below is on one consistent scale.
  const series = basis === "totalReturn" ? trBars : bars;
  const scaled = onAdjustedScale(bars, trBars, price, daily.prevMonthClose, daily.prevMonth);

  return Response.json({
    ...base,
    ...shape(r, basis),
    priceSentiment,
    // What the engine was fed, on the basis it ran: for total return these are
    // the raw daily numbers mapped onto the adjusted scale.
    classified_price: basis === "totalReturn" && scaled ? scaled.price : price,
    classified_last_month_close: basis === "totalReturn" && scaled ? scaled.lmc : daily.prevMonthClose,
    div_ttm: divTTM,
    yield_pct: yieldPct,
    perf,
    risk,
    oldest: series[0]?.date,
    newest: series[series.length - 1]?.date,
    // &bars=1 — dump the full monthly series (lets local tooling reuse the
    // server-side Yahoo fetch when Yahoo rate-limits direct client requests).
    // Both series, since the two bases disagree and the difference is the point.
    ...(searchParams.get("bars") ? { all_bars: series, price_bars: bars, tr_bars: trBars } : {}),
    last_4: series.slice(-4),
    h1_detail: detail(r.h1), h2_detail: detail(r.h2),
    l1_detail: detail(r.l1), l2_detail: detail(r.l2),
    // The walk's own buy/sell events. Useful for reading a verdict back, not a
    // tradeable history — see the causality caveat in lib/trendline-v3.ts.
    events: r.events,
  });
}
