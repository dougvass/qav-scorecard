/**
 * Which holdings are a sell, why, and what has changed since the last look.
 * Pure — no network, no storage — so the same rule can be tested on its own
 * and run by the server job (lib/alerts-server.ts).
 *
 * Doug, 2026-11-22: "need a way to determine the impact of commodity prices or
 * other significant price moves to sell on my stock holdings. It needs to be
 * more than a gate it needs to flag and send me an email notification alert,
 * or even mobile SMS alert." Asked which, he chose: "Email only."
 *
 * A HOLDING IS A SELL WHEN
 *   - it is below its own 3PTL sell line (which includes the falling-knife
 *     gate), or
 *   - the commodity that is the majority of its revenue is a sell — see
 *     lib/revenue-exposure.ts for how that commodity is decided.
 * These are the same two tests the My Holdings tab applies. Watch and Josephine
 * are not sells and raise nothing.
 *
 * WHAT IS SENT. A message goes out when the picture CHANGES: a holding becomes
 * a sell, the reason it is a sell changes, or it stops being one. A holding
 * that was a sell yesterday for the same reason is listed under "still a sell"
 * in the next message that has news in it, and does not trigger one by itself,
 * so a sell he has decided to sit on does not arrive every evening.
 */

import { COMMODITIES } from "./commodities";
import { StoredExposure, gateCommodity, majorityCommodity, commodityLabel } from "./revenue-exposure";

export type Reading = "Bullish" | "Bearish" | "Josephine" | "Watch";

/** The engine says Buy/Sell; the stores say Bullish/Bearish. Accept both. */
export function toReading(s: unknown): Reading | null {
  switch (String(s ?? "").trim().toLowerCase()) {
    case "buy": case "bullish":   return "Bullish";
    case "sell": case "bearish":  return "Bearish";
    case "josephine":             return "Josephine";
    case "watch":                 return "Watch";
    default:                      return null;
  }
}

export interface TrendRead {
  sentiment: Reading | null;
  knife?: boolean;
  note?: string | null;
  price?: number | null;
  sell?: number | null;
}

export interface Verdict {
  code: string;
  sell: boolean;
  /** Why, in a form that compares: "line", "knife", "commodity:GOLD", joined by "+". */
  why: string;
  /** Why, in words — one sentence per cause. */
  reasons: string[];
  /** Its revenue mix has been reviewed (false = judged on the sector map). */
  reviewed: boolean;
  /** No 3PTL reading came back for it. */
  unread: boolean;
}

function money(n: number): string {
  return n >= 10 ? n.toFixed(2) : n >= 0.1 ? n.toFixed(3) : n.toFixed(4);
}

export function evaluateHoldings(
  codes: string[],
  trend: Record<string, TrendRead | undefined>,
  commodities: Record<string, Reading | null | undefined>,
  /** Commodities set by hand on the site — these win, and a proxy set by hand gates. */
  manual: Record<string, Reading | undefined>,
  exposure: StoredExposure | null,
): Verdict[] {
  return codes.map((code) => {
    const t = trend[code];
    const why: string[] = [];
    const reasons: string[] = [];

    if (t?.sentiment === "Bearish") {
      if (t.knife) {
        why.push("knife");
        reasons.push(t.note ? `a falling knife (${t.note.replace(/^falling knife\s*[—-]\s*/i, "")})` : "a falling knife");
      } else {
        why.push("line");
        reasons.push(
          typeof t.price === "number" && typeof t.sell === "number" && t.sell > 0
            ? `below its 3PTL sell line (${money(t.price)} against a line at ${money(t.sell)})`
            : "below its 3PTL sell line",
        );
      }
    }

    const review = exposure?.reviews[code];
    const key = gateCommodity(code, exposure);
    if (key) {
      const def = COMMODITIES.find((c) => c.key === key);
      const reading = manual[key] ?? commodities[key] ?? null;
      // A proxy commodity (lithium, read off an equity ETF) is advisory: its
      // automatic reading never gates. Set by hand, it does.
      const advisory = !!def?.proxy && manual[key] === undefined;
      if (reading === "Bearish" && !advisory) {
        const label = commodityLabel(key);
        why.push(`commodity:${key}`);
        const share = review ? majorityCommodity(review) : null;
        reasons.push(
          review && share
            ? `${label} is a sell and ${Math.round(share.pct)}% of its revenue is ${label.toLowerCase()} (${[review.period, review.source].filter(Boolean).join(", ")})`
            : `${label} is a sell (sector map; its revenue has not been reviewed)`,
        );
      }
    }

    return { code, sell: why.length > 0, why: why.join("+"), reasons, reviewed: !!review, unread: !t || t.sentiment === null };
  });
}

// ── What changed ─────────────────────────────────────────────────────────────

export interface StandingAlert { why: string; since: string; reasons: string[] }

export interface AlertState {
  /** Holdings that were a sell at the last run, by code. */
  alerts: Record<string, StandingAlert>;
  lastRun: string | null;
  lastSent: string | null;
  lastError: string | null;
}

export const EMPTY_STATE: AlertState = { alerts: {}, lastRun: null, lastSent: null, lastError: null };

export interface Change {
  /** Newly a sell, or a sell for a different reason than before. */
  fresh: Verdict[];
  /** Was a sell, still held, no longer one. */
  cleared: string[];
  /** A sell before and now, for the same reason. */
  standing: (Verdict & { since: string })[];
  next: Record<string, StandingAlert>;
}

export function diffAlerts(prev: AlertState, verdicts: Verdict[], today: string): Change {
  const fresh: Verdict[] = [];
  const standing: (Verdict & { since: string })[] = [];
  const cleared: string[] = [];
  const next: Record<string, StandingAlert> = {};
  for (const v of verdicts) {
    const was = prev.alerts[v.code];
    if (v.sell) {
      if (was && was.why === v.why) {
        standing.push({ ...v, since: was.since });
        next[v.code] = { why: v.why, since: was.since, reasons: v.reasons };
      } else {
        fresh.push(v);
        next[v.code] = { why: v.why, since: today, reasons: v.reasons };
      }
    } else if (was && !v.unread) {
      // Only a reading that says "not a sell" clears it. A holding whose
      // reading failed to arrive keeps its alert rather than appear to recover.
      cleared.push(v.code);
    } else if (was) {
      next[v.code] = was;
    }
  }
  return { fresh, cleared, standing, next };
}

// ── The message ──────────────────────────────────────────────────────────────

export interface Message { subject: string; text: string; html: string }

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sentence(v: { code: string; reasons: string[] }): string {
  return `${v.code} — ${v.reasons.join("; and ")}`;
}

export function renderMessage(change: Change, verdicts: Verdict[], siteUrl: string, asOf: string): Message {
  const { fresh, cleared, standing } = change;
  const notReviewed = verdicts.filter((v) => !v.reviewed).map((v) => v.code);
  const unread = verdicts.filter((v) => v.unread).map((v) => v.code);

  const subject = fresh.length
    ? `QAV sell alert: ${fresh.map((v) => v.code).join(", ")}`
    : `QAV: ${cleared.join(", ")} no longer a sell`;

  const lines: string[] = [];
  if (fresh.length) {
    lines.push(fresh.length === 1 ? "A holding has become a sell:" : `${fresh.length} holdings have become a sell:`);
    fresh.forEach((v) => lines.push(`  ${sentence(v)}`));
    lines.push("");
  }
  if (cleared.length) {
    lines.push(`No longer a sell: ${cleared.join(", ")}`);
    lines.push("");
  }
  if (standing.length) {
    lines.push("Still a sell:");
    standing.forEach((v) => lines.push(`  ${sentence(v)} (since ${v.since})`));
    lines.push("");
  }
  if (unread.length) lines.push(`No 3PTL reading came back for: ${unread.join(", ")}`);
  if (notReviewed.length) lines.push(`Revenue not reviewed, judged on the sector map: ${notReviewed.join(", ")}`);
  lines.push(`Checked ${asOf}. ${verdicts.length} holdings watched.`);
  lines.push(siteUrl);
  const text = lines.join("\n");

  const block = (title: string, items: string[]) =>
    items.length ? `<p style="margin:16px 0 4px"><b>${esc(title)}</b></p><ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  const html =
    `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#111">` +
    block(fresh.length === 1 ? "A holding has become a sell" : "Holdings that have become a sell", fresh.map(sentence)) +
    (cleared.length ? `<p style="margin:16px 0 4px"><b>No longer a sell:</b> ${esc(cleared.join(", "))}</p>` : "") +
    block("Still a sell", standing.map((v) => `${sentence(v)} (since ${v.since})`)) +
    `<p style="margin:16px 0 0;color:#555;font-size:13px">` +
    (unread.length ? `No 3PTL reading came back for: ${esc(unread.join(", "))}<br>` : "") +
    (notReviewed.length ? `Revenue not reviewed, judged on the sector map: ${esc(notReviewed.join(", "))}<br>` : "") +
    `Checked ${esc(asOf)}. ${verdicts.length} holdings watched. <a href="${esc(siteUrl)}">Open the scorecard</a></p></div>`;

  return { subject, text, html };
}
