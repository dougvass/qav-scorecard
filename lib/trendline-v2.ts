/**
 * 3PTL engine v2 — a faithful port of QAV HQ's own algorithm.
 *
 * NOT WIRED INTO THE LIVE BUY LIST. The production scorecard still calls
 * /api/trendline (v1). This exists so v2 can be evaluated against HQ's
 * published output and against real charts before anything switches over.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * Read directly out of the formulas in "Brettalator v23.04.26.xlsx", sheet
 * "Monthly 5 Year" — HQ's own tool — rather than inferred from outcomes:
 *
 *   price    GD = VLOOKUP(EOMONTH+0.9999, DailyCloseDB, 2, TRUE)   monthly CLOSE
 *   peak     FZ = AND(ISNUMBER(GD1), GD2>=GD1, ISNUMBER(GD3), GD2>=GD3)
 *   trough   FY = AND(ISNUMBER(GD1), GD2<=GD1, ISNUMBER(GD3), GD2<=GD3)
 *   H1     GP3  = MAXIFS(Price, HorizontalPeak,   TRUE, Month, "<-2")
 *   L1     GP19 = MINIFS(Price, HorizontalTrough, TRUE, Month, "<-2")
 *   H2     GP8  = MAXIFS(angle, valid, TRUE, angle, "<0", Month, ">"&H1Month)
 *   L2     GP23 = MINIFS(angle, valid, TRUE, angle, ">0", Month, "<0", Month, ">"&L1Month)
 *   angle       = ATAN2(month - anchorMonth, price - anchorPrice)
 *   FlatTopFudgeFactor = FlatBottomFudgeFactor = 0.08
 *
 * Four things differ from v1, and together they account for essentially all of
 * the sentiment gap with HQ:
 *   1. monthly CLOSES, not highs/lows
 *   2. pivot window ±1 bar, not ±2
 *   3. confirmation "month < -2" (≥3 months old), not 9 months
 *   4. H2/L2 is the SHALLOWEST valid slope, not the most recent pivot
 *
 * Measured on 119 stocks against HQ's own 330-stock table (2026-09-06):
 *   v1  verdict 60%, sell price within 10% 38%, median error 18.2%
 *   v2  verdict 84%, sell price within 10% 74%, median error  3.6%
 *
 * ── Two traps, both cost real time ───────────────────────────────────────────
 *   * Excel ATAN2(x, y) takes x FIRST; Math.atan2(y, x) takes y first. Getting
 *     this backwards inverts candidate selection (scored 31%, 102% median err).
 *   * Month 0 is the CURRENT, partial month, so the LAST bar is 0, not -1.
 */

export interface V2Bar { date: string; close: number }

/** (month, price) with month <= 0; 0 = current (partial) month. */
export type Pivot2 = { m: number; p: number };

export interface V2Line {
  gradient: number;
  offset: number;      // price at month 0
  a: Pivot2;           // H1 / L1
  b: Pivot2;           // H2 / L2
}

export interface V2Result {
  sentiment: "Bullish" | "Josephine" | "Bearish";
  buy: number | null;
  sell: number | null;
  buyLine: V2Line | null;
  sellLine: V2Line | null;
  note: string;
}

export const FLAT_FUDGE = 0.08;
/** Sheet tests Month < -2, i.e. a pivot must be at least 3 months old. */
export const CONFIRM_MONTHS = 2;

export function toSeries(bars: V2Bar[]): Pivot2[] {
  const n = bars.length;
  return bars.map((b, i) => ({ m: i - (n - 1), p: b.close }));
}

export function peaks(s: Pivot2[]): Pivot2[] {
  return s.filter((x, i) => i > 0 && i < s.length - 1 && x.p >= s[i - 1].p && x.p >= s[i + 1].p);
}

export function troughs(s: Pivot2[]): Pivot2[] {
  return s.filter((x, i) => i > 0 && i < s.length - 1 && x.p <= s[i - 1].p && x.p <= s[i + 1].p);
}

function through(a: Pivot2, b: Pivot2): V2Line | null {
  if (b.m === a.m) return null;
  const gradient = (b.p - a.p) / (b.m - a.m);
  return { gradient, offset: a.p - gradient * a.m, a, b };
}

/**
 * How far through the current month we are, as a fraction.
 *
 * From HQ's manual calculator ("3PTL with target buy and sell dates (Fischer)"):
 *   Extend for = monthsBetween(target, anchor) - 1 + DAY(target)/daysInMonth
 *   "This is used to cater for how far through the current month it is"
 * So the live line value is the line evaluated at month (-1 + dayFraction),
 * not at a flat month 0 — the line has not finished this month's travel yet.
 */
export function monthFraction(now = new Date()): number {
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / days;
}

export function valueNow(line: V2Line, frac = monthFraction()): number {
  return line.gradient * (-1 + frac) + line.offset;
}

/** H1 = highest confirmed peak (or the flat-top anchor); H2 = shallowest fall. */
export function buyLine(s: Pivot2[], anchor?: Pivot2 | null): V2Line | null {
  const pk = peaks(s);
  const confirmed = pk.filter(x => x.m < -CONFIRM_MONTHS);
  if (!confirmed.length) return null;
  const h1 = anchor ?? confirmed.reduce((best, x) => (x.p > best.p ? x : best));
  let best: { ang: number; pv: Pivot2 } | null = null;
  for (const x of pk) {
    if (x.m <= h1.m || x.p >= h1.p) continue;          // must be later AND lower
    const ang = Math.atan2(x.p - h1.p, x.m - h1.m);    // Excel ATAN2(x,y)
    if (!best || ang > best.ang) best = { ang, pv: x }; // MAXIFS over negatives
  }
  return best ? through(h1, best.pv) : null;
}

/** L1 = lowest confirmed trough (or the flat-bottom anchor); L2 = shallowest rise. */
export function sellLine(s: Pivot2[], anchor?: Pivot2 | null): V2Line | null {
  const tr = troughs(s);
  const confirmed = tr.filter(x => x.m < -CONFIRM_MONTHS);
  if (!confirmed.length) return null;
  const l1 = anchor ?? confirmed.reduce((best, x) => (x.p < best.p ? x : best));
  let best: { ang: number; pv: Pivot2 } | null = null;
  for (const x of tr) {
    if (x.m <= l1.m || x.m >= 0 || x.p <= l1.p) continue; // later, past, AND higher
    const ang = Math.atan2(x.p - l1.p, x.m - l1.m);
    if (!best || ang < best.ang) best = { ang, pv: x };    // MINIFS over positives
  }
  return best ? through(l1, best.pv) : null;
}

/** Most recent confirmed peak within FlatTopFudgeFactor of the max (sheet GG/GS30). */
export function flatTopAnchor(s: Pivot2[]): Pivot2 | null {
  const c = peaks(s).filter(x => x.m < -CONFIRM_MONTHS);
  if (!c.length) return null;
  const mx = Math.max(...c.map(x => x.p));
  const band = c.filter(x => x.p >= mx * (1 - FLAT_FUDGE));
  return band.length ? band.reduce((b, x) => (x.m > b.m ? x : b)) : null;
}

export function flatBottomAnchor(s: Pivot2[]): Pivot2 | null {
  const c = troughs(s).filter(x => x.m < -CONFIRM_MONTHS);
  if (!c.length) return null;
  const mn = Math.min(...c.map(x => x.p));
  const band = c.filter(x => x.p <= mn * (1 + FLAT_FUDGE));
  return band.length ? band.reduce((b, x) => (x.m > b.m ? x : b)) : null;
}

/**
 * Line geometry only — deliberately WITHOUT v1's overlay rules (sell-signal
 * hold, falling-knife tiers, month-on-month dip).
 *
 * Those were tuned against v1's steeper lines and do not transfer: bolting them
 * straight onto v2's shallower support lines scored 9/21 on the reference set,
 * worse than either engine alone, because far more historical closes sit below
 * a shallower line so the hold fires constantly. They have to be re-derived
 * against these lines, one at a time, which is a separate exercise.
 */
export function classifyV2(
  bars: V2Bar[],
  price: number,
  opts: { flatAnchors?: boolean; frac?: number } = {},
): V2Result {
  const flat = opts.flatAnchors ?? true;   // best against HQ: 84% vs 82%
  if (bars.length < 6) {
    return { sentiment: "Josephine", buy: null, sell: null,
             buyLine: null, sellLine: null, note: "insufficient data" };
  }
  const s = toSeries(bars);
  const bl = buyLine(s, flat ? flatTopAnchor(s) : null);
  const sl = sellLine(s, flat ? flatBottomAnchor(s) : null);
  const frac = opts.frac ?? monthFraction();
  const buy = bl ? valueNow(bl, frac) : null;
  const sell = sl ? valueNow(sl, frac) : null;

  let sentiment: V2Result["sentiment"] = "Josephine";
  let note = "";
  const aboveBuy = buy !== null && price >= buy;
  const aboveSell = sell !== null && price >= sell;

  if (sell !== null && price < sell) {
    sentiment = "Bearish"; note = `below sell line ${sell.toFixed(3)}`;
  } else if (aboveBuy && aboveSell) {
    sentiment = "Bullish"; note = `above buy ${buy!.toFixed(3)} & sell ${sell!.toFixed(3)}`;
  } else if (aboveSell && buy === null) {
    sentiment = "Bullish"; note = `above sell ${sell!.toFixed(3)}, no buy line`;
  } else if (aboveSell) {
    sentiment = "Josephine"; note = "between the lines";
  } else if (buy !== null) {
    sentiment = "Bearish"; note = "below buy line, no sell line";
  } else {
    sentiment = "Josephine"; note = "no lines drawable";
  }
  return { sentiment, buy, sell, buyLine: bl, sellLine: sl, note };
}
