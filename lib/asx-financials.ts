/**
 * Scoring a stock from its own ASX report when Stock Doctor is a period behind.
 *
 * Doug, 2026-11-14: "lets add our own work around for stocks on the buy list
 * that are on the hold due to SD not updating their data. Download their
 * updated reports from the ASX and read them to extract the relevant data to
 * do our scoring. We keep that data stored until a SD update is available."
 *
 * WHAT THE SCORE ACTUALLY NEEDS FROM A REPORT. Of the 34 Stock Doctor columns,
 * the scoring reads only these that move when a company reports:
 *     CF: Net Operating ($)    -> Price/Cash-flow, which is the QAV divisor
 *     EPS Bef Abnormals (c)    -> IV1, growth-over-PE, and PE itself
 *     Equity ($)               -> price below book, and below book + 30%
 *     PE                       -> a price ratio, recomputed from the new EPS
 * Everything else is either a price (live), a Stock Doctor judgement that no
 * report contains (Financial Health, Star Stock, forecast EPS, consensus
 * target) or slow-moving (shares on issue, dividend yield, directors'
 * holdings). Those are CARRIED OVER from Stock Doctor, and the site says so.
 *
 * STOCK DOCTOR'S CONVENTION, checked against its financials pages: an interim
 * column is a ROLLING TWELVE MONTHS, not a half (Elders' "Mar 26 (I)" revenue is
 * $3.5bn; a half is $1.5bn), and everything is in Australian dollars (Santos'
 * equity is A$23.4bn against US$15bn reported). So a half-year report is folded
 * in as   new TTM = Stock Doctor's TTM + this half - the same half last year,
 * both of which are in the report; a full-year report replaces the figure
 * outright. Foreign-currency reporters are converted at the Reserve Bank's
 * rates: flows at the period's average, the balance sheet at the closing rate.
 *
 * READING THE REPORT is the fragile part, and the design assumes it will
 * sometimes be wrong. Four statement lines are located by their standard
 * wording; every figure keeps the page and the line of text it came from; and
 * nothing is applied by itself unless it RECONCILES against numbers Stock
 * Doctor already holds (see `deriveFromReport`). A reading that does not is
 * held for Doug to accept or reject, never scored silently.
 *
 * PURE — no fetch, no node imports. The route (app/api/asx-financials) supplies
 * the lines of the PDF; the page supplies Stock Doctor's side.
 */

import { addMonths, formatDay } from "./reporting";

export const ASX_FINANCIALS_STORAGE_KEY = "qav_asx_financials_v1";

// ── Reading a statement line ─────────────────────────────────────────────────

/** A figure as found: where, and the first columns of the row. */
export interface Found {
  current: number;
  /** Second column: the comparative. Null when the row has one figure. */
  prior: number | null;
  /** Third column where a report prints one. */
  third: number | null;
  page: number;
  /** The line as printed, so a reading can be checked against the PDF. */
  text: string;
}

export interface ReportedFigures {
  /** "2026-06-30", from "for the half-year ended ...". */
  periodEnd: string | null;
  /** 6, 12, or whatever the report says (NMG's changed year end: 9). */
  months: number | null;
  /** Presentation currency as detected: AUD, USD, NZD, PGK. */
  currency: string;
  /** Multiplier to whole currency units, as the statements declare it. */
  scale: number;
  /** Net cash from operating activities. */
  ocf: Found | null;
  /** Total equity, from the balance sheet. */
  equity: Found | null;
  /** Basic earnings per share. */
  eps: Found | null;
  /** Profit after tax (attributable to the parent where the report says). */
  npat: Found | null;
}

const NIL = /^[-–—]$/;

function parseNumber(token: string): number | null {
  if (NIL.test(token)) return 0;
  const negative = /^\(.*\)$/.test(token) || /^[-–−]/.test(token);
  const digits = token.replace(/[()$,%\s–−-]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const v = parseFloat(digits);
  return negative ? -v : v;
}

/**
 * Split a printed row into its label and its figures.
 *
 * The figures are the run of numeric tokens at the END of the line. A leading
 * small whole number on a row of three or more is the note reference
 * ("Net cash from operating activities 14 2,113 1,875") and is dropped.
 */
export function splitRow(text: string): { label: string; values: number[] } {
  const clean = text
    .replace(/\(\s+(?=[\d$])/g, "(")
    .replace(/(\d)\s+\)/g, "$1)")
    .replace(/\$\s*(?=[\d(])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = clean.split(" ");
  const raw: string[] = [];
  let i = tokens.length - 1;
  for (; i >= 0; i--) {
    if (parseNumber(tokens[i]) === null) break;
    raw.unshift(tokens[i]);
  }
  const label = tokens.slice(0, i + 1).join(" ");
  if (raw.length >= 3 && /^\d{1,2}$/.test(raw[0]) && !/^\d{1,2}$/.test(raw[1])) raw.shift();
  return { label, values: raw.map((t) => parseNumber(t) as number) };
}

function found(page: number, text: string, values: number[]): Found {
  return { current: values[0], prior: values.length > 1 ? values[1] : null, third: values.length > 2 ? values[2] : null, page, text };
}

// The wording is close to standardised by AASB 107 / 101 / 133, which is what
// makes this workable at all. Each test runs on the lower-cased label.

const OCF = /^net (cash|operating cash)/;
const OCF_MUST = /operating activities|^net operating cash ?flows?$/;
const OCF_NOT = /before|excluding|reconcil|per share|per security/;

const EQUITY_EXACT = /^total equity$/;
const EQUITY_ALT = /^total (share|stock|unit|security)holders' ?(equity|funds)$|^total equity attributable to|^net assets$/;

const EPS = /basic/;
const EPS_MUST = /per (ordinary )?(share|security|unit|stapled security)|\beps\b/;
const EPS_WORD = /earnings|loss|profit|eps/;
/** A heading — "Earnings per share:" — over bare "Basic" / "Diluted" rows. */
const EPS_HEADING = /(earnings|loss|profit)[^.]{0,40}per (ordinary )?(share|security|unit)|\beps\b/;
const EPS_BARE = /^basic\b/;

/** "Net profit for the period attributable to parent", best; then the same
 *  line without the attribution; "Net income" is the US wording. */
const PROFIT_WORD = "(profit|loss|income|profit ?\\/ ?\\(loss\\)|\\(loss\\) ?\\/ ?profit|profit \\(loss\\)|profit or loss)";
const NPAT_ATTRIBUTED = new RegExp(`^(net )?${PROFIT_WORD}\\b.*attributable to`);
const NPAT_PLAIN = new RegExp(
  `^(net )?${PROFIT_WORD}( after (income )?tax)?( from continuing operations)?` +
  `( for the (half[- ]?year|year|period|financial year|financial period))?( after (income )?tax)?$`);
const NPAT_NOT = /before|per share|comprehensive|%/;

/** "for the half-year ended 30 June 2026", "for the financial period ended ...". */
const PERIOD = /for the\s+(half[- ]?year|six[- ]months?|year|financial year|full year|financial period|(?:\w+|\d+)[- ]months?|period)(?:\s+period)?\s+ended\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{4})/i;
/** US wording: "Six Months Ended June 30," with the year on the next row. */
const PERIOD_US = /(six|three|nine|twelve)[- ]months?(?:[- ]period)? ended ([A-Za-z]{3,9}) (\d{1,2}),?\s*(\d{4})?/i;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORD_NUMBERS: Record<string, number> = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18,
};

function isoDate(day: string, monthName: string, year: string): string | null {
  const month = MONTH_NAMES.findIndex((n) => n.slice(0, 3) === monthName.toLowerCase().slice(0, 3));
  if (month < 0) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

function periodOf(text: string): { periodEnd: string; months: number | null } | null {
  const m = PERIOD.exec(text);
  if (m) {
    const periodEnd = isoDate(m[2], m[3], m[4]);
    if (!periodEnd) return null;
    const span = m[1].toLowerCase();
    let months: number | null = null;
    if (/half|six/.test(span)) months = 6;
    else if (/year/.test(span)) months = 12;
    else {
      const n = /^(\w+|\d+)[- ]months?$/.exec(span);
      if (n) months = /^\d+$/.test(n[1]) ? Number(n[1]) : WORD_NUMBERS[n[1]] ?? null;
    }
    return { periodEnd, months };
  }
  const us = PERIOD_US.exec(text);
  if (us) {
    const year = us[4] ?? (/\b(20\d{2})\b/.exec(text.slice(us.index)) ?? [])[1];
    const periodEnd = year ? isoDate(us[3], us[2], year) : null;
    if (periodEnd) return { periodEnd, months: WORD_NUMBERS[us[1].toLowerCase()] ?? null };
  }
  return null;
}

/** "Note 9 months 12 months" — a column heading that gives the length when the
 *  title only says "financial period". The first is the current column. */
function monthsInHeading(rows: string[]): number | null {
  const m = /\b(\d{1,2}|three|six|nine|twelve)[- ]months?\b/i.exec(rows.slice(0, 12).join(" "));
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBERS[m[1].toLowerCase()] ?? null;
}

/** The unit a statement declares in its heading: "$'000", "K'millions",
 *  "Amounts in USD thousands". Only the heading rows are searched. */
function scaleOf(rows: string[]): number | null {
  const head = rows.slice(0, 14).join(" ");
  if (/thousands?\b|['’]\s*000\b|\$\s*000\b/i.test(head)) return 1e3;
  if (/millions?\b|\$\s*['’]?\s*m\b|\$\s*M\b/i.test(head)) return 1e6;
  return null;
}

/** How often each currency is named; the statements name their own a lot. */
function currencyOf(pages: string[][]): string {
  let usd = 0, nzd = 0, pgk = 0, aud = 0;
  for (const page of pages) {
    const t = page.join(" ");
    usd += (t.match(/US\$|\bUSD\b|U\.?S\.? dollars?|United States dollars?/gi) ?? []).length;
    nzd += (t.match(/NZ\$|\bNZD\b|New Zealand dollars?/gi) ?? []).length;
    pgk += (t.match(/\bK['’]\s?(000|m)|\bPGK\b|\bKina\b|\btoea\b/gi) ?? []).length;
    aud += (t.match(/A\$|\bAUD\b|Australian dollars?/gi) ?? []).length;
  }
  const top = Math.max(usd, nzd, pgk);
  if (top < 3 || top <= aud) return "AUD";
  return top === usd ? "USD" : top === nzd ? "NZD" : "PGK";
}

/**
 * Find the figures in a report.
 *
 * `pages` is the document as rows of text, one array per page. The CASH FLOW
 * STATEMENT is the anchor: it is the one page that names investing and
 * financing activities together, so it is found without ambiguity, and the
 * primary statements are printed side by side. Each other figure is taken from
 * the candidate page NEAREST it — which is what keeps the reading off the
 * parent-entity note (NMG's page 79 "Total equity" is the parent's, not the
 * group's on page 50) and off the five-year summary (its page 37 EPS).
 */
export function extractFigures(pages: string[][]): ReportedFigures & { candidates: Record<string, Found[]> } {
  const ocfBest: Found[] = [], ocfAll: Found[] = [];
  const equity: { f: Found; rank: number }[] = [];
  const eps: Found[] = [];
  const npat: { f: Found; rank: number }[] = [];
  let period: { periodEnd: string; months: number | null } | null = null;
  let headingMonths: number | null = null;
  let scale: number | null = null;

  for (let index = 0; index < pages.length; index++) {
    const rows = pages[index];
    const page = index + 1;
    const pageText = rows.join(" \n ").toLowerCase();
    const isCashFlow = /investing activities/.test(pageText) && /financing activities/.test(pageText);
    const isBalanceSheet = /total assets/.test(pageText) && /total liabilities/.test(pageText);
    if (isCashFlow || isBalanceSheet) {
      if (!period) period = periodOf(rows.slice(0, 14).join(" "));
      if (scale === null) scale = scaleOf(rows);
      if (isCashFlow && headingMonths === null) headingMonths = monthsInHeading(rows);
    }
    let underEpsHeading = 0;
    for (const text of rows) {
      const { label, values } = splitRow(text);
      const l = label.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
      if (EPS_HEADING.test(l)) underEpsHeading = 4; else if (underEpsHeading > 0) underEpsHeading--;
      if (values.length === 0) continue;
      if (OCF.test(l) && OCF_MUST.test(l) && !OCF_NOT.test(l)) {
        (isCashFlow ? ocfBest : ocfAll).push(found(page, text, values));
      }
      if (isBalanceSheet) {
        if (EQUITY_EXACT.test(l)) equity.push({ f: found(page, text, values), rank: 0 });
        else if (EQUITY_ALT.test(l)) equity.push({ f: found(page, text, values), rank: 1 });
      }
      const namedEps = EPS.test(l) && EPS_MUST.test(l) && EPS_WORD.test(l);
      const bareEps = underEpsHeading > 0 && EPS_BARE.test(l) && !EPS_HEADING.test(l);
      if ((namedEps || bareEps) && Math.abs(values[0]) < 1e5) eps.push(found(page, text, values));
      if (values.length >= 2 && !NPAT_NOT.test(l) && !/%/.test(text)) {
        if (NPAT_ATTRIBUTED.test(l)) npat.push({ f: found(page, text, values), rank: 0 });
        // The bare form must say what it is: a row labelled just "Income" is a
        // fund's revenue line, not its profit.
        else if (NPAT_PLAIN.test(l) && /^net | for the | after /.test(l)) npat.push({ f: found(page, text, values), rank: 1 });
      }
    }
  }

  if (!period) {
    for (const rows of pages) {
      period = periodOf(rows.join(" "));
      if (period) break;
    }
  }

  const ocf = ocfBest[0] ?? ocfAll[0] ?? null;
  const anchor = ocf ? ocf.page : 0;
  const near = (a: Found, b: Found) => Math.abs(a.page - anchor) - Math.abs(b.page - anchor);
  // Ties go to the earlier page: the statements come before their notes.
  const equitySorted = equity.slice().sort((a, b) => (ocf ? near(a.f, b.f) : 0) || a.rank - b.rank || a.f.page - b.f.page);
  const epsSorted = eps.slice().sort((a, b) => (ocf ? near(a, b) : 0) || a.page - b.page);
  const npatSorted = npat.slice().sort((a, b) => a.rank - b.rank || (ocf ? near(a.f, b.f) : 0) || a.f.page - b.f.page);

  const months = period && period.months !== null ? period.months : headingMonths;
  return {
    periodEnd: period ? period.periodEnd : null,
    months,
    currency: currencyOf(pages),
    scale: scale ?? 1,
    ocf,
    equity: equitySorted[0]?.f ?? null,
    eps: epsSorted[0] ?? null,
    npat: npatSorted[0]?.f ?? null,
    candidates: {
      ocf: ocfBest.concat(ocfAll).slice(0, 4),
      equity: equitySorted.slice(0, 4).map((e) => e.f),
      eps: epsSorted.slice(0, 4),
      npat: npatSorted.slice(0, 4).map((e) => e.f),
    },
  };
}

// ── From a reading to Stock Doctor-equivalent figures ────────────────────────

/** What the route returns for one stock. */
export interface AsxRead {
  code: string;
  balanceDate: string;
  status: "read" | "none" | "unreadable" | "not found" | "error";
  reason?: string;
  reportDate?: string;
  kind?: "half" | "full" | "unknown";
  figures?: ReportedFigures;
  sources?: Record<string, { headline: string; date: string; url: string }>;
  /** Units of the report's currency per A$1, from the Reserve Bank. */
  fx?: { pair: string; atPeriodEnd: number | null; atBalanceDate: number | null; average: number | null; error?: string } | null;
  /** Who chose the lines: Claude (lib/asx-reader-claude.ts) when a key is set,
   *  otherwise the wording rules in this file. */
  reader?: "claude" | "rules";
  /** Claude's remark on the report, or why Claude could not be used. */
  readerNote?: string;
  readAt?: string;
}

/** Stock Doctor's side of the reconciliation — never leaves the browser. */
export interface SdSide {
  /** "Last Period Analysed", YYYY-MM-DD. */
  period: string;
  cf: number | null;
  eps: number | null;
  equity: number | null;
  /** Shares outstanding, in millions. */
  sharesM: number | null;
}

export interface Check { name: string; ok: boolean; detail: string }

export interface AsxFinancialsRecord {
  code: string;
  /** The Stock Doctor period these sit on top of. Void once SD moves past it. */
  basedOn: string;
  /** The period the report covers. */
  period: string;
  months: number;
  kind: "half" | "full" | "unknown";
  /**
   * ok      every check passed — applied without asking
   * review  read, but something needs a human eye — applied only once accepted
   * failed  could not be read into usable figures
   */
  status: "ok" | "review" | "failed";
  /** Doug accepted a "review" reading. */
  accepted?: boolean;
  /** Doug rejected it. Kept so the same report is not read again every run. */
  dismissed?: boolean;
  /** Stock Doctor-equivalent: rolling 12 months, Australian dollars. */
  values: { cf: number | null; eps: number | null; equity: number | null };
  /** What Stock Doctor had, for the before/after. */
  was: { cf: number | null; eps: number | null; equity: number | null };
  /** One sentence per figure on how it was arrived at. */
  basis: string[];
  checks: Check[];
  currency: string;
  /** A$ per unit of the report's currency: [period average, closing]. */
  audPerUnit: [number, number];
  source: { headline: string; date: string; url: string } | null;
  /** Page and printed line of each figure. */
  evidence: Record<string, { page: number; text: string }>;
  reader?: "claude" | "rules";
  readerNote?: string;
  readAt: string;
}

export interface StoredAsxFinancials {
  timestamp: string;
  data: Record<string, AsxFinancialsRecord>;
}

const SCALES = [1, 1e3, 1e6];
/** A comparative that reconciles is within a few per cent: rounding to the
 *  report's units, a day's difference in the exchange rate, and whether
 *  minority interests are counted. Outside this it is a different number. */
const RECONCILE_TOLERANCE = 0.05;
/** A swing this large is more often a misread column than a real result, so
 *  it is shown for a look, not applied silently. */
const LARGE_MOVE = 3;

const money = (v: number | null) => (v === null ? "—" : `$${(v / 1e6).toFixed(1)}m`);
const cents = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}c`);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function significantDigits(v: number): number {
  return String(Math.abs(v)).replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
}

/**
 * Turn a reading into the figures Stock Doctor would show, and decide whether
 * they can be trusted without a look.
 *
 * THE RECONCILIATION that makes this safe: a half-year report prints the
 * balance sheet as at the LAST year end beside the new one, and that year end
 * is the period Stock Doctor holds. So the report's comparative equity,
 * converted, must equal Stock Doctor's equity. One comparison checks the
 * units ($, $'000, $m), the currency and the exchange rate at once — GQG's
 * 443,109 only becomes Stock Doctor's A$662.0m as US$ thousands at 0.669. The
 * unit is in fact CHOSEN by that test, whatever the heading parsed as.
 */
export function deriveFromReport(sd: SdSide, read: AsxRead): AsxFinancialsRecord {
  const f = read.figures;
  const now = read.readAt ?? new Date().toISOString();
  const sourceOf = (k: string) => read.sources?.[k] ?? null;
  const base: AsxFinancialsRecord = {
    code: read.code, basedOn: sd.period, period: f?.periodEnd ?? "", months: 0,
    kind: read.kind ?? "unknown", status: "failed",
    values: { cf: null, eps: null, equity: null },
    was: { cf: sd.cf, eps: sd.eps, equity: sd.equity },
    basis: [], checks: [], currency: f?.currency ?? "AUD", audPerUnit: [1, 1],
    source: sourceOf("ocf") ?? sourceOf("equity") ?? sourceOf("eps"),
    evidence: {}, reader: read.reader, readerNote: read.readerNote, readAt: now,
  };
  if (read.status !== "read" || !f) {
    return { ...base, checks: [{ name: "report", ok: false, detail: read.reason ?? "The report could not be read." }] };
  }
  const checks: Check[] = [];
  const basis: string[] = [];
  const evidence: Record<string, { page: number; text: string }> = {};
  const keys: ("ocf" | "equity" | "eps" | "npat")[] = ["ocf", "equity", "eps", "npat"];
  for (const k of keys) {
    const v = f[k];
    if (v) evidence[k] = { page: v.page, text: v.text };
  }

  // ── The period ────────────────────────────────────────────────────────────
  const half = read.kind === "half";
  const months = f.months ?? (half ? 6 : 12);
  const expected = addMonths(sd.period, 6);
  if (!f.periodEnd || f.periodEnd <= sd.period) {
    return { ...base, months, evidence, checks: [{ name: "period", ok: false, detail: "Could not find a period later than the one Stock Doctor holds." }] };
  }
  const periodEnd = f.periodEnd;
  const nextInLine = periodEnd === expected;
  const wholePeriod = months === 6 || months === 12;
  checks.push({
    name: "period", ok: nextInLine && wholePeriod,
    detail: nextInLine && wholePeriod
      ? `${months === 6 ? "Half year" : "Year"} to ${formatDay(periodEnd)}, the period after Stock Doctor's ${formatDay(sd.period)}.`
      : !wholePeriod
        ? `A ${months}-month period to ${formatDay(periodEnd)}: cash flow and EPS are for ${months} months, not twelve, and are used as reported.`
        : `The report is to ${formatDay(periodEnd)}; the period after Stock Doctor's would end ${formatDay(expected)}.`,
  });

  // ── Currency ──────────────────────────────────────────────────────────────
  const foreign = f.currency !== "AUD";
  let avg = 1, close = 1, opening = 1;
  let rated = !foreign;
  if (foreign && read.fx && read.fx.average && read.fx.atPeriodEnd && read.fx.atBalanceDate) {
    avg = 1 / read.fx.average; close = 1 / read.fx.atPeriodEnd; opening = 1 / read.fx.atBalanceDate;
    rated = true;
  }

  // ── Units, by reconciling equity ──────────────────────────────────────────
  // Half year: the comparative IS Stock Doctor's period. Full year: it is the
  // year end before, so only the new figure can be compared, and only roughly.
  let scale = f.scale;
  const comparativeAtSd = half && nextInLine && !!f.equity && f.equity.prior !== null && f.equity.prior !== 0;
  if (f.equity && sd.equity && sd.equity > 0) {
    const reference = comparativeAtSd ? (f.equity.prior as number) : f.equity.current;
    if (reference > 0) {
      const rate = comparativeAtSd ? opening : close;
      let best = scale, bestGap = Number.POSITIVE_INFINITY;
      for (const s of SCALES) {
        const gap = Math.abs(Math.log((reference * s * (rated ? rate : 1)) / sd.equity));
        if (gap < bestGap) { bestGap = gap; best = s; }
      }
      scale = best;
      if (comparativeAtSd) {
        if (!rated) {
          // No published rate. The rate Stock Doctor's own figure implies is
          // used for everything, and the reading waits for a look.
          opening = sd.equity / (reference * scale);
          avg = opening; close = opening;
          // Where the Reserve Bank does publish a rate for the NEW balance
          // date, say how far Stock Doctor's implied rate is from it. BFL is
          // the case that prompted this: its Stock Doctor figures imply A$0.42
          // to the Kina against a published A$0.33, which would overstate
          // every dollar figure Stock Doctor shows for it by a quarter. The
          // implied rate is still the one used, so the rolling twelve months
          // stays on one basis — but that is a call for Doug, not for a default.
          const published = read.fx?.atPeriodEnd ? 1 / read.fx.atPeriodEnd : null;
          const gap = published ? opening / published - 1 : null;
          checks.push({
            name: "exchange rate", ok: false,
            detail:
              `No published ${f.currency} rate for ${formatDay(sd.period)} (${read.fx?.error ?? "unavailable"}). ` +
              `Converted at A$${opening.toFixed(4)} per unit — the rate that makes the report's opening equity equal Stock Doctor's.` +
              (published && gap !== null && Math.abs(gap) > RECONCILE_TOLERANCE
                ? ` The Reserve Bank's rate at ${formatDay(periodEnd)} was A$${published.toFixed(4)}: Stock Doctor's ${f.currency} figures for this company look ${gap > 0 ? "overstated" : "understated"} in Australian dollars by about ${pct(Math.abs(gap))}.`
                : ""),
          });
        } else {
          const ours = reference * scale * opening;
          const gap = ours / sd.equity - 1;
          checks.push({
            name: "equity reconciles", ok: Math.abs(gap) <= RECONCILE_TOLERANCE,
            detail: `Report's opening equity ${money(ours)}${foreign ? ` (${f.currency} at ${(1 / opening).toFixed(4)})` : ""} against Stock Doctor's ${money(sd.equity)}: ${gap >= 0 ? "+" : ""}${pct(gap)}.`,
          });
        }
      } else {
        const ratio = (reference * scale * close) / sd.equity;
        checks.push({
          name: "equity plausible", ok: ratio > 1 / LARGE_MOVE && ratio < LARGE_MOVE,
          detail: `New equity ${money(reference * scale * close)} against Stock Doctor's ${money(sd.equity)} at ${formatDay(sd.period)}.`,
        });
        // A full-year report always waits for a look. Its comparative is the
        // year end BEFORE the one Stock Doctor holds, so there is no figure to
        // reconcile exactly — and annual reports are where the lines get
        // misread: back-tested on 20 that Stock Doctor had already analysed,
        // the rule-based reader had the cash flow right on 11.
        checks.push({
          name: "not reconciled", ok: false,
          detail: "A full-year report has nothing that reconciles exactly with Stock Doctor's figures, so check the lines against the report before using it.",
        });
        if (foreign && !rated) checks.push({ name: "exchange rate", ok: false, detail: `No published ${f.currency} rate (${read.fx?.error ?? "unavailable"}).` });
      }
    }
  } else {
    checks.push({ name: "equity", ok: false, detail: f.equity ? "Stock Doctor has no equity figure to reconcile against." : "No total equity line found." });
  }
  const unit = scale === 1e6 ? "m" : scale === 1e3 ? "'000" : "";
  const inReport = (v: number) => `${f.currency === "AUD" ? "$" : `${f.currency} `}${v.toLocaleString("en-AU")}${unit}`;

  // ── Equity ────────────────────────────────────────────────────────────────
  const equity = f.equity ? f.equity.current * scale * close : null;
  if (equity !== null && f.equity) basis.push(`Equity ${money(equity)}: ${inReport(f.equity.current)} at ${formatDay(periodEnd)}${foreign ? `, at ${(1 / close).toFixed(4)}` : ""} (p.${f.equity.page}).`);

  // ── Operating cash flow ───────────────────────────────────────────────────
  let cf: number | null = null;
  if (!f.ocf) {
    checks.push({ name: "cash flow", ok: false, detail: "No net operating cash flow line found." });
  } else if (months === 6 && nextInLine) {
    if (f.ocf.prior === null || sd.cf === null) {
      checks.push({ name: "cash flow", ok: false, detail: "The half-year line has no comparative, so the rolling twelve months cannot be rebuilt." });
    } else {
      cf = sd.cf + (f.ocf.current - f.ocf.prior) * scale * avg;
      basis.push(`Operating cash flow ${money(cf)}: Stock Doctor's twelve months ${money(sd.cf)} plus this half ${inReport(f.ocf.current)} less the same half last year ${inReport(f.ocf.prior)} (p.${f.ocf.page}).`);
    }
  } else {
    cf = f.ocf.current * scale * avg;
    basis.push(`Operating cash flow ${money(cf)}: ${inReport(f.ocf.current)} for the ${months} months, as reported (p.${f.ocf.page}).`);
  }
  if (cf !== null && sd.cf) {
    const ratio = cf / sd.cf;
    const sane = ratio > 1 / LARGE_MOVE && ratio < LARGE_MOVE;
    checks.push({
      name: "cash flow move", ok: sane,
      detail: `${money(sd.cf)} to ${money(cf)}${sane ? "" : " — a large move; worth a look at the line it was read from"}.`,
    });
  }

  // ── Earnings per share ────────────────────────────────────────────────────
  // The report's own EPS line where it is precise enough to show a change;
  // otherwise profit over Stock Doctor's share count. An EPS quoted to two
  // decimals of a dollar (GQG: "0.08") cannot show a change at all.
  let eps: number | null = null;
  const shares = sd.sharesM && sd.sharesM > 0 ? sd.sharesM * 1e6 : null;
  const perShare = (profit: number) => (shares ? (profit * scale * avg) / shares * 100 : null);
  if (months === 6 && nextInLine) {
    const viaProfit = f.npat && f.npat.prior !== null ? perShare(f.npat.current - f.npat.prior) : null;
    const precise = f.eps && f.eps.prior !== null && significantDigits(f.eps.current) >= 3 ? (f.eps.current - f.eps.prior) * avg : null;
    const delta = precise !== null ? precise : viaProfit;
    if (delta === null || sd.eps === null) {
      checks.push({ name: "earnings", ok: false, detail: "Neither a usable EPS line nor a profit line with a comparative was found." });
    } else {
      eps = sd.eps + delta;
      if (precise !== null && f.eps) {
        basis.push(`EPS ${cents(eps)}: Stock Doctor's twelve months ${cents(sd.eps)} plus this half ${f.eps.current} less the same half last year ${f.eps.prior}${foreign ? ", converted" : ""} (p.${f.eps.page}).`);
      } else if (f.npat && f.npat.prior !== null) {
        basis.push(`EPS ${cents(eps)}: Stock Doctor's twelve months ${cents(sd.eps)} plus the change in half-year profit, ${inReport(f.npat.current)} against ${inReport(f.npat.prior)}, over ${sd.sharesM}m shares (p.${f.npat.page}).`);
      }
      if (precise !== null && viaProfit !== null && sd.eps !== 0) {
        const gap = Math.abs(precise - viaProfit) / Math.abs(sd.eps);
        checks.push({ name: "earnings agree", ok: gap <= RECONCILE_TOLERANCE, detail: `EPS line gives a change of ${precise.toFixed(2)}c, the profit line ${viaProfit.toFixed(2)}c.` });
      }
    }
  } else {
    const viaProfit = f.npat ? perShare(f.npat.current) : null;
    let line = f.eps ? f.eps.current * avg : null;
    // An EPS line printed in dollars is a hundred times too small as cents;
    // the profit line says which it is.
    if (line !== null && viaProfit !== null && viaProfit !== 0 && Math.abs(line * 100 / viaProfit - 1) < Math.abs(line / viaProfit - 1)) line *= 100;
    eps = line !== null ? line : viaProfit;
    if (eps === null) checks.push({ name: "earnings", ok: false, detail: "No EPS or profit line found." });
    else {
      if (line !== null && f.eps) basis.push(`EPS ${cents(eps)}: basic EPS for the ${months} months, as reported (p.${f.eps.page}).`);
      else if (f.npat) basis.push(`EPS ${cents(eps)}: profit ${inReport(f.npat.current)} over ${sd.sharesM}m shares (p.${f.npat.page}).`);
      if (line !== null && viaProfit !== null && viaProfit !== 0) {
        const gap = Math.abs(line / viaProfit - 1);
        // Looser than the others: weighted-average against closing share count.
        checks.push({ name: "earnings agree", ok: gap <= 0.25, detail: `EPS line ${cents(line)}; profit over Stock Doctor's share count ${cents(viaProfit)}.` });
      }
    }
  }

  const usable = cf !== null || equity !== null || eps !== null;
  const allOk = checks.every((c) => c.ok) && cf !== null && equity !== null && eps !== null;
  return {
    ...base, period: periodEnd, months, basis, checks, evidence,
    values: { cf, eps, equity },
    audPerUnit: [avg, close],
    status: !usable ? "failed" : allOk ? "ok" : "review",
  };
}

// ── Applying it ──────────────────────────────────────────────────────────────

/** Is this record the one to score from, given where Stock Doctor now is? */
export function isInForce(r: AsxFinancialsRecord | undefined | null, sdPeriod: string): boolean {
  if (!r || r.dismissed) return false;
  if (r.basedOn !== sdPeriod) return false;           // Stock Doctor has moved on
  return r.status === "ok" || (r.status === "review" && r.accepted === true);
}

/** "2026-06-30" -> "30/06/2026", the way the Stock Doctor export writes it. */
function sdDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** The provenance, for a tooltip. */
export function describe(r: AsxFinancialsRecord): string {
  const lines = [
    `Scored from the company's own report: ${r.source ? `"${r.source.headline}", lodged ${formatDay(r.source.date)}` : "ASX report"}.`,
    `Stock Doctor is still on ${formatDay(r.basedOn)}. Lines chosen by ${r.reader === "claude" ? "Claude" : "the rule-based reader"}.`,
  ].concat(r.basis, [
    "Carried over from Stock Doctor: Financial Health, Star Stock, forecast EPS, consensus target, dividend yield, shares on issue.",
  ]);
  const failed = r.checks.filter((c) => !c.ok);
  if (failed.length) lines.push(`Accepted with: ${failed.map((c) => c.detail).join(" ")}`);
  return lines.join("\n");
}

/**
 * A Stock Doctor row with the report's figures in place of the stale ones.
 *
 * Generic over the row so this file needs no knowledge of the CSV's 34
 * columns. PE is recomputed from the new EPS and the live price, because it is
 * a ratio of the two; "Last Period Analysed" moves to the report's period,
 * which is what lifts the reporting-season hold. The `_asx…` markers carry the
 * provenance to the table.
 */
export function applyToRow<T extends Record<string, string | number | null>>(row: T, r: AsxFinancialsRecord): T {
  const out: Record<string, string | number | null> = { ...row };
  if (r.values.cf !== null) out["CF: Net Operating ($)"] = Math.round(r.values.cf);
  if (r.values.equity !== null) out["Equity ($)"] = Math.round(r.values.equity);
  if (r.values.eps !== null) {
    const eps = Math.round(r.values.eps * 100) / 100;
    out["EPS Bef Abnormals (c)"] = eps;
    const price = typeof row["Share Price ($)"] === "number" ? (row["Share Price ($)"] as number) : null;
    out["PE"] = price !== null && eps > 0 ? Math.round((price / (eps / 100)) * 100) / 100 : null;
  }
  out["Last Period Analysed"] = sdDate(r.period);
  out["_asxPeriod"] = r.period;
  out["_sdPeriod"] = r.basedOn;
  out["_asxNote"] = describe(r);
  return out as T;
}

// ── Self-test ────────────────────────────────────────────────────────────────

/**
 * The reading and the arithmetic on made-up statements. Served by
 * /api/asx-financials?selftest=1; pass/fail per case only.
 */
export function asxFinancialsSelfTest(): { ok: boolean; steps: Record<string, boolean> } {
  const halfYear: string[][] = [
    ["Results for announcement to the market", "Profit after tax attributable to members up 12% to 1,234"],
    ["Consolidated statement of profit or loss", "for the half-year ended 30 June 2026", "$'000 Note 2026 2025",
      "Revenue 3 9,000 8,000", "Profit for the period attributable to owners of the Company 1,300 1,000",
      "Earnings per share", "Basic (cents) 13.00 10.00", "Diluted (cents) 12.90 9.90"],
    ["Consolidated statement of financial position", "as at 30 June 2026", "$'000 30 Jun 2026 31 Dec 2025",
      "Total assets 30,000 28,000", "Total liabilities 9,000 8,000", "Net assets 21,000 20,000", "Total equity 21,000 20,000"],
    ["Consolidated statement of cash flows", "for the half-year ended 30 June 2026", "$'000 Note 2026 2025",
      "Cash flows from operating activities", "Net cash from operating activities 14 2,500 2,000",
      "Net cash used in investing activities (500) (400)", "Net cash used in financing activities (300) (200)"],
    ["Parent entity information", "Total assets 5,000 4,000", "Total liabilities 1,000 900", "Total equity 4,000 3,100"],
  ];
  const got = extractFigures(halfYear);
  const figures: ReportedFigures = {
    periodEnd: got.periodEnd, months: got.months, currency: got.currency, scale: got.scale,
    ocf: got.ocf, equity: got.equity, eps: got.eps, npat: got.npat,
  };
  const read = (fig: ReportedFigures, kind: "half" | "full", fx?: AsxRead["fx"]): AsxRead =>
    ({ code: "TST", balanceDate: "2025-12-31", status: "read", kind, figures: fig, fx: fx ?? null, readAt: "2026-11-14T00:00:00.000Z" });
  const sd: SdSide = { period: "2025-12-31", cf: 4_000_000, eps: 22, equity: 20_000_000, sharesM: 10 };
  const ok = deriveFromReport(sd, read(figures, "half"));
  // The same report with the unit heading lost: the reconciliation finds it.
  const unitLost = deriveFromReport(sd, read({ ...figures, scale: 1 }, "half"));
  // In US dollars, thousands: 0.6667 opening, 0.70 average, 0.68 closing.
  const usd = deriveFromReport(
    { ...sd, equity: 30_000_000 },
    read({ ...figures, currency: "USD" }, "half", { pair: "AUDUSD", atPeriodEnd: 0.68, atBalanceDate: 0.6667, average: 0.7 }),
  );
  const mismatch = deriveFromReport({ ...sd, equity: 26_000_000 }, read(figures, "half"));
  const fullYear = deriveFromReport(sd, read({ ...figures, months: 12 }, "full"));
  const nineMonths = deriveFromReport(sd, read({ ...figures, months: 9 }, "full"));
  const row = applyToRow({
    Code: "TST", "Share Price ($)": 5, "CF: Net Operating ($)": 4_000_000, "EPS Bef Abnormals (c)": 22,
    PE: 22.7, "Equity ($)": 20_000_000, "Last Period Analysed": "31/12/2025", "Div Yield (%)": 4,
  } as Record<string, string | number | null>, ok);
  const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1;

  const steps: Record<string, boolean> = {
    noteReferenceDropped: splitRow("Net cash from operating activities 14 2,500 2,000").values.join() === "2500,2000",
    bracketsAreNegative: splitRow("Net cash used in investing activities ( 500 ) (400)").values.join() === "-500,-400",
    dashIsNil: splitRow("Other comprehensive income - -").values.join() === "0,0",
    cashFlowFound: !!got.ocf && got.ocf.current === 2500 && got.ocf.prior === 2000 && got.ocf.page === 4,
    groupEquityNotParent: !!got.equity && got.equity.current === 21000 && got.equity.page === 3,
    epsUnderAHeading: !!got.eps && got.eps.current === 13 && got.eps.prior === 10,
    profitAttributedNotTheSummary: !!got.npat && got.npat.current === 1300 && got.npat.page === 2,
    periodAndUnits: got.periodEnd === "2026-06-30" && got.months === 6 && got.scale === 1e3 && got.currency === "AUD",
    halfYearRollsTwelveMonths: ok.status === "ok" && close(ok.values.cf, 4_500_000) && close(ok.values.eps, 25) && close(ok.values.equity, 21_000_000),
    unitFoundByReconciling: unitLost.status === "ok" && close(unitLost.values.equity, 21_000_000),
    foreignCurrencyConverted: usd.status === "ok" && close(usd.values.equity, 21_000_000 / 0.68) && close(usd.values.cf, 4_000_000 + 500_000 / 0.7),
    mismatchIsHeldForReview: mismatch.status === "review" && mismatch.checks.some((c) => c.name === "equity reconciles" && !c.ok),
    fullYearReplacesOutright: close(fullYear.values.cf, 2_500_000) && close(fullYear.values.eps, 13),
    oddPeriodIsHeldForReview: nineMonths.status === "review" && close(nineMonths.values.cf, 2_500_000),
    notInForceUntilAccepted: !isInForce(mismatch, "2025-12-31") && isInForce({ ...mismatch, accepted: true }, "2025-12-31"),
    voidOnceStockDoctorMovesOn: isInForce(ok, "2025-12-31") && !isInForce(ok, "2026-06-30"),
    dismissedIsNotInForce: !isInForce({ ...ok, dismissed: true }, "2025-12-31"),
    rowCarriesTheNewFigures: row["CF: Net Operating ($)"] === 4_500_000 && row["EPS Bef Abnormals (c)"] === 25 && row.PE === 20
      && row["Last Period Analysed"] === "30/06/2026" && row["Div Yield (%)"] === 4,
  };
  return { ok: Object.keys(steps).every((k) => steps[k]), steps };
}
