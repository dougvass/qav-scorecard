/**
 * Where a company's revenue actually comes from — reviewed, not assumed.
 *
 * Doug, 2026-11-22: "each stock held isn't necessarily assigned to a GICS code
 * that reflects their main revenue stream ... The rule would effectively be if
 * gold becomes a sell, any stock that has majority revenue from gold should be
 * sold. Note only needed for my holdings not the whole universe."
 *
 * GICS files a mining contractor under Capital Goods. Its results presentation
 * says three quarters of its revenue is earned on gold mines. The commodity
 * rule has to follow the second fact, so a review records the revenue mix the
 * company itself publishes, with the document and page it was read from
 * (/api/revenue-mix fetches the passages).
 *
 * THE RULE. A reviewed stock is governed by a commodity only when that
 * commodity is the MAJORITY of its revenue — strictly more than half, his
 * word. A reviewed stock with no majority is governed by none, even if the
 * sector map (STOCK_COMMODITY) names one. A stock nobody has reviewed falls
 * back to the sector map exactly as before, so nothing changes for the rest of
 * the universe.
 *
 * WHERE THE REVIEWS LIVE. In the browser's store, mirrored to the server behind
 * the passcode like the holdings list — NOT in this file. This repository is
 * public, and a list of exactly the stocks someone asked to have reviewed is a
 * list of what they hold.
 *
 * This file is pure: no storage, so the server's alert job can import it. The
 * browser's load and save are in lib/exposure-storage.ts.
 */

import { COMMODITIES, STOCK_COMMODITY } from "./commodities";

export const EXPOSURE_STORAGE_KEY = "qav_exposure_v1";

/** "Majority" — strictly more than this share of revenue. */
export const MAJORITY_PCT = 50;

export interface RevenueSlice {
  /** As the company labels it: "Gold", "Met coal", "Civil infrastructure". */
  label: string;
  /** The tracked commodity it maps to, or null when it is not one we read. */
  key: string | null;
  /** Percent of revenue. */
  pct: number;
}

export interface RevenueReview {
  slices: RevenueSlice[];
  /** The period the split is for: "FY26". */
  period: string;
  /** The document and page: "FY26 Results Presentation, p24". */
  source: string;
  /** What the business does, in a few words. */
  business: string;
  /** ISO date the review was made. */
  reviewed: string;
}

export interface StoredExposure {
  timestamp: string | null;
  reviews: Record<string, RevenueReview>;
}

/**
 * A label -> tracked commodity. Anchored on purpose: "Met coal" and
 * "Copper/gold" are NOT the commodities we hold a series for (the coal series
 * is Australian thermal coal), so they stay unmapped rather than borrow a
 * reading that is not theirs.
 */
const LABEL_KEYS: [RegExp, string][] = [
  [/^gold$/i, "GOLD"],
  [/^silver$/i, "SILVER"],
  [/^copper$/i, "COPPER"],
  [/^(oil|crude oil|oil \(wti\)|wti)$/i, "OIL"],
  [/^brent$/i, "BRENT"],
  [/^(nat(ural)? ?gas|gas|lng)$/i, "NATGAS"],
  [/^alumin(i)?um$|^alumina$/i, "ALUMINIUM"],
  [/^platinum$/i, "PLATINUM"],
  [/^palladium$/i, "PALLADIUM"],
  [/^uranium$/i, "URANIUM"],
  [/^iron ?ore$/i, "IRONORE"],
  [/^(thermal )?coal$/i, "COAL"],
  [/^nickel$/i, "NICKEL"],
  [/^lithium$/i, "LITHIUM"],
];

export function keyForLabel(label: string): string | null {
  const t = label.trim();
  for (const [re, key] of LABEL_KEYS) if (re.test(t)) return key;
  return null;
}

/**
 * "Gold 76, Copper 8, Iron ore 4, Lithium <1, Other 8" -> slices.
 * Each part is a label followed by its percentage; "<1" reads as 0.5.
 */
export function parseMix(text: string): RevenueSlice[] {
  const out: RevenueSlice[] = [];
  for (const part of text.split(/[,;]+/)) {
    const m = part.trim().match(/^(.*?)[\s:]*(<)?\s*~?\s*(\d+(?:\.\d+)?)\s*%?$/);
    if (!m) continue;
    const label = m[1].trim();
    if (!label) continue;
    const pct = m[2] ? Math.min(0.5, parseFloat(m[3])) : parseFloat(m[3]);
    if (!isFinite(pct) || pct < 0 || pct > 100) continue;
    out.push({ label, key: keyForLabel(label), pct });
  }
  return out;
}

export function formatMix(slices: RevenueSlice[]): string {
  return slices.map((s) => `${s.label} ${s.pct < 1 && s.pct > 0 ? "<1" : String(s.pct)}`).join(", ");
}

/**
 * One review per line, the form the editor shows and accepts:
 *   CODE | Gold 76, Copper 8, Other 16 | FY26 | FY26 Results Presentation, p24 | Contract mining
 * A line with no mix records "reviewed, and no commodity drives it".
 */
export function parseReviewLines(text: string, today: string): { reviews: Record<string, RevenueReview>; rejected: string[] } {
  const reviews: Record<string, RevenueReview> = {};
  const rejected: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split("|").map((x) => x.trim());
    const code = (f[0] ?? "").toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code) || f.length < 2) { rejected.push(line.slice(0, 40)); continue; }
    reviews[code] = {
      slices: parseMix(f[1] ?? ""),
      period: f[2] ?? "",
      source: f[3] ?? "",
      business: f[4] ?? "",
      reviewed: today,
    };
  }
  return { reviews, rejected };
}

export function formatReviewLines(reviews: Record<string, RevenueReview>): string {
  return Object.keys(reviews).sort().map((code) => {
    const r = reviews[code];
    return [code, formatMix(r.slices), r.period, r.source, r.business].join(" | ");
  }).join("\n");
}

/** Revenue share by tracked commodity, largest first. */
export function commodityShares(review: RevenueReview): { key: string; pct: number }[] {
  const by = new Map<string, number>();
  for (const s of review.slices) if (s.key) by.set(s.key, (by.get(s.key) ?? 0) + s.pct);
  return Array.from(by, ([key, pct]) => ({ key, pct })).sort((a, b) => b.pct - a.pct);
}

/** The commodity that is more than half of revenue, if there is one. */
export function majorityCommodity(review: RevenueReview): { key: string; pct: number } | null {
  const top = commodityShares(review)[0];
  return top && top.pct > MAJORITY_PCT ? top : null;
}

/**
 * The commodity whose Sell makes this stock a sell.
 * Reviewed: its majority commodity, or none. Not reviewed: the sector map.
 */
export function gateCommodity(code: string, exposure: StoredExposure | null): string | null {
  const review = exposure?.reviews[code];
  if (review) return majorityCommodity(review)?.key ?? null;
  return STOCK_COMMODITY[code] ?? null;
}

/** Every stock a commodity governs, reviews applied over the sector map. */
export function stocksGovernedBy(key: string, exposure: StoredExposure | null): string[] {
  const codes = new Set<string>(Object.keys(STOCK_COMMODITY));
  for (const c of Object.keys(exposure?.reviews ?? {})) codes.add(c);
  return Array.from(codes).filter((c) => gateCommodity(c, exposure) === key).sort();
}

export function commodityLabel(key: string): string {
  const def = COMMODITIES.find((c) => c.key === key);
  return def ? def.label + (def.proxy ? "*" : "") : key;
}
