/**
 * The portfolio you actually hold.
 *
 * Doug, 2026-10-08: "I need a way to track my existing portfolio ... 1. within
 * the buy list at any time if I already own a stock and 2. the list of stocks I
 * own and their current status because if they have broken a sell line then I
 * need to know and action it without having to check each one everday."
 *
 * So this stores codes, nothing more — no units, no cost base, no valuation.
 * Sharesight already does all of that properly; duplicating it here would mean
 * two sources of truth for the same numbers and a reconciliation problem nobody
 * asked for. What Sharesight does NOT do is tell you a holding has broken its
 * 3PTL sell line, and that is the whole point of this list.
 *
 * Codes live in localStorage, so they stay on this browser and never leave it.
 */

export const HOLDINGS_STORAGE_KEY = "qav_holdings_v1";

export interface StoredHoldings {
  /** ISO timestamp of the last edit. */
  timestamp: string | null;
  /** ASX codes, uppercased, de-duplicated, sorted. */
  codes: string[];
}

const EMPTY: StoredHoldings = { timestamp: null, codes: [] };

/** An ASX code: 3 letters usually, but 2-6 alphanumerics covers the long tail. */
const CODE_RE = /^[A-Z0-9]{2,6}$/;

/** Words a header row or a Sharesight export uses that are never stock codes. */
const NOT_A_CODE = new Set([
  "CODE", "SYMBOL", "TICKER", "STOCK", "SHARE", "NAME", "MARKET", "TOTAL",
  "QTY", "UNITS", "VALUE", "PRICE", "COST", "GAIN", "LOSS", "DIV", "YIELD",
  "ASX", "XASX", "NZX", "NASDAQ", "NYSE", "AU", "AUD", "USD", "NZD", "N/A",
  "SUM", "CASH", "DATE", "TYPE", "FEES", "BRUTO", "ID",
]);

/**
 * Pull ASX codes out of whatever the user pastes.
 *
 * Deliberately permissive, because the realistic inputs are a hand-typed list
 * ("BHP, CBA, WES"), a column copied out of a spreadsheet (one per line), or a
 * whole Sharesight CSV export pasted in. Rather than parse three formats, split
 * on every delimiter and keep the tokens that look like codes.
 *
 * Sharesight writes its codes as "BHP.AX" / "BHP.ASX" and prefixes some markets
 * as "ASX:BHP", so both shapes are unwrapped. Non-ASX holdings (AAPL.NASDAQ)
 * are dropped: there is no 3PTL reading for them here and a silent half-answer
 * would be worse than leaving them out.
 */
export function parseHoldings(text: string): { codes: string[]; skipped: string[] } {
  const codes = new Set<string>();
  const skipped = new Set<string>();
  for (const raw of text.split(/[\s,;|]+/)) {
    let t = raw.trim().toUpperCase().replace(/^["']|["']$/g, "");
    if (!t) continue;

    // "ASX:BHP" -> "BHP"
    const colon = t.match(/^([A-Z]+):([A-Z0-9]{2,6})$/);
    if (colon) {
      if (colon[1] !== "ASX") { skipped.add(t); continue; }
      t = colon[2];
    }

    // "BHP.AX" / "BHP.ASX" -> "BHP"; anything else suffixed is another market.
    const dot = t.match(/^([A-Z0-9]{2,6})\.([A-Z]+)$/);
    if (dot) {
      if (dot[2] !== "AX" && dot[2] !== "ASX") { skipped.add(t); continue; }
      t = dot[1];
    }

    if (!CODE_RE.test(t) || NOT_A_CODE.has(t)) continue;
    // A bare number is a quantity or a price, never a code.
    if (/^[0-9]+$/.test(t)) continue;
    codes.add(t);
  }
  return { codes: Array.from(codes).sort(), skipped: Array.from(skipped).sort() };
}

export function loadHoldings(): StoredHoldings {
  try {
    const raw = localStorage.getItem(HOLDINGS_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredHoldings>;
    if (!Array.isArray(parsed?.codes)) return EMPTY;
    return {
      timestamp: parsed.timestamp ?? null,
      codes: parsed.codes.filter((c) => typeof c === "string"),
    };
  } catch {
    // Private browsing, cleared site data, or a corrupted value — an empty
    // portfolio is the right fallback, never a thrown error on first paint.
    return EMPTY;
  }
}

export function saveHoldings(codes: string[]): StoredHoldings {
  const stored: StoredHoldings = {
    timestamp: new Date().toISOString(),
    codes: Array.from(new Set(codes.map((c) => c.toUpperCase()))).sort(),
  };
  try {
    localStorage.setItem(HOLDINGS_STORAGE_KEY, JSON.stringify(stored));
  } catch { /* nothing to do: the list is still live in memory for this session */ }
  return stored;
}

/**
 * Which held stocks need action.
 *
 * "Broken a sell line" is exactly the Bearish state — v3 reports Bearish only
 * when price sits below the sell line. Watch is NOT an alert: it is above the
 * sell line and below the buy line, which is the state Doug named "not a sell
 * nor a buy". Josephine is not one either; it is a one-month dip from a buy.
 */
export function isHoldingAlert(sentiment: string | null | undefined): boolean {
  return sentiment === "Bearish";
}
