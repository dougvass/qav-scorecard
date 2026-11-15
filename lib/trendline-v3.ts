/**
 * 3PTL engine v3 — the sequential walk, derived from Doug's own chart readings.
 *
 * NOT WIRED INTO THE LIVE BUY LIST. Production still calls /api/trendline (v1);
 * v2 (lib/trendline-v2.ts) is HQ's Brettalator port. This is a third, separate
 * engine so it can be measured against both before anything switches over.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * Ported line-for-line from tools/v5_walk.py, which was built by walking charts
 * with Doug one stock at a time (2026-10-05 and 2026-10-06) and keeping only
 * rules he stated. Scores at the time of the port:
 *
 *   his qualified set              15/15
 *   anchors he confirmed           14/16 (L1, L2, H1, H2 across six stocks)
 *   HQ's own 330-stock buy list    83.3% sentiment, 86.7% on the line test,
 *                                  sell-line level median 1.8% / mean 7.9%
 *
 * The architectural difference from v1 and v2 is that both of those fit lines
 * over the window as it looks today. This marches left to right: each line is
 * drawn from the data available at that moment and then frozen, redrawn only at
 * a trigger. SRV is the case that proves it — the buy line that matters was
 * drawn off a 2021-10 peak near 4.43 while the window's highest peak today is
 * 2026-01 at 7.88, nearly double.
 *
 * ── The rules, each traceable to something he said ───────────────────────────
 *  1. WINDOW is five years back from the last COMPLETE month. The feed carries
 *     a partial bar for the current month; including it shifts the window a
 *     month and drops real anchors off the left edge.
 *  2. Monthly CLOSES, pivots at +/-1 bar. "The data is the data" — no time
 *     constraint or spacing anywhere.
 *  3. The 8% SEPARATION is measured off the LOWER of the two prices, on both
 *     lines and in the flat-top band. His S32 buy line H1 2022-04 5.00 -> H2
 *     2025-12 4.62 "just scrapes in at 7.6% ... rounded to 8%": off H1 that is
 *     7.60% and fails, off H2 it is 8.23% and clears (5.0000 >= 4.9896). The
 *     same convention makes his PLS sell gate fail correctly at 7.66%. No
 *     rounding fudge is needed anywhere.
 *  4. L2 may be any later CLOSE, not only a trough — "even though L2 is not a
 *     trough it is the next available month end" — but never the final bar,
 *     which would drag the line onto today's price.
 *  5. L2 advances to the LAST point that works, and the line may not cut the
 *     chart FORWARDS of L2 either: "if it does create a cut then we keep
 *     advancing the position of L2 and keep checking the % above as well."
 *  6. L1 starts at the lowest close and advances ONLY on a backwards cut —
 *     "we would only advance L1 if there is a backwards cut from L2 to L1."
 *  7. H1 is the highest peak so far; flat top within 8% takes the MOST RECENT.
 *  8. H2 is the LATEST qualifying peak, not the earliest, with no close above
 *     the ray between H1 and H2.
 *  9. Whether a ray has been CUT decides the signal, not whether the line is
 *     valid. His FRI buy line is never cut, which is its whole point.
 * 10. A sell line does not SIGNAL until price confirms it by closing back
 *     above: "the stock would have been in a buy signal until both L1 and L2
 *     are established." Before that a close below just advances L2, silently.
 * 11. The buy line is kept current every month but never wiped — only replaced
 *     when a new one is drawable. On S32 his line "remains the current buy
 *     line" through a later sell.
 * 12. A buy ray below the standing sell line is not a buy line at all: you
 *     cannot buy beneath the level you would be selling at.
 *
 * ── One honest caveat ────────────────────────────────────────────────────────
 * L2 selection is not strictly causal. Candidates span the whole window, so the
 * "last point that works" can sit in the future of the month being walked. That
 * is inherent in rule 5 as he stated it, and the readings he confirmed are of
 * the CURRENT line, so it does not affect them — but it means the event dates
 * this engine reports are not a tradeable history. Do not surface them as
 * "date became sell" without revisiting this.
 */

import { currentMonth } from "./exchange-months";

export interface V3Bar { date: string; close: number }

export type V3Anchor = { date: string; close: number };

export interface V3Event { kind: "BUY" | "SELL"; date: string }

export interface V3Result {
  sentiment: "Buy" | "Sell" | "Watch" | "Josephine";
  note: string;
  sell: number | null;
  buy: number | null;
  l1: V3Anchor | null;
  l2: V3Anchor | null;
  h1: V3Anchor | null;
  h2: V3Anchor | null;
  events: V3Event[];
  /** The sell line is a SAFETY NET — the 8% waived — under a holding that has
   *  no other line (Doug on MTS, 2026-11-15). */
  net?: boolean;
  /** A FALLING KNIFE: the walk ended on a safety net and no line that passes
   *  the 8% test can stand under the price. Sell, and no sell line reported. */
  knife?: boolean;
  /** Held, and the sell line is still being formed: price sits under it without
   *  that being a sell (rule 10). */
  forming?: boolean;
}

/** 8% separation, measured off the lower of the two prices. */
export const SEP = 0.08;

/**
 * The two rules from Doug's LNAS walkthrough of 2026-11-15, switchable so any
 * reading can be compared with the engine as it stood before them, on the SAME
 * bars and the same price. Both are on; nothing in the app turns them off —
 * `classifyV3Before` is the only caller that does, for `?compare=1`.
 *
 *   stepOffFlatTop       H1 moves off the first bar of a flat top when no H2
 *                        can be drawn from it (see buyLine)
 *   lockH2WhileHolding   once H2 is a confirmed peak the buy line is locked for
 *                        as long as the stock is held (see the walk)
 */
export const V3_RULES = {
  stepOffFlatTop: true,
  lockH2WhileHolding: true,
  // ── The buy/sell INTERACTION, from his real-time walks of LNAS, AMC and MTS
  //    (2026-11-15). Mirrored in tools/cand_walk2.py, where each was measured
  //    alone against every stock he has qualified. ──
  /** The CURRENT month is the final bar of the walk, its close the live price:
   *  both lines are read there, the last COMPLETE month can be an anchor, and a
   *  cut by the current bar counts. */
  readAtCurrentMonth: true,
  /** A holding always has a sell line: normal rules, then L1 anywhere on a flat
   *  bottom, then a safety net with the 8% waived. */
  safetyNet: true,
  /** While the holding's proper line is still forming, it stands on the net. */
  netWhileForming: true,
  /** After a holding is sold the buy line is re-anchored on the top made since
   *  the buy; H1 moves forward only when that top cannot be an H2 for it. */
  redrawAtSell: true,
  /** With no sell line at all (a falling knife) a buy needs H2 to be a real
   *  peak, not a provisional close on the way down. */
  knifeNeedsPeak: true,
  /** No buy in a month whose close broke the sell line. */
  noBuyOnBreak: true,
  // ── From his review of the first mover list, 2026-11-15. ──
  /** The flat-bottom step and the safety net are for every stock with no clean
   *  line, not only a holding (A1N, RGN, IHHY, LHGG, ZIM). */
  netForAll: true,
  /** A re-anchor on a breaking close must itself have no backwards cut. */
  backCutReanchor: true,
  /** When no buy line can be drawn — or the one the rules give is under the
   *  sell line — break the flat-top rule: from the top to the last point that
   *  works (WTL, COL). */
  flatTopFallback: true,
  /** A confirmed peak 8%+ above H1 voids the buy line of a stock that is out. */
  voidExceededH1: true,
  // ── From his review of the second check page, 2026-11-15: "Not happy with
  //    the safety net case. If falling knife exists and no sell line can be
  //    drawn that passes the 8% test than it should read as a sell, no matter
  //    the buy line. It's basically a trap." ──
  /** READ side only. A stock left standing on a safety net, with no line that
   *  passes the 8% test able to stand under the price, is a FALLING KNIFE:
   *  Sell, whatever its buy line. The one stock a net still carries is a
   *  holding that is not falling (see classifyV3). The walk is untouched —
   *  blocking the buys inside it removed AMC's Mar-24 buy and with it the
   *  Mar-25 sell that moves his H1 to Feb-25. */
  fallingKnife: true,
  // ── From his review of the third check page, 2026-11-15 (MCY). ──
  /** A flat-top FALLBACK buy line (H1 and H2 inside 8%) is provisional, exactly
   *  as a safety net is: once a line that passes the rules can be drawn from
   *  the TRUE top — unstepped, floor or no floor — and nothing has closed over
   *  it since its H2, that is the buy line, even if the fallback has since been
   *  crossed. MCY: fallback Aug-25 5.92 -> Dec-25 5.65 drawn at its Jan-26 sell
   *  and "crossed" in Apr-26; by Jun-26 the May-26 peak gives Mar-24 6.40 ->
   *  May-26 5.87, 8.3% apart and clear of Oct-24 6.24 by under 2c. His chart is
   *  that line: "MCY should be a watch". */
  fallbackIsProvisional: true,
};

const EPS = 1e-9;

/**
 * Five years back from the last COMPLETE month, inclusive.
 *
 * `now` is injectable so tests do not depend on the clock.
 */
export function window5y(bars: V3Bar[], now?: Date): V3Bar[] {
  // Bars carry EXCHANGE months (see lib/exchange-months.ts), so "the current,
  // incomplete month" has to be read on the same clock. Off UTC, for the first
  // eleven hours of a Sydney month the just-completed month would still look
  // current and be stripped, leaving the series a month short.
  const cur = currentMonth(now);
  let b = bars.filter((x) => x.date < cur);
  if (b.length === 0) b = bars.slice();
  if (b.length === 0) return [];
  const last = b[b.length - 1].date;
  const y = parseInt(last.slice(0, 4), 10);
  const m = last.slice(5, 7);
  const start = `${String(y - 5).padStart(4, "0")}-${m}`;
  return b.filter((x) => x.date >= start);
}

/** Peaks and troughs at +/-1 bar. Index 0 and the last bar can never be pivots. */
export function pivots(c: number[]): { pk: number[]; tr: number[] } {
  const pk: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < c.length - 1; i++) {
    if (c[i] >= c[i - 1] && c[i] >= c[i + 1]) pk.push(i);
    if (c[i] <= c[i - 1] && c[i] <= c[i + 1]) tr.push(i);
  }
  return { pk, tr };
}

function rayAt(c: number[], a: number, b: number, at: number): number {
  const g = (c[b] - c[a]) / (b - a);
  return c[a] + g * (at - a);
}

/**
 * The sell line, as [L1, L2] indices, or null when none can be drawn.
 *
 * Candidates are every close from index 1 to n-2: the troughs are a subset of
 * that span, and rule 4 admits non-trough closes while rule 4's tail bars the
 * final one. `l1` pins L1 for a re-anchor; `after` forces L2 past a break;
 * `advance` permits rule 6's L1 step, which must never fire on a first draw —
 * SUL's L1 2022-05 8.490 waits four years for its only valid L2 at 2026-04
 * 11.730, and advancing early skips it.
 */
export function sellLine(
  c: number[],
  l1In?: number | null,
  after?: number | null,
  advance = false,
  upto?: number | null,
  // Only an INTACT line: skip the rule-5 fallback, which is a line already cut
  // ahead of L2. Used where a line is being looked for to stand ON, not to
  // describe a stock already trading under it.
  strict = false,
): [number, number] | null {
  const n = c.length;
  if (n < 3) return null;
  // CAUSAL: only months the walk has reached may be anchors. Without `upto` the
  // first draw reached years forward for its L2 — RSG's line was "drawn" at
  // 2021-11 with L2 at 2025-01, and because the walk only acts once t > L2 it
  // stayed silent for three years, so RSG's -47% month (2024-10, 0.820 ->
  // 0.435) could not fire the sell Doug confirms it should have. This is the
  // non-causality the port's own caveat warned about, and fixing it is what
  // makes the walk's event dates trustworthy enough to score Bible Column I.
  const end = upto == null ? n - 1 : Math.min(upto, n - 1);
  if (end < 2) return null;
  let l1 = l1In ?? -1;
  if (l1 < 0) {
    // The lowest close WITHIN the causal window. Scanning the whole series here
    // was the subtler half of the non-causality: L1 could be picked from months
    // the walk had not reached, which both silenced early months and shifted
    // every line that followed.
    l1 = 1;
    for (let i = 1; i < end; i++) if (c[i] < c[l1]) l1 = i;
  }
  const floor = Math.max(l1, after ?? 0);

  // Rule 5: prefer the LAST candidate with no forward cut. The forward-cut test
  // SELECTS L2; it cannot be absolute, because a stock trading below its sell
  // line has a close under the ray after L2 by definition — that cut IS the sell
  // signal. So fall back to the last candidate clearing 8% with no backwards
  // cut. Without the fallback PLS, ASX and CCP lose the lines he confirmed.
  let fallback = -1;
  for (let l2 = end - 1; l2 > floor; l2--) {
    if (c[l2] < c[l1] * (1 + SEP)) continue;
    const g = (c[l2] - c[l1]) / (l2 - l1);
    let backCut = false;
    for (let k = l1 + 1; k < l2; k++) {
      if (c[k] < c[l1] + g * (k - l1) - EPS) { backCut = true; break; }
    }
    if (backCut) continue;
    if (fallback < 0) fallback = l2;
    let fwdCut = false;
    for (let k = l2 + 1; k < end; k++) {
      if (c[k] < c[l1] + g * (k - l1) - EPS) { fwdCut = true; break; }
    }
    if (fwdCut) continue;
    return [l1, l2];
  }
  if (fallback >= 0 && !strict) return [l1, fallback];

  // Rule 6: L1 steps forward, but only in response to a break.
  // Bounded by `end`, not n-1: the advance must not step L1 past the causal
  // horizon either, or the walk reaches forward again through this path.
  if (advance && l1 + 1 < end) return sellLine(c, l1 + 1, after, true, upto, strict);
  return null;
}

/**
 * A HOLDING's sell line when the lowest low gives none: L1 moves to a later bar
 * of the same FLAT BOTTOM — any bar still within 8% of the low — and the first
 * that gives an intact line is taken. The mirror of the buy line stepping off
 * the first bar of a flat top.
 *
 *   S32  low Aug-25 2.72, next bar Sep-25 2.74. From the low, Sep-25 sits under
 *        every ray; from Sep-25 the line he confirmed (L1 2.74) draws.
 *   AMC  low Feb-24 68.35; Apr-24 69.10 cuts every ray from it. From Apr-24 the
 *        line runs to L2 Dec-24 — "a sell walk with L1 Apr24 and L2 Dec24".
 *   KSL  a bottom running Apr-23 0.73 … Jun-23 0.74, a two-month bump to 0.83,
 *        then Oct/Nov-23 0.765. Only Nov-23 draws — in his words on flat
 *        bottoms, "the last trough before the sustained rise".
 *   MTS  nothing draws from any bar of its bottom, which is why he reaches for
 *        the safety net instead.
 *
 * The 8% is what keeps it honest: a free bar-by-bar advance walks L1 up the
 * recovery and pairs adjacent months (MTS May-25 -> Jun-25, 0.53 a month).
 */
export function sellLineBand(c: number[], t: number): [number, number] | null {
  const end = Math.min(t, c.length - 1);
  if (end < 3) return null;
  let low = 1;
  for (let i = 1; i < end; i++) if (c[i] < c[low]) low = i;
  for (let j = low + 1; j < end; j++) {
    if (!(c[j] < c[low] * (1 + SEP))) continue;
    const r = sellLine(c, j, null, false, t, true);
    if (r != null) return r;
  }
  return null;
}

/**
 * The SAFETY NET: a sell line with the 8% waived, for a holding that has no
 * other.
 *
 * Doug on MTS, 2026-11-15: "given it has been a falling knife since Apr 22
 * there is no active sell line. In this instance we would break the flat bottom
 * rule in L1 Oct24 and L2 Mar25 so we have some safety net. This would have
 * triggered an MTS sell in Dec25."
 *
 * L1 is the low; L2 the LAST later close that works — rising, no cut behind it,
 * no cut ahead of it. On MTS that is Mar-25: Dec-24, Feb-25 and Mar-25 lie on
 * one 2c-a-month line from the Oct-24 low, and Apr-25 would cut Dec-24. The
 * tolerance is for closes that sit exactly ON the line, as those three do.
 */
export function netLine(c: number[], t: number): [number, number] | null {
  const end = Math.min(t, c.length - 1);
  if (end < 3) return null;
  // The LATEST of equal lows: from the first of a double bottom every rising
  // line is cut by the second.
  let l1 = 1;
  for (let i = 1; i < end; i++) if (c[i] <= c[l1]) l1 = i;
  const tol = 1e-6 * c[l1];
  for (let l2 = end - 1; l2 > l1; l2--) {
    if (!(c[l2] > c[l1] + tol)) continue;
    const g = (c[l2] - c[l1]) / (l2 - l1);
    let cut = false;
    for (let k = l1 + 1; k < l2 && !cut; k++) if (c[k] < c[l1] + g * (k - l1) - tol) cut = true;
    for (let k = l2 + 1; k < end && !cut; k++) if (c[k] < c[l1] + g * (k - l1) - tol) cut = true;
    if (cut) continue;
    return [l1, l2];
  }
  return null;
}

/**
 * Can ANY sell line that passes the 8% test stand under `price`?
 *
 * L1 is the low or a later bar of its flat bottom (within 8% of it), L2 any
 * later close 8% or more above L1 with no close between them under the line —
 * both among the bars before `end`; the line is read at month `at`. A cut AFTER
 * L2 does not disqualify it: that cut was a sell signal, and a price back above
 * the line is standing on it again (MTS: Apr-26 2.72 -> Aug-26 2.94, cut by
 * Sep-26, 3.105 by November under a price of 3.41; Doug: "definitely a watch").
 *
 * When there is none, every line the rules allow is above the price — his words
 * on HMY: "still below any possible sell line that could be drawn ...
 * effectively in a falling knife scenario".
 */
export function lineUnder(c: number[], endIn: number, at: number, price: number): boolean {
  const end: number = Math.min(endIn, c.length);
  if (end < 3) return false;
  let low = 1;
  for (let i = 1; i < end; i++) if (c[i] <= c[low]) low = i;
  for (let l1 = low; l1 < end; l1++) {
    if (l1 !== low && !(c[l1] < c[low] * (1 + SEP))) continue;
    for (let l2 = l1 + 1; l2 < end; l2++) {
      if (c[l2] < c[l1] * (1 + SEP)) continue;
      const g: number = (c[l2] - c[l1]) / (l2 - l1);
      if (!(c[l1] + g * (at - l1) < price)) continue;
      let cut = false;
      for (let k = l1 + 1; k < l2 && !cut; k++) if (c[k] < c[l1] + g * (k - l1) - EPS) cut = true;
      if (!cut) return true;
    }
  }
  return false;
}

/**
 * The buy line, as [H1, H2, firstCut]. `firstCut` is informational: rule 9 says
 * the cut decides the signal, not the line's validity, so an uncut line is
 * returned and is in fact the live one.
 *
 * `upto` keeps it causal — only peaks before that month are visible. `aboveAt`
 * enforces that a line drawn AT a sell trigger is one price has yet to cross;
 * without it a steep old ray has already decayed below price, everything reads
 * as "above" it, and the stock flips straight back to a buy.
 *
 * The caller passes `aboveAt` only while a USABLE buy line is standing — see
 * the walk. Passed unconditionally it deadlocks against rule 3 and a stock can
 * never re-enter; that was the HZN lock-out.
 */
/**
 * Has price TURNED DOWN from month `j`?
 *
 * Doug, 2026-10-08: "The next peak is 2026-06 which in realtime we wouldn't
 * have known was a peak so it would have held the H2 position until it was
 * confirmed as a peak." A peak is only knowable once the following month exists
 * and is LOWER, hence the strict `>` on the right — a flat shelf is not a turn
 * down. Local to H2 on purpose; `pivots`, which L1 and L2 use, is untouched.
 */
function confirmedPeak(c: number[], j: number): boolean {
  return j > 0 && j < c.length - 1 && c[j] >= c[j - 1] && c[j] > c[j + 1];
}

export function buyLine(
  c: number[],
  pk: number[],
  upto: number,
  aboveAt?: number | null,
  // H1 only ever moves FORWARD: once a sell has carried it past a peak (see
  // redrawAtSell) the peaks behind that bar are no longer candidates.
  floor = 0,
  // The stock has been SOLD and is looking for its way back in: the only case
  // in which the flat-top fallback is drawn.
  seeking = false,
): [number, number, number | null] | null {
  const fallback = V3_RULES.flatTopFallback && seeking;
  const avail = pk.filter((i) => i < upto && i >= floor);
  if (avail.length < (fallback ? 1 : 2)) return null;

  let top = avail[0];
  for (let i = 0; i < avail.length; i++) if (c[avail[i]] > c[top]) top = avail[i];
  // Rule 7, with rule 3's convention: a peak is part of the flat top when the
  // top is less than 8% above IT. Measured the other way round, S32's 2025-12
  // 4.62 looks 7.97% below the top 5.02, joins the band, becomes H1 and kills
  // the line; off its own price it is 8.66% away and is correctly excluded,
  // leaving H1 2022-04 5.00 — the H1 he confirmed.
  //
  // The flat top is tested PEAK BY PEAK, against the NEXT peak only. Doug,
  // 2026-11-07: "There should be no dip rule between flat tops. The flat top
  // rule simply tests the 8% or greater differential between H1 and H2. If it
  // fails then the walk continues. It doesn't necessarily make H2 become the
  // next H1, you should just keep walking through the peaks and testing."
  //
  // So: start at the highest peak and step forward while the next peak is
  // within 8% — a flat top may run several bars. The moment a peak is 8% or
  // more below, the flat top has ended, H1 stays put, and that peak is just an
  // H2 candidate like any other.
  //
  // Scanning the WHOLE window for the most recent peak in the band, which is
  // what this did before, reached across unrelated structure: it paired KLS's
  // 7.825 with a 7.260 fourteen months and a 41% drawdown later. A dip test
  // was then bolted on to suppress that, and the dip test is what pinned REG's
  // H1 to its 8.37 all-time high and left it reading Buy at 4.92. Stepping one
  // peak at a time needs no such patch: KLS's next peak is 6.47, 21% down, so
  // its flat top ends immediately and H1 stays on the high, while REG steps
  // 8.37 -> 7.91 (5.8%) and stops at the next, 6.95.
  let h1 = top;
  for (;;) {
    const nxt = avail.find((i) => i > h1);
    if (nxt === undefined || !(c[h1] < c[nxt] * (1 + SEP))) break;
    h1 = nxt;
  }

  // Rule 8: the LATEST qualifying point. The earliest gave FRI H2 2024-09 and a
  // ray decayed to -0.125, which was then rejected and left no buy line at all;
  // his H2 2025-10 is the last that qualifies and gives 0.824.
  //
  // H2 may be ANY later close, not only a peak — the mirror of rule 4 for L2,
  // and what Doug's gold reading requires: his H2 2026-05 4545.95 is 14.9%
  // below H1 2026-02 5222.30 so it clears the gate easily, but it is NOT a peak
  // (2026-04 4611.35 precedes it). Same ALK logic as L2: "not technically a low
  // trough, just the next low/close". Never the final bar, for the same reason
  // L2 never is. This lifted the anchors he has confirmed from 14/16 to 16/16
  // and his qualified verdicts to 6/6, with his 15 unchanged at 15/15.
  const lastH2 = Math.min(upto, c.length - 1);
  // Could ANY line be drawn by the rules, whether or not price has since
  // crossed it? Only if none can is the fallback wanted: a proper line that
  // aboveAt turns away is still a line (ACF).
  let drawable = false;
  const search = (from: number): [number, number, number | null] | null => {
    for (let h2 = lastH2 - 1; h2 > from; h2--) {
      if (c[from] < c[h2] * (1 + SEP)) continue;
      const g = (c[h2] - c[from]) / (h2 - from);
      let over = false;
      for (let k = from + 1; k < h2; k++) {
        if (c[k] > c[from] + g * (k - from) + EPS) { over = true; break; }
      }
      if (over) continue;
      drawable = true;
      if (aboveAt != null) {
        if (h2 >= aboveAt) continue;
        if (c[aboveAt] >= c[from] + g * (aboveAt - from)) continue;
      }
      let cut: number | null = null;
      for (let k = h2 + 1; k < c.length; k++) {
        if (c[k] > c[from] + g * (k - from)) { cut = k; break; }
      }
      return [from, h2, cut];
    }
    return null;
  };

  // H1 STEPS OFF THE FIRST BAR OF A FLAT TOP when nothing can be drawn from it.
  //
  // LNAS, Doug 2026-11-15. Its top is two bars, 2021-11 14.60 then 2021-12
  // 14.53. The second is not a pivot peak — it is lower than the bar before —
  // so the peak-by-peak step above never reaches it and H1 stayed on 14.60.
  // From there the 14.53 bar sits two cents ABOVE the ray to the 2025-01 peak,
  // a backwards cut, and so does every H2 before 2025-07: no buy line could be
  // drawn for three and a half years. His line starts on the second bar and
  // runs through 2025-01, which price crossed in 2025-06 — "the H2 in Jan25 in
  // real time is correct".
  //
  // This is the buy-line mirror of his sell-line rule, "we would only advance
  // L1 if there is a backwards cut from L2 to L1": only when NO H2 is drawable,
  // and only while the next bar is still part of the flat top — within the
  // same 8% of the H1 the peaks chose. Unrestricted, it walks H1 down a slow
  // decline and moved half as many readings again when measured.
  let found = search(h1);
  let from = h1;
  while (found == null && V3_RULES.stepOffFlatTop) {
    const nxt = from + 1;
    if (nxt >= lastH2 || !(c[h1] < c[nxt] * (1 + SEP))) break;
    from = nxt;
    found = search(from);
  }
  if (found == null && fallback && !drawable) {
    // From the TOP, not stepped along the flat top — the rule being waived is
    // the one that steps it.
    const tl = topLine(c, pk, upto, floor, aboveAt);
    if (tl != null) return [tl[0], tl[1], null];
  }
  return found;
}

/**
 * Is L1 inside the UNBROKEN run of bars within 8% of the low? Then moving L1 to
 * it is just the bottom being walked along (S32 Aug-25 -> Sep-25, CCP Mar-26 ->
 * May-26, AMC Feb-24 -> Apr-24, LHGG Mar-26 -> Jun-26). A bar that comes back
 * within 8% only after a bounce is a separate trough.
 */
function flatRun(c: number[], l1: number, t: number): boolean {
  const end = Math.min(t, c.length - 1);
  let low = 1;
  for (let i = 1; i < end; i++) if (c[i] < c[low]) low = i;
  if (l1 < low) return false;
  for (let k = low + 1; k <= l1; k++) if (!(c[k] < c[low] * (1 + SEP))) return false;
  return true;
}

/**
 * L2 moves onto the breaking close — if that line clears 8% AND has no
 * backwards cut. The second test was missing: RGN's line ran Oct-23 1.965 ->
 * Sep-26 2.23 straight through Feb-25 2.05, A1N's Mar-26 -> Aug-26 through
 * Jun-26. Doug, 2026-11-15: "sell line L2 fails backward cut". With no valid
 * re-anchor the line is dead and the next month draws afresh.
 */
function reanchor(c: number[], l1: number, t: number): [number, number] | null {
  if (c[t] >= c[l1] * (1 + SEP)) {
    if (!V3_RULES.backCutReanchor) return [l1, t];
    const g = (c[t] - c[l1]) / (t - l1);
    for (let k = l1 + 1; k < t; k++) if (c[k] < c[l1] + g * (k - l1) - EPS) return null;
    return [l1, t];
  }
  return sellLine(c, l1, t, true, t);
}

/**
 * The flat-top rule broken: from the TOP to the last later close that works —
 * lower, nothing above the line behind it, nothing above it ahead — 8% waived.
 * The mirror of the safety net. Doug, 2026-11-15, on WTL: "Best fall back to
 * ensure possibility of getting into the stock is to break the flat top rule
 * and place H1 Oct25 and H2 Feb26. Not ideal but a fallback when the buy line
 * can't otherwise be drawn"; on COL, "H1 Jun 26 with H2 Aug26".
 */
function topLine(c: number[], pk: number[], t: number, floor: number, aboveAt?: number | null): [number, number] | null {
  const avail = pk.filter((i) => i < t && i >= floor);
  if (avail.length === 0) return null;
  let top = avail[0];
  for (let i = 0; i < avail.length; i++) if (c[avail[i]] > c[top]) top = avail[i];
  const last = Math.min(t, c.length - 1);
  const tol = 1e-6 * c[top];
  for (let h2 = last - 1; h2 > top; h2--) {
    if (!(c[h2] < c[top] - tol)) continue;
    const g = (c[h2] - c[top]) / (h2 - top);
    let cut = false;
    for (let k = top + 1; k < h2 && !cut; k++) if (c[k] > c[top] + g * (k - top) + tol) cut = true;
    for (let k = h2 + 1; k < last && !cut; k++) if (c[k] > c[top] + g * (k - top) + tol) cut = true;
    if (cut) continue;
    if (aboveAt != null && (h2 >= aboveAt || c[aboveAt] >= c[top] + g * (aboveAt - top))) continue;
    return [top, h2];
  }
  return null;
}

/**
 * The buy line the rules give from the TRUE top: H1 the highest peak the walk
 * can see at or behind `before` (not stepped along a flat top, not held behind
 * a floor), H2 the latest later close 8% or more below it with nothing over the
 * line between. It must be a LIVE line — nothing has closed on or over it since
 * H2, this month included. One crossed long ago was left behind: CQR's Apr-22
 * 4.47 -> May-25 3.94, crossed in Aug-25 and traded over for a year, is not a
 * buy line again because price has fallen back under it.
 *
 * `before`: a higher top made SINCE the fallback's H1 belongs to the holding,
 * not to a buy line (BBL, BCN).
 */
function trueTopLine(c: number[], pk: number[], t: number, before: number): [number, number] | null {
  const avail = pk.filter((i) => i < t && i <= before);
  if (avail.length === 0) return null;
  let top = avail[0];
  for (let i = 0; i < avail.length; i++) if (c[avail[i]] > c[top]) top = avail[i];
  for (let h2 = Math.min(t, c.length - 1) - 1; h2 > top; h2--) {
    if (!(c[top] >= c[h2] * (1 + SEP))) continue;
    const g: number = (c[h2] - c[top]) / (h2 - top);
    let over = false;
    for (let k = top + 1; k < h2 && !over; k++) if (c[k] > c[top] + g * (k - top) + EPS) over = true;
    if (over) continue;
    for (let k = h2 + 1; k <= t; k++) if (c[k] >= c[top] + g * (k - top)) return null;
    return [top, h2];
  }
  return null;
}

/** `j` is a peak that month `t` can already see has turned down. */
function peakBy(c: number[], j: number, t: number): boolean {
  return j > 0 && j < t && c[j] >= c[j - 1] && c[j] > c[j + 1];
}

/**
 * The buy line after a HOLDING is sold. `since` is the month it was bought.
 *
 * 1. A line still ABOVE price stands. Doug on S32, whose line had been crossed
 *    and was then wiped at the sell: it "remains the current buy line". FRI the
 *    same.
 *
 * 2. Otherwise price has left the line behind, and the next one is anchored on
 *    the TOP MADE SINCE THE BUY — the high the holding fell from:
 *      LNAS  bought Nov-23, sold Feb-25, top Jan-25 11.12. It joins the Dec-21
 *            top cleanly and 8% below it: "the H2 in Jan25 in real time is
 *            correct".
 *      AMC   bought Nov-23, sold Mar-25, top Oct-24 83.65. That is within 8% of
 *            the Dec-22 top — a flat top WITH it, not an H2 for it — so H1 moves
 *            up to it and the flat-top step carries it on to Feb-25 80.30:
 *            "advanced the next buy line to H1 Feb25".
 *    H1 moves forward ONLY then — when the top since the buy cannot be an H2
 *    for it (a flat top with it, or a close cutting the line back). That is the
 *    mirror of his sell-side rule: "we would only advance L1 if there is a
 *    backwards cut from L2 to L1".
 *
 * A clean line to that top which price is ALREADY over changes nothing. That
 * case matters: in a falling knife every line from the top is under price, and
 * treating it as a reason to move H1 threw LNAS's 2021 top away at its first
 * sell. So did keying this on "the latest confirmed peak" rather than the top
 * since the buy — it fired on one-cent shelf peaks (BOL, HMY, KLS).
 */
function redrawAtSell(
  c: number[],
  pk: number[],
  t: number,
  buy: [number, number] | null,
  floor: number,
  since: number,
): { buy: [number, number] | null; floor: number } {
  if (buy != null && rayAt(c, buy[0], buy[1], t) > c[t]) return { buy, floor };
  const lo = Math.max(1, since);
  if (lo >= t) return { buy, floor };
  let top = lo;
  for (let i = lo; i < t; i++) if (c[i] >= c[top]) top = i;   // latest of equal highs
  let cur: number;
  if (buy != null) {
    cur = buy[0];
  } else {
    const avail = pk.filter((i) => i < t && i >= floor);
    if (avail.length === 0) return { buy, floor };
    let hi = avail[0];
    for (let i = 0; i < avail.length; i++) if (c[avail[i]] > c[hi]) hi = avail[i];
    for (;;) {
      const at: number = hi;
      const nxt = avail.find((i) => i > at);
      if (nxt === undefined || !(c[hi] < c[nxt] * (1 + SEP))) break;
      hi = nxt;
    }
    cur = hi;
  }
  if (top <= cur) return { buy, floor };

  const cutFrom = (h: number): boolean => {
    const g = (c[top] - c[h]) / (top - h);
    for (let k = h + 1; k < top; k++) if (c[k] > c[h] + g * (k - h) + EPS) return true;
    return false;
  };
  const from: number = cur;
  const seq = [from].concat(pk.filter((i) => i < t && i > from && i < top));
  for (let s = 0; s < seq.length; s++) {
    const h = seq[s];
    if (c[h] <= c[top] || cutFrom(h)) continue;
    if (c[h] < c[top] * (1 + SEP)) break;               // a flat top with it
    if (c[t] < rayAt(c, h, top, t)) {
      return { buy: [h, top], floor: h === from ? floor : Math.max(floor, h) };
    }
    return { buy, floor };                              // clean, but price is over it
  }
  return { buy: null, floor: Math.max(floor, top) };
}

interface WalkOut {
  sell: [number, number] | null;
  buy: [number, number] | null;
  state: "long" | "out" | null;
  events: V3Event[];
  /** Has price closed back above the sell line since L2 — is it in force? */
  confirmed: boolean;
  /** The sell line is a safety net. */
  isNet: boolean;
}

/**
 * One chronological pass. Lines are frozen once drawn and every event is
 * appended in time order.
 */
export function walk(
  c: number[],
  dt: string[],
  pk: number[],
  n: number,
  advanceFirst = false,
): WalkOut {
  let sell: [number, number] | null = null;
  let confirmed = false;
  let isNet = false;      // the standing line is a safety net (8% waived)
  let prov = 0;           // 0 a line from the low, 1 from a flat-bottom bar, 2 a net
  let buy: [number, number] | null = null;
  let floor = 0;          // H1 may not sit behind this bar
  let since = 0;          // the month the current holding began
  let state: "long" | "out" | null = null;
  const events: V3Event[] = [];
  const NET = V3_RULES.safetyNet;

  for (let t = 2; t < n; t++) {
    // Whether the stock was HELD coming into this month — the position a sell
    // closes, so every test below reads this rather than `state`.
    const holding: boolean = state === "long";
    let broke: boolean = false;    // did this month's close break the sell line?
    let sold: boolean = false;     // was a holding sold this month?

    // ── Drawing the sell line ────────────────────────────────────────────────
    // One order, for every stock: an INTACT line from the low; then from a
    // later bar of a flat bottom; then the safety net (8% waived). Before the
    // 2026-11-15 rules only a holding got the last two, and before that nobody
    // did — a stock bought in a falling knife sat "held" for years with no line
    // at all (MTS, AMC), and a stock with no clean 8% line was read off a line
    // already cut (A1N: "no possible sell line can be drawn unless you break
    // the flat bottom rule").
    // ... for EVERY stock with no clean line. Limiting it to a holding or a
    // stock over its buy line left the rest on the old first-draw fallback —
    // "the latest 8% point with no backwards cut, and let the cut be the
    // signal" — which for a stock basing under its line is two adjacent months
    // extended for years: ZIM read a sell line of 33.21 at a price of 13.89,
    // and production shows IHEB at 170 and CYL at 5.29 the same way.
    const wide: boolean = NET && (holding || V3_RULES.netForAll);
    if (sell == null) {
      confirmed = false;
      isNet = false;
      prov = 0;
      if (wide) {
        sell = sellLine(c, null, null, advanceFirst, t, true);
        if (sell == null) {
          const band: [number, number] | null = sellLineBand(c, t);
          // A line from a SEPARATE trough must already be standing — this
          // month's close above it — or the net is the better reading. MTS's
          // Sep-26 -> Oct-26, drawn off last month's low at 30c a month, is no
          // line to stand on.
          if (band != null && (flatRun(c, band[0], t) || c[t] > rayAt(c, band[0], band[1], t))) {
            sell = band;
            prov = 1;
          }
        }
        if (sell == null) {
          const nl: [number, number] | null = netLine(c, t);
          if (nl != null) {
            sell = nl;
            isNet = true;
            prov = 2;
          } else if (holding) {
            // Held, nothing drawable, and a new low: a falling knife.
            let lowest: number = c[1];
            for (let i = 1; i < t; i++) if (c[i] < lowest) lowest = c[i];
            if (c[t] < lowest) {
              events.push({ kind: "SELL", date: dt[t] });
              state = "out";
              sold = true;
              broke = true;
            }
          }
        }
      } else {
        sell = sellLine(c, null, null, advanceFirst, t);
      }
    } else if (prov > 0 && NET) {
      // A flat-bottom line or a net stands only until a better one can be
      // drawn: from the true low, or (for a net) from the flat bottom. It is
      // taken as a line still to be confirmed. (Waiting for a close above it
      // never came for CCP, which rises a little slower than its own forming
      // line every month and sat on a flat net at 10.9 under a price of 15.)
      // A holding is protected meanwhile: under a forming line it still stands
      // on the net — see netWhileForming.
      let better: [number, number] | null = sellLine(c, null, null, advanceFirst, t, true);
      let lvl: number = 0;
      if (better == null && prov === 2) {
        better = sellLineBand(c, t);
        lvl = 1;
      }
      const s0: number = sell[0], s1: number = sell[1];
      if (better != null && !(better[0] === s0 && better[1] === s1) &&
          (lvl === 0 || flatRun(c, better[0], t) || c[t] > rayAt(c, better[0], better[1], t))) {
        sell = better;
        confirmed = false;
        isNet = false;
        prov = lvl;
      }
    }

    if (sell != null) {
      // The annotations are load-bearing: `sell` is reassigned further down
      // from expressions that reference l1, so inferring l1 from the narrowed
      // `sell` is circular and tsc rejects it as implicit any.
      const l1: number = sell[0];
      const l2: number = sell[1];
      const v: number = rayAt(c, l1, l2, t);
      if (t > l2) {
        // Rule 10. A line price has not confirmed is still being FORMED, not in
        // force: a close below it advances L2 and emits nothing. A CONFIRMED
        // line signals, whether or not the stock is held (RSG) — `state` tracks
        // position, and re-entry still needs the buy line crossed (FRI).
        if (!confirmed) {
          if (c[t] > v) {
            confirmed = true;
            // The first established sell line is taken as a holding — but only
            // a line from the TRUE LOW. A net or a line off a later trough is
            // provisional: LHGG was "held" from the month its net confirmed and
            // froze its buy line on May-26; PMGOLD's five-month-old line made
            // it a holding in Aug-23 and sold it in September.
            if (state == null && !(prov > 0 && V3_RULES.netForAll)) {
              state = "long";
              since = t;
            }
          } else if (c[t] < v && t < n - 1) {
            // At the final bar nothing re-anchors; the line stands as drawn.
            broke = true;
            // A line still being formed is not in force, so a holding still
            // stands on its NET. AMC, Sep-26: held, the line from the Apr-26
            // low still forming, the close of 61.27 under the net — "another
            // sell line L1 Apr26 and L2 Sep26 created a sell".
            if (V3_RULES.netWhileForming && holding && NET && !isNet) {
              const nl: [number, number] | null = netLine(c, t);
              if (nl != null && c[t] < rayAt(c, nl[0], nl[1], t)) {
                events.push({ kind: "SELL", date: dt[t] });
                state = "out";
                sold = true;
              }
            }
            let nxt: [number, number] | null;
            if (isNet) {
              // A net re-anchors without the 8% as well.
              const g: number = (c[t] - c[l1]) / (t - l1);
              const tol: number = 1e-6 * c[l1];
              let ok: boolean = c[t] > c[l1] + tol;
              for (let k = l1 + 1; k < t && ok; k++) {
                if (c[k] < c[l1] + g * (k - l1) - tol) ok = false;
              }
              nxt = ok ? [l1, t] : null;
            } else {
              nxt = reanchor(c, l1, t);
            }
            if (nxt != null) {
              sell = nxt;
            } else {
              // DEAD, not merely broken (ASH: a line rising to 0.998 over a
              // stock at 0.305). OUT of a position the walk rebuilds from the
              // new lows next month. IN one, the holding falls back on its net
              // — and a close under that, or no net to draw, is the sell.
              sell = null;
              confirmed = false;
              isNet = false;
              prov = 0;
              if (holding && NET && !sold) {
                const nl: [number, number] | null = netLine(c, t);
                if (nl != null && c[t] > rayAt(c, nl[0], nl[1], t)) {
                  sell = nl;
                  confirmed = true;
                  isNet = true;
                  prov = 2;
                } else {
                  events.push({ kind: "SELL", date: dt[t] });
                  state = "out";
                  sold = true;
                }
              }
            }
          }
        } else if (c[t] < v && prov > 0 && state == null && V3_RULES.netForAll) {
          // A net, or a line off a later trough, under a stock that was never a
          // holding: its break is no signal. The line simply goes.
          sell = null;
          isNet = false;
          prov = 0;
          confirmed = false;
          broke = true;
        } else if (c[t] < v) {
          events.push({ kind: "SELL", date: dt[t] });
          sold = holding;
          state = "out";
          broke = true;
          if (isNet) {
            // The net ends with the break; next month draws afresh.
            sell = null;
            isNet = false;
            prov = 0;
          } else if (t < n - 1) {
            sell = reanchor(c, l1, t);
            if (sell == null) prov = 0;
          }
          // On the final bar nothing re-anchors: the line stands, and it stands
          // BROKEN — still in force, not a line being formed. (Left as
          // "unconfirmed", HLI under its sell line read as a holding waiting
          // for its line to form.)
          confirmed = V3_RULES.safetyNet && sell != null && t === n - 1 && !isNet;
        }
      }
    }

    // A holding has just been sold: settle which buy line it now faces.
    if (sold && V3_RULES.redrawAtSell) {
      const rd: { buy: [number, number] | null; floor: number } = redrawAtSell(c, pk, t, buy, floor, since);
      buy = rd.buy;
      floor = rd.floor;
    }

    // "H1 would stay global unless a higher peak is formed to the right." A
    // confirmed peak 8% or more above H1 — beyond a flat top with it — voids
    // the line of a stock that is OUT: HLI's "was superseded when it became a
    // sell in Mar25", after its 6.11 high. While HELD, H1 is fixed (RSG keeps
    // 0.82 through a 1.485 high); within 8% it is a flat top and H1 stays (S32's
    // 5.16 against 5.00, whose line "remains the current buy line").
    if (buy != null && state !== "long" && V3_RULES.voidExceededH1) {
      const bh: number = buy[0];
      let best: number = -1;
      for (let i = 0; i < pk.length; i++) {
        const j: number = pk[i];
        if (j >= t || j <= bh) continue;
        if (c[j] >= c[bh] * (1 + SEP) && peakBy(c, j, t) && (best < 0 || c[j] > c[best])) best = j;
      }
      if (best >= 0) {
        floor = Math.max(floor, best);
        buy = null;
      }
    }

    // Rule 11, refined. While SEEKING ENTRY the line is drawn afresh each
    // month, gated by aboveAt only while a USABLE line stands (the HZN
    // lock-out). While HOLDING, H1 is fixed and H2 moves only until a peak
    // holds the slot (LNAS, RSG).
    if (state !== "long" || buy == null) {
      let usable: boolean = false;
      if (buy != null && sell != null) {
        const bh1: number = buy[0], bh2: number = buy[1];
        const sl1: number = sell[0], sl2: number = sell[1];
        usable = rayAt(c, bh1, bh2, t) > rayAt(c, sl1, sl2, t);
      }
      // `seeking`: the flat-top fallback exists "to ensure possibility of
      // getting into the stock", so only a stock that has been SOLD draws it.
      const b = buyLine(c, pk, t, usable ? t : null, floor, state === "out");
      if (b != null) buy = [b[0], b[1]];
      if (V3_RULES.flatTopFallback && state === "out" && sell != null && buy != null) {
        const q0: number = buy[0], q1: number = buy[1];
        const r0: number = sell[0], r1: number = sell[1];
        if (!peakBy(c, q1, t) && rayAt(c, q0, q1, t) <= rayAt(c, r0, r1, t)) {
          // The line the rules give runs to a close that is not a peak ("cannot
          // be drawn ... not both peaks") AND is under the sell line, so the
          // stock could never get back in. A proper peak-to-peak line that is
          // merely under the sell line stays (JHX). WTL after its
          // May-26 sell: H1 stepped along the flat top to Feb-26 and the only
          // line from there is under the sell line. Doug: "Best fall back to
          // ensure possibility of getting into the stock is to break the flat
          // top rule and place H1 Oct25 and H2 Feb26." Taken only if THAT line
          // is over the sell line.
          const tl: [number, number] | null = topLine(c, pk, t, floor);
          if (tl != null && rayAt(c, tl[0], tl[1], t) > rayAt(c, r0, r1, t)) buy = tl;
        }
      }
    } else if (!V3_RULES.lockH2WhileHolding || !confirmedPeak(c, buy[1])) {
      const h1f: number = buy[0];
      let h2f: number = -1;
      for (let cand = Math.min(t, c.length - 1) - 1; cand > h1f; cand--) {
        if (c[h1f] < c[cand] * (1 + SEP)) continue;
        const g: number = (c[cand] - c[h1f]) / (cand - h1f);
        let over: boolean = false;
        for (let k = h1f + 1; k < cand; k++) {
          if (c[k] > c[h1f] + g * (k - h1f) + EPS) { over = true; break; }
        }
        if (over) continue;
        // Only with the lock switched OFF, to reproduce the engine as it was
        // before 2026-11-15: a confirmed peak gave way only to a higher one.
        if (!V3_RULES.lockH2WhileHolding && confirmedPeak(c, buy[1]) &&
            !(confirmedPeak(c, cand) && c[cand] > c[buy[1]])) continue;
        h2f = cand;
        break;
      }
      if (h2f > 0) buy = [h1f, h2f];
    }

    if (V3_RULES.fallbackIsProvisional && buy != null) {
      const f0: number = buy[0], f1: number = buy[1];
      if (c[f0] < c[f1] * (1 + SEP)) {
        // The standing line is a flat-top fallback.
        const tt: [number, number] | null = trueTopLine(c, pk, t, f0);
        if (tt != null && tt[0] < f0) buy = tt;
      }
    }

    if (state !== "long" && buy != null) {
      const h1: number = buy[0];
      const h2: number = buy[1];
      const bv: number = rayAt(c, h1, h2, t);
      // Rule 12: a buy ray below the standing sell line is not a buy line.
      let over: boolean = true;
      if (sell != null) over = bv > rayAt(c, sell[0], sell[1], t);
      let ok: boolean = t > h2 && c[t] > bv && over;
      // In a FALLING KNIFE — no sell line at all — only a line through a real
      // peak counts; and a close that broke the sell line is not a buy.
      if (ok && V3_RULES.knifeNeedsPeak && sell == null) ok = peakBy(c, h2, t);
      if (ok && V3_RULES.noBuyOnBreak) ok = !broke;
      if (ok) {
        events.push({ kind: "BUY", date: dt[t] });
        state = "long";
        since = t;
      }
    }
  }

  return { sell, buy, state, events, confirmed, isNet };
}

/**
 * The same reading by the engine as it was BEFORE the two rules above.
 *
 * classifyV3 is synchronous, so flipping the switches around one call cannot
 * leak into another request: nothing else runs until it returns.
 */
export function classifyV3Before(bars: V3Bar[], price?: number | null, lmc?: number | null, now?: Date): V3Result {
  // Every rule of 2026-11-15 off: the engine exactly as production runs it.
  const saved = { ...V3_RULES };
  const rules = V3_RULES as Record<string, boolean>;
  Object.keys(rules).forEach((k) => { rules[k] = false; });
  try {
    return classifyV3(bars, price, lmc, now);
  } finally {
    Object.assign(V3_RULES, saved);
  }
}

/**
 * Walk the window, then read the sentiment off the lines it ends holding.
 *
 * `live`: the price is a quote from the month AFTER the last complete bar, so
 * both lines are read one month on. A series whose price IS its last monthly
 * close (the embedded and Pink Sheet commodities) passes false.
 */
export function classifyV3(
  bars: V3Bar[], price?: number | null, lmc?: number | null, now?: Date, live = true,
): V3Result {
  const w = window5y(bars, now);
  const dt = w.map((b) => b.date);
  const c = w.map((b) => b.close);
  const empty: V3Result = {
    sentiment: "Josephine", note: "insufficient data",
    sell: null, buy: null, l1: null, l2: null, h1: null, h2: null, events: [],
  };
  if (c.length < 12) return empty;
  const p = price != null ? price : c[c.length - 1];
  // THE CURRENT MONTH IS THE FINAL BAR, its close the live price — as it is on
  // the chart. Before the month-label fix of 2026-11-07 the in-progress bar
  // carried last month's label and was never dropped, so this is how the engine
  // ran when Doug qualified it; the fix left every reading a month behind
  // (PMGOLD: "should have just moved from watch to buy"). It lets the last
  // COMPLETE month be an anchor — his SYL, COL and LHGG L2 at Oct-26, HLI H2 at
  // Oct-26 — lets the current bar confirm a peak or cut a line, and reads both
  // lines at the current month. The window still starts five years before the
  // last complete month.
  const curBar = live && V3_RULES.readAtCurrentMonth;
  if (curBar) {
    const last = dt[dt.length - 1];
    const y = parseInt(last.slice(0, 4), 10), m = parseInt(last.slice(5, 7), 10);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    dt.push(`${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`);
    c.push(p);
  }
  const n = c.length;
  const { pk } = pivots(c);

  let out = walk(c, dt, pk, n);
  if (out.sell == null) {
    // The walk ended with nothing drawable. Retry allowing rule 6's L1 advance
    // on a first draw too — on ASH, "this is the problem when drawing these
    // lines historically as we can now see that trough with L2." Once L1 reaches
    // ASH's global low 2024-10 0.165 no L2 exists from there, but from 2025-07
    // 0.170 one does. It cannot fire mid-walk, so it is a terminal retry.
    const r = walk(c, dt, pk, n, true);
    if (r.sell != null) out = r;
  }

  const anchor = (i: number): V3Anchor => ({ date: dt[i], close: c[i] });

  if (out.sell == null) {
    return {
      sentiment: "Sell", note: "falling knife — no sell line drawable",
      sell: null, buy: null, l1: null, l2: null, h1: null, h2: null,
      events: out.events,
    };
  }

  const asOf = n - 1;
  const sellNow = rayAt(c, out.sell[0], out.sell[1], asOf);
  // The buy ray is FLOORED AT ZERO. A long-decayed declining ray extrapolates
  // below zero — copper reported -417 — which is meaningless to display and, in
  // principle, lets the Watch test be skipped by a line that is not really
  // there. Flooring changes no verdict (price is above zero either way) but
  // keeps the reported number sane. A buy line of exactly 0 means "decayed
  // away", not "a line at zero".
  const buyNow = out.buy != null
    ? Math.max(0, rayAt(c, out.buy[0], out.buy[1], asOf))
    : null;

  // A FALLING KNIFE. The walk ended on a safety net — no line that passes the
  // 8% test — and no line that does pass it can stand under the price either.
  // "It should read as a sell, no matter the buy line. It's basically a trap."
  // The net is not reported as a sell line: there is none.
  //
  // The one stock a net still carries is a HOLDING that is not falling: its
  // five-year low came before its five-year high and it is 8% clear of that
  // low. That is the net as he drew it for MTS — "so we have some safety net" —
  // and it is what keeps SKT, on a net from a staircase of sub-8% lows and at a
  // five-year high, from being called a falling knife.
  const netFails: boolean = out.isNet && c[out.sell[1]] < c[out.sell[0]] * (1 + SEP);
  if (V3_RULES.fallingKnife && netFails && !lineUnder(c, asOf, asOf, p)) {
    let lo = 1;
    for (let i = 1; i < asOf; i++) if (c[i] <= c[lo]) lo = i;
    let hi = 0;
    for (let i = 0; i < n; i++) if (c[i] >= c[hi]) hi = i;
    const bar: number = c[lo] * (1 + SEP);
    let lifted = false;
    for (let k = lo + 1; k < asOf && !lifted; k++) if (c[k] >= bar) lifted = true;
    const falling: boolean = lo > hi;
    const atLow: boolean = p < bar || !lifted;
    if (out.state !== "long" || falling || atLow) {
      return {
        sentiment: "Sell", note: "falling knife — no sell line passes the 8% test",
        // l1/l2 are the anchors of the line that FAILS the 8% test, for the
        // chart; `sell` stays null — there is no sell line.
        sell: null, buy: buyNow, l1: anchor(out.sell[0]), l2: anchor(out.sell[1]),
        h1: out.buy != null ? anchor(out.buy[0]) : null,
        h2: out.buy != null ? anchor(out.buy[1]) : null,
        events: out.events, net: false, forming: false, knife: true,
      };
    }
  }

  // A HOLDING whose sell line is still being formed is not sold by it — rule
  // 10, "the stock would have been in a buy signal until both L1 and L2 are
  // established". At month end a close under a forming line only moves L2 on,
  // so calling it a sell mid-month contradicts the walk. CCP is the case: held,
  // its line L1 May-26 -> L2 Sep-26 never yet confirmed, price 15.30 under the
  // line's November level of 15.77. Until the line is established the holding
  // stands on its safety net, and only a price under THAT is a sell.
  const forming = out.state === "long" && !out.confirmed && !out.isNet &&
    V3_RULES.safetyNet && p < sellNow;
  let underNet = false;
  if (forming) {
    // With no net to draw at all — the low is the latest bar — a falling knife.
    const nl = netLine(c, curBar ? n - 1 : n);
    underNet = nl == null || p < rayAt(c, nl[0], nl[1], asOf);
  }

  let sentiment: V3Result["sentiment"];
  let note: string;
  if (p < sellNow && (!forming || underNet)) {
    sentiment = "Sell";
    note = `below sell line ${sellNow.toFixed(3)}`;
  } else if (buyNow != null && p < buyNow) {
    // WATCH — between the two lines. His words: "we can call these stocks that
    // currently sit between an existing buy and sell line 'Watch' because they
    // are not a sell nor a buy." FRI and HMY are both this case.
    sentiment = "Watch";
    note = `between the lines, ${sellNow.toFixed(3)}-${buyNow.toFixed(3)}`;
  } else if (out.state !== "long" && !(buyNow == null || buyNow <= sellNow)) {
    // The "out" state holds a stock out only while a LIVE buy line stands over
    // it. A ray decayed to or below the sell line — or no buy line at all — is
    // not overhead resistance. Doug, 2026-10-08: "the decayed lines are
    // correct". So position state cannot be what makes a stock a Sell while
    // price sits ABOVE its sell line; that reading is never legitimate.
    //
    // His two cases: COL at 23.19 over a 22.14 sell line with a buy line of 0,
    // crossed back in 2024, still reading Sell; EDU at 0.98 over 0.34. Both
    // read Josephine once a dead line stops standing in for resistance it no
    // longer provides. Across HQ's 326 this releases 18 and takes "Sell while
    // above the sell line" from 18 to zero.
    //
    // Deliberately a READ-side rule, NOT a change to the walk's entry test:
    // moving the BUY event itself (threshold = max(buy, sell)) fires it
    // earlier, re-freezes H1, and cost HZN both of its anchors.
    sentiment = "Sell";
    note = "sell signal in force, no buy since";
  } else if (lmc != null && p < lmc) {
    sentiment = "Josephine";
    note = `below last month close ${lmc.toFixed(3)}`;
  } else {
    sentiment = "Buy";
    note = "above the sell line";
  }

  return {
    sentiment, note,
    sell: sellNow,
    buy: buyNow,
    l1: anchor(out.sell[0]),
    l2: anchor(out.sell[1]),
    h1: out.buy != null ? anchor(out.buy[0]) : null,
    h2: out.buy != null ? anchor(out.buy[1]) : null,
    events: out.events,
    // Reported only where the 8% really is waived: a net that has walked onto
    // a line 8% clear of its L1 passes the test like any other.
    net: V3_RULES.fallingKnife ? netFails : out.isNet,
    forming: forming && !underNet,
    knife: false,
  };
}
