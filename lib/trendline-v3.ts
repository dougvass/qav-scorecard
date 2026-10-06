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
}

/** 8% separation, measured off the lower of the two prices. */
export const SEP = 0.08;

const EPS = 1e-9;

/**
 * Five years back from the last COMPLETE month, inclusive.
 *
 * `now` is injectable so tests do not depend on the clock.
 */
export function window5y(bars: V3Bar[], now?: Date): V3Bar[] {
  const d = now ?? new Date();
  const cur = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
): [number, number] | null {
  const n = c.length;
  if (n < 3) return null;
  let l1 = l1In ?? -1;
  if (l1 < 0) {
    l1 = 1;
    for (let i = 1; i < n - 1; i++) if (c[i] < c[l1]) l1 = i;
  }
  const floor = Math.max(l1, after ?? 0);

  // Rule 5: prefer the LAST candidate with no forward cut. The forward-cut test
  // SELECTS L2; it cannot be absolute, because a stock trading below its sell
  // line has a close under the ray after L2 by definition — that cut IS the sell
  // signal. So fall back to the last candidate clearing 8% with no backwards
  // cut. Without the fallback PLS, ASX and CCP lose the lines he confirmed.
  let fallback = -1;
  for (let l2 = n - 2; l2 > floor; l2--) {
    if (c[l2] < c[l1] * (1 + SEP)) continue;
    const g = (c[l2] - c[l1]) / (l2 - l1);
    let backCut = false;
    for (let k = l1 + 1; k < l2; k++) {
      if (c[k] < c[l1] + g * (k - l1) - EPS) { backCut = true; break; }
    }
    if (backCut) continue;
    if (fallback < 0) fallback = l2;
    let fwdCut = false;
    for (let k = l2 + 1; k < n; k++) {
      if (c[k] < c[l1] + g * (k - l1) - EPS) { fwdCut = true; break; }
    }
    if (fwdCut) continue;
    return [l1, l2];
  }
  if (fallback >= 0) return [l1, fallback];

  // Rule 6: L1 steps forward, but only in response to a break.
  if (advance && l1 + 1 < n - 1) return sellLine(c, l1 + 1, after, true);
  return null;
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
 */
export function buyLine(
  c: number[],
  pk: number[],
  upto: number,
  aboveAt?: number | null,
): [number, number, number | null] | null {
  const avail = pk.filter((i) => i < upto);
  if (avail.length < 2) return null;

  let top = avail[0];
  for (let i = 0; i < avail.length; i++) if (c[avail[i]] > c[top]) top = avail[i];
  // Rule 7, with rule 3's convention: a peak is part of the flat top when the
  // top is less than 8% above IT. Measured the other way round, S32's 2025-12
  // 4.62 looks 7.97% below the top 5.02, joins the band, becomes H1 and kills
  // the line; off its own price it is 8.66% away and is correctly excluded,
  // leaving H1 2022-04 5.00 — the H1 he confirmed.
  let h1 = top;
  for (let i = 0; i < avail.length; i++) {
    const j = avail[i];
    if (c[top] < c[j] * (1 + SEP) && j > h1) h1 = j;
  }

  // Rule 8: the LATEST qualifying peak. The earliest gave FRI H2 2024-09 and a
  // ray decayed to -0.125, which was then rejected and left no buy line at all;
  // his H2 2025-10 is the last that qualifies and gives 0.824.
  for (let x = avail.length - 1; x >= 0; x--) {
    const h2 = avail[x];
    if (h2 <= h1) continue;
    if (c[h1] < c[h2] * (1 + SEP)) continue;
    const g = (c[h2] - c[h1]) / (h2 - h1);
    let over = false;
    for (let k = h1 + 1; k < h2; k++) {
      if (c[k] > c[h1] + g * (k - h1) + EPS) { over = true; break; }
    }
    if (over) continue;
    if (aboveAt != null) {
      if (h2 >= aboveAt) continue;
      if (c[aboveAt] >= c[h1] + g * (aboveAt - h1)) continue;
    }
    let cut: number | null = null;
    for (let k = h2 + 1; k < c.length; k++) {
      if (c[k] > c[h1] + g * (k - h1)) { cut = k; break; }
    }
    return [h1, h2, cut];
  }
  return null;
}

interface WalkOut {
  sell: [number, number] | null;
  buy: [number, number] | null;
  state: "long" | "out" | null;
  events: V3Event[];
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
  let buy: [number, number] | null = null;
  let state: "long" | "out" | null = null;
  const events: V3Event[] = [];

  for (let t = 2; t < n; t++) {
    if (sell == null) {
      sell = sellLine(c, null, null, advanceFirst);
      confirmed = false;
    }

    if (sell != null) {
      const l1 = sell[0];
      const l2 = sell[1];
      const v = rayAt(c, l1, l2, t);
      if (t > l2) {
        // Rule 10. A line price has not confirmed is still being FORMED, not in
        // force: a close below it advances L2 and emits nothing. That walks
        // HMY's L2 from 2023-09 to 2023-12 in silence, confirms at 2024-01
        // (0.480 over a 0.417 line) and fires the sell at 2024-03 — his
        // 2024-04, one month out because TradingView labels a monthly close
        // with the first of the following month. Without this every formation
        // break is a sell signal and the buy signals between them thrash:
        // HMY fired seven flips in nine months.
        if (!(confirmed && state === "long")) {
          if (c[t] > v) {
            confirmed = true;
            if (state == null) state = "long";
          } else if (c[t] < v && t < n - 1) {
            // At the final bar nothing re-anchors; the line stands as drawn.
            const nxt: [number, number] | null =
              c[t] >= c[l1] * (1 + SEP) ? [l1, t] : sellLine(c, l1, t, true);
            if (nxt != null) {
              sell = nxt;
            } else {
              // Nothing can be re-anchored: price has fallen clean away and the
              // line is DEAD, not merely broken. Keeping it left ASH on a line
              // rising to 0.998 while the stock traded at 0.305. Dropping it
              // lets the walk rebuild from the new lows, which is how his ASH
              // L1 2025-07 0.170 is reached.
              sell = null;
              confirmed = false;
            }
          }
        } else if (state === "long" && c[t] < v) {
          events.push({ kind: "SELL", date: dt[t] });
          state = "out";
          if (t < n - 1) {
            sell = c[t] >= c[l1] * (1 + SEP) ? [l1, t] : sellLine(c, l1, t, true);
          }
          confirmed = false;
        }
      }
    }

    // Rule 11: kept current every month, in or out, but only REPLACED when a
    // new line is drawable. He asked of HMY "why is there no buy line above?" —
    // the walk had frozen it at H2 2025-01 0.63 from the 2025-03 buy and never
    // looked again. Signals are still read only while out, below.
    const b = buyLine(c, pk, t, t);
    if (b != null) buy = [b[0], b[1]];

    if (state !== "long" && buy != null) {
      const h1 = buy[0];
      const h2 = buy[1];
      const bv = rayAt(c, h1, h2, t);
      // Rule 12. On HMY this rejects 2024-08 (ray 0.366 against a sell line of
      // 0.370) and 2024-10 (0.333 against 0.377) while admitting his 2025-06
      // buy, where the ray is 0.574 over a sell line at 0.563.
      let over = true;
      if (sell != null) over = bv > rayAt(c, sell[0], sell[1], t);
      if (t > h2 && c[t] > bv && over) {
        events.push({ kind: "BUY", date: dt[t] });
        state = "long";
      }
    }
  }

  return { sell, buy, state, events };
}

/** Walk the window, then read the sentiment off the lines it ends holding. */
export function classifyV3(bars: V3Bar[], price?: number | null, lmc?: number | null, now?: Date): V3Result {
  const w = window5y(bars, now);
  const dt = w.map((b) => b.date);
  const c = w.map((b) => b.close);
  const empty: V3Result = {
    sentiment: "Josephine", note: "insufficient data",
    sell: null, buy: null, l1: null, l2: null, h1: null, h2: null, events: [],
  };
  if (c.length < 12) return empty;
  const p = price != null ? price : c[c.length - 1];
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

  const sellNow = rayAt(c, out.sell[0], out.sell[1], n - 1);
  const buyNow = out.buy != null ? rayAt(c, out.buy[0], out.buy[1], n - 1) : null;

  let sentiment: V3Result["sentiment"];
  let note: string;
  if (p < sellNow) {
    sentiment = "Sell";
    note = `below sell line ${sellNow.toFixed(3)}`;
  } else if (buyNow != null && p < buyNow) {
    // WATCH — between the two lines. His words: "we can call these stocks that
    // currently sit between an existing buy and sell line 'Watch' because they
    // are not a sell nor a buy." FRI and HMY are both this case.
    sentiment = "Watch";
    note = `between the lines, ${sellNow.toFixed(3)}-${buyNow.toFixed(3)}`;
  } else if (out.state !== "long") {
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
  };
}
