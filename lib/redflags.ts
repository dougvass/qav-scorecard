/**
 * Red flags — the Bible's two "stop" checks that are not scores.
 *
 * COLUMN AR — "Does it have a qualified audit?" (ep. 318)
 *   Tony: "We have to go to the financial statements ... and make sure there is
 *   no mention of an audit [qualification] ... If they do have an audit, then
 *   it's an immediate stop for us." The source document is the Appendix 4E,
 *   which carries a MANDATORY item under Listing Rule 4.3A — "Details of
 *   audit/review dispute or qualification (if any)" — so that one line is the
 *   whole signal and there is no need to read an annual report.
 *
 *   What counts, from auditor James Oliver in ep. 426: the three modified
 *   opinions (QUALIFIED, which reads "except for"; ADVERSE; DISCLAIMER), plus
 *   two that are not modifications but that Tony still treats as flags — the
 *   EMPHASIS OF MATTER paragraph and MATERIAL UNCERTAINTY RELATED TO GOING
 *   CONCERN.
 *
 * SECTION F — Corporate Governance Red Flags, "The Mill Rule" (added 2025-04-01)
 *   "In the event of one of the following, we will sell a stock if we own it:
 *    - Failure of the company to provide Continuous Disclosure in a timely
 *      manner (eg warning the market during Confession Season if their results
 *      aren't going to match expectations)
 *    - Failure to get financial reports published on time
 *    - CEO sells stock before bad results are published
 *    We will only remove the red flag when we determine they have fixed the
 *    issue." And p.749: "If a company has breached any of these, we'll red flag
 *    them like a qualified audit."
 *
 * Both are MARKERS, not gates — Doug, 2026-10-08: "Hopefully it could then just
 * be added as a 'Red flag' on a stock in the list rather than use as a gate."
 * The Bible's own buy-step list treats them as filters a human applies, and the
 * Mill Rule's "until they have fixed the issue" needs a judgement nothing here
 * can make. So we surface the finding and its date; Doug decides.
 */

export const REDFLAG_STORAGE_KEY = "qav_redflags_v1";

export type AuditStatus = "clean" | "flag" | "unknown" | "no filing" | "error";

export interface GovernanceHit {
  /** "disclosure" = an ASX query/aware letter; "late" = report lodged late. */
  kind: "disclosure" | "late";
  date: string;
  detail: string;
}

export interface RedFlagEntry {
  audit: AuditStatus;
  /** Plain-English reason, e.g. "qualified opinion" or "unmodified / no dispute". */
  auditReason?: string;
  /** Severity 3 adverse/disclaimer, 2 qualified, 1 emphasis / going concern. */
  auditSeverity?: number;
  /** The Appendix the reading came from, so a call can be checked by hand. */
  auditSource?: { headline: string; date: string; url: string };
  governance: GovernanceHit[];
  checkedAt: string;
}

export interface StoredRedFlags {
  timestamp: string;
  data: Record<string, RedFlagEntry>;
}

/** Does this stock carry a red flag worth showing? */
export function hasRedFlag(e: RedFlagEntry | undefined): boolean {
  if (!e) return false;
  return e.audit === "flag" || e.governance.length > 0;
}

export function redFlagSummary(e: RedFlagEntry | undefined): string {
  if (!e) return "";
  const bits: string[] = [];
  if (e.audit === "flag") bits.push(`Audit: ${e.auditReason ?? "qualified"}`);
  for (const g of e.governance) {
    bits.push(`${g.kind === "late" ? "Late report" : "Continuous disclosure"} (${g.date}): ${g.detail}`);
  }
  return bits.join("\n");
}

// ── Audit classification ────────────────────────────────────────────────────
//
// Three traps, every one of them hit on a real filing. Change nothing here
// without re-reading them:
//
//  1. NEGATION — the CLEAN wording CONTAINS the flag words. EDU's Appendix 4D
//     says the report "is NOT subject to a modified conclusion, an emphasis of
//     matter paragraph". A naive matcher flags every clean filing. Note too
//     that /modified/ matches inside "unmodified", hence the (?<!un).
//  2. THE WRONG "audit" — the first occurrence is usually "unaudited EBITDA",
//     "non-audit services", or the Audit & Risk Committee.
//  3. BOILERPLATE — a bundled "4E and Annual Report" carries the standard ASA
//     570 text, "Conclude on the appropriateness of the directors' use of the
//     going concern basis", in EVERY audit report. That produced a FALSE FLAG
//     on LAU. Hence: prefer the smallest Appendix, and read only its front
//     pages, where the 4E cover sits.

/** Standardised Appendix 4E/4D item headings, most specific first. */
const HEADINGS = [
  /details\s+of\s+audit\s*\/?\s*review\s+dispute\s+or\s+qualification[^:]{0,40}:/i,
  /audit\s*\/?\s*review\s+dispute\s+or\s+qualification[^:]{0,40}:/i,
  /audit\s+qualification\s+or\s+review\b/i,
  /audit\s+dispute\s+or\s+qualification\b/i,
  /\baudit\s*\/?\s*review\s+status\b/i,
];

const NOT_THE_ITEM =
  /unaudited|non-?audit|audit\s*(committee|&|and)\s*risk|audit\s+committee|auditor'?s?\s+(independence|remuneration|fees)|internal\s+audit|audit\s+fees/i;

const ABOUT_OPINION =
  /opinion|conclusion|qualificat|dispute|modified|emphasis|going\s+concern|has\s+been\s+audited|been\s+reviewed|review\s+report|audit\s+report/i;

const FLAGS: [RegExp, string, number][] = [
  [/\badverse\s+(opinion|conclusion)/i,                      "adverse opinion",        3],
  [/\bdisclaimer\s+of\s+(opinion|conclusion)/i,              "disclaimer of opinion",  3],
  [/(?<!un)\bqualified\s+(opinion|conclusion)/i,             "qualified opinion",      2],
  [/(?<!un)\bmodified\s+(opinion|conclusion)/i,              "modified opinion",       2],
  [/\bexcept\s+for\b/i,                                      "'except for'",           2],
  [/material\s+uncertaint(y|ies)[^.]{0,80}going\s+concern/i, "going concern",          1],
  [/going\s+concern[^.]{0,80}material\s+uncertaint(y|ies)/i, "going concern",          1],
  [/\bemphasis\s+of\s+matter/i,                              "emphasis of matter",     1],
  [/\bis\s+subject\s+to\s+(a\s+)?(dispute|qualification)/i,  "audit dispute",          2],
];

const NEG = /\b(not|no|nor|without|unlikely|free\s+from)\b/i;

/**
 * The standard CLEAN conclusions, verbatim from the auditing standards. Adding
 * wordings here is SAFE: FLAGS are evaluated first, so a qualified, adverse or
 * disclaimed report is caught before any of these can match.
 */
const CLEAN =
  /not\s+become\s+aware\s+of\s+any\s+matter|giving\s+a\s+true\s+and\s+fair\s+view|true\s+and\s+fair\s+view|subject\s+to\s+(a\s+)?review\s+by\s+the\s+auditor|review\s+report\s+is\s+attached|\bun(modified|qualified)\s+(opinion|conclusion)|not\s+subject\s+to\s+(an?\s+)?(modified|qualified|emphasis)|\bno\s+(audit\s*\/?\s*review\s+)?(dispute|qualification)|\bnot\s+applicable\b|\bnone\b|\bnil\b|unlikely\s+to\s+be\s+the\s+subject\s+of\s+(dispute|qualification)/i;

/** A present item that discloses nothing is still the clean answer — it is a
 *  mandatory disclosure, so silence is meaningful. */
const AUDITED =
  /\b(has|have|was|were)\s+been?\s*(audited|reviewed)|audited\s+financial|auditor'?s?\s+report\s+is\s+(included|attached)|accounts\s+have\s+been\s+audited/i;

function findSection(text: string): string | null {
  for (const re of HEADINGS) {
    const m = re.exec(text);
    if (m) return text.slice(m.index + m[0].length, m.index + m[0].length + 1000);
  }
  // No standard heading: scan every "audit", drop the known false contexts, and
  // keep whichever one actually discusses an opinion.
  let best: { score: number; at: number } | null = null;
  const scan = /\baudit/gi;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + 90);
    if (NOT_THE_ITEM.test(ctx)) continue;
    const window = text.slice(m.index, m.index + 700);
    const score = (window.match(new RegExp(ABOUT_OPINION.source, "gi")) ?? []).length;
    if (score > 0 && (best == null || score > best.score)) best = { score, at: m.index };
  }
  return best ? text.slice(best.at, best.at + 1000) : null;
}

export function classifyAudit(text: string): {
  status: AuditStatus; reason: string; severity?: number; section?: string;
} {
  const body = findSection(text);
  if (body == null) return { status: "unknown", reason: "no audit item found in the Appendix" };
  const flat = body.replace(/\s+/g, " ").trim();

  const hits: [number, string][] = [];
  for (const [re, label, sev] of FLAGS) {
    const g = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = g.exec(flat)) !== null) {
      if (NEG.test(flat.slice(Math.max(0, m.index - 90), m.index))) continue; // trap 1
      hits.push([sev, label]);
    }
  }
  if (hits.length) {
    hits.sort((a, b) => b[0] - a[0]);
    const labels = Array.from(new Set(hits.map((h) => h[1])));
    return { status: "flag", severity: hits[0][0], reason: labels.join(", "), section: flat.slice(0, 400) };
  }
  if (CLEAN.test(flat)) return { status: "clean", reason: "unmodified / no dispute", section: flat.slice(0, 400) };
  if (AUDITED.test(flat)) return { status: "clean", reason: "audited, no qualification disclosed", section: flat.slice(0, 400) };
  return { status: "unknown", reason: "audit item found but wording not recognised", section: flat.slice(0, 400) };
}

// ── Governance (Mill Rule) from announcement metadata ───────────────────────

/**
 * An ASX query is the regulator asking why the market was not told something —
 * the Mill Rule's first trigger. CCX is the live example: "Response to ASX
 * Aware Query-earnings surprise".
 */
const DISCLOSURE_QUERY =
  /aware\s+(query|letter)|price\s+(and|&)\s+volume\s+query|asx\s+price\s+query|\basx\s+query\b|response\s+to\s+asx\b|speeding\s+ticket|lr\s*15\.7/i;

/**
 * A COMPLIANCE suspension, i.e. the company failed to lodge. Deliberately
 * narrow: "Suspension of Dividend Reinvestment Plan" (SUL) is not a trading
 * suspension at all, and a VOLUNTARY suspension (AQZ) is normally pending an
 * announcement rather than a failure, so neither counts.
 */
const COMPLIANCE_SUSPENSION =
  /(failure\s+to\s+lodge|late\s+lodg|non[- ]?lodg)|suspension\s+from\s+(official\s+)?quotation[^.]{0,80}(lodg|compliance|periodic)/i;
const NOT_A_SUSPENSION = /dividend|voluntary|trading\s+halt/i;

export function governanceHits(
  items: { headline: string; types: string[]; date: string }[],
  sinceIso: string,
): GovernanceHit[] {
  const out: GovernanceHit[] = [];
  for (const it of items) {
    if (it.date < sinceIso) continue;
    const blob = `${it.headline} | ${it.types.join(" ")}`;
    if (DISCLOSURE_QUERY.test(blob)) {
      out.push({ kind: "disclosure", date: it.date.slice(0, 10), detail: it.headline });
    } else if (COMPLIANCE_SUSPENSION.test(blob) && !NOT_A_SUSPENSION.test(blob)) {
      out.push({ kind: "late", date: it.date.slice(0, 10), detail: it.headline });
    }
  }
  return out;
}

/**
 * "Failure to get financial reports published on time", computed rather than
 * pattern-matched. ASX Listing Rule 4.3A gives a company TWO MONTHS after the
 * balance date to lodge the Appendix 4E (and 4D for a half year). A lodgement
 * after that is late on the face of it.
 *
 * `balanceDate` comes from the CSV's "Last Period Analysed", which is the
 * RESULTS date rather than the announcement date — the distinction the Bible
 * warns about for Column I.
 */
export function lateReport(balanceDate: string | null, lodgedIso: string | null): GovernanceHit | null {
  if (!balanceDate || !lodgedIso) return null;
  const bal = new Date(balanceDate);
  const lodged = new Date(lodgedIso);
  if (isNaN(bal.getTime()) || isNaN(lodged.getTime())) return null;
  const due = new Date(bal);
  due.setMonth(due.getMonth() + 2);
  if (lodged <= due) return null;
  const daysLate = Math.round((lodged.getTime() - due.getTime()) / 86_400_000);
  // One or two days is a weekend or a public holiday, not a governance breach.
  if (daysLate <= 3) return null;
  return {
    kind: "late",
    date: lodgedIso.slice(0, 10),
    detail: `Appendix lodged ${daysLate} days after the Listing Rule 4.3A deadline ` +
            `(balance date ${balanceDate.slice(0, 10)})`,
  };
}
