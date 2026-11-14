/**
 * Where a company is in its reporting cycle — read from the ASX, measured
 * against the period Stock Doctor has analysed.
 *
 * Doug, 2026-11-14, about the 18 stocks on the reporting-season hold: "check SD
 * for any updated data and double check the ASX for any announcements in
 * relation to the numbers and why they are so late. This could basically be a
 * new red flag scenario."
 *
 * Doing that by hand for the 18 found THREE different things hiding under the
 * one amber "numbers older than 6 months" label, and they call for three
 * different responses:
 *
 *   awaiting   10 of 18. The period after the one Stock Doctor holds has ended
 *              but its report is not due yet (ELD, NUF, SHV ... all September
 *              and March balance dates, due 30 November). Nothing is late. The
 *              hold is doing its job; it just is not news.
 *   reported    8 of 18. The company HAS reported — BFL, GQG, HLI and STO lodged
 *              their June half-years in August, NMG changed its year end and
 *              lodged an annual report in September — and Stock Doctor has not
 *              loaded it. The company did nothing wrong, but the QAV score is
 *              built on numbers a full period behind.
 *   overdue     0 of 18, and the one that matters. The deadline has passed and
 *              NOTHING has been lodged. This is the Mill Rule's second trigger,
 *              "Failure to get financial reports published on time", and until
 *              now nothing here could see it: `lateReport` could only measure a
 *              report that EXISTS.
 *
 * The same investigation found a false red flag the old code was raising. It
 * compared Stock Doctor's balance date with the NEWEST Appendix on the ASX, so
 * whenever Stock Doctor was a period behind, an on-time report for the NEXT
 * period read as months late: BFL and GQG were both flagged "Appendix lodged
 * 171 days after the Listing Rule 4.3A deadline" for a June half-year lodged
 * 20 August, eleven days inside the deadline. `lateLodgements` below measures
 * each Appendix against the period it belongs to.
 *
 * THE DEADLINES are the ASX's, not ours — no threshold here is invented:
 *   - Listing Rules 4.2B / 4.3B: the Appendix 4D (half year) and Appendix 4E
 *     (full year) are due no later than TWO MONTHS after the period ends.
 *   - An entity that does not lodge those Appendices — a mining exploration
 *     entity, a fund — has 75 days for a half year and THREE MONTHS for the
 *     annual report. We do not know which of the two its next report is, so we
 *     allow the longer one, three months, for both.
 * Which regime applies is read off the company's own feed: it lodges an
 * Appendix 4D/4E — named in a headline, or filed under "Preliminary Final
 * Report", the ASX's own category for the Appendix 4E (Nufarm never writes
 * "Appendix" in a headline) — or it does not. When the feed cannot say, the
 * longer deadline applies: the error is a flag a month late, never a false one.
 *
 * PURE — no fetch, no node imports. The route feeds it the announcement list,
 * and the page uses the types and the storage key.
 */

export const REPORTING_STORAGE_KEY = "qav_reporting_v1";

export interface FeedItem { headline: string; types: string[]; date: string }

export type ReportKind = "half" | "full" | "unknown";
export interface PeriodicReport { date: string; headline: string; kind: ReportKind }

/**
 * current    the period Stock Doctor holds is still the latest one that has ended
 * awaiting   the next period has ended; its report is not due yet
 * reported   a report for a later period is on the ASX; Stock Doctor is behind
 * overdue    the deadline has passed and nothing has been lodged — a red flag
 * unknown    the feed could not be read, or does not reach back far enough
 */
export type ReportingState = "current" | "awaiting" | "reported" | "overdue" | "unknown";

export interface ReportingStatus {
  state: ReportingState;
  /** The period Stock Doctor has analysed, YYYY-MM-DD. */
  balanceDate: string;
  /** End of the following half, YYYY-MM-DD. */
  nextPeriodEnd: string;
  /** When the report for that half must be lodged by. */
  dueBy: string;
  /** 2 = lodges Appendix 4D/4E; 3 = does not (explorer, fund, foreign filer). */
  deadlineMonths: 2 | 3;
  /** The first report on the ASX for a later period — how long SD has been behind. */
  first?: { date: string; headline: string };
  /** The most recent one, when there is more than one. */
  latest?: { date: string; headline: string };
  /** (Re-)admitted or reinstated to quotation since the balance date. */
  relisted?: string;
  /** One plain sentence, ready for a tooltip. */
  detail: string;
  checkedAt: string;
}

export interface StoredReporting {
  timestamp: string;
  data: Record<string, ReportingStatus>;
}

/** One or two days past a deadline is a weekend or a public holiday, not a
 *  breach — the same allowance `lateReport` has always made. */
export const GRACE_DAYS = 3;

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * The SYDNEY calendar date of an ASX timestamp.
 *
 * The feed is in UTC, and the morning lodgement window (from 7:30am) is the
 * evening before in UTC — Metcash's Appendix 4E reads "2026-06-21", a Sunday.
 * A deadline is a Sydney date, so shift before comparing. Ten hours, not a
 * time-zone lookup: nothing is lodged in the hour where AEST and AEDT differ.
 */
export function sydneyDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso.slice(0, 10);
  return new Date(t + 10 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Add calendar months to a YYYY-MM-DD date, month end to month end.
 *
 * `Date.setMonth` overflows: 31 December + 2 months is "31 February", which
 * JavaScript turns into 3 March. A balance date is a month end, and so is its
 * deadline — 31 December reports are due by the last day of February.
 */
export function addMonths(isoDate: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const lastOf = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const wasMonthEnd = d === lastOf(y, mo);
  const total = mo + months;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const day = wasMonthEnd ? lastOf(ty, tm) : Math.min(d, lastOf(ty, tm));
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-20" -> "20 Aug 2026". */
export function formatDay(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : isoDate;
}

/** "2026-06-30" -> "Jun 2026" — a reporting period. */
function formatPeriod(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(isoDate);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : isoDate;
}

// ── Which announcements are periodic reports ─────────────────────────────────
//
// The ASX's own announcement TYPES are the reliable signal; headlines are
// whatever the company felt like writing ("Strong profit growth and progress on
// deleveraging" is Nufarm's half-year report). Checked against the 18 feeds:
// every half-year or full-year result carries one of these tags, including the
// New Zealand dual listings (ERD, TWR). The exception is a US filer — LNW's
// 10-Q and 10-K arrive as "Periodic Reports - Other", a tag shared with modern
// slavery statements and monthly FUM updates — so those are taken by form name.

const HALF_TYPE = /^half year(ly)?\b/i;
const FULL_TYPE = /^(full year\b|preliminary final report$|annual report$)/i;
const HALF_HEAD = /appendix\s*4d\b|\b4d\b|half[\s-]?year|\binterim\s+(financial\s+)?(report|results|accounts|statements)|\b10-?q\b/i;
const FULL_HEAD = /appendix\s*4e\b|\b4e\b|annual\s+report|full[\s-]?year|preliminary\s+final|\b10-?k\b/i;
const FILED_FORM = /appendix\s*4[de]\b|\bform\s*10-?[qk]\b|\b10-[qk]\b/i;
/** "Appendix 4E release date", "HY27 Results Briefing details" — a notice
 *  ABOUT a report is not the report. */
const A_NOTICE = /\b(dates?|timing|briefing|webcast|web\s*cast|conference\s+call|teleconference|notification)\b/i;

/** The same test the red-flag route has always used to find the Appendix. */
const APPENDIX = /appendix\s*4[de]\b/i;
/** The ASX category an Appendix 4E is filed under. */
const PRELIM_FINAL = /^preliminary final report$/i;

function lodgesAppendix(items: FeedItem[]): boolean {
  return items.some((i) =>
    APPENDIX.test(`${i.headline} ${i.types.join(" ")}`) || i.types.some((t) => PRELIM_FINAL.test(t.trim())));
}

/** A results day brings a presentation, a webcast notice and the report itself,
 *  all tagged alike. When naming "the report", prefer the document. */
const SUPPORTING = /presentation|web\s*cast|webcast|briefing|conference\s+call|investor\s+call/i;

function kindOf(item: FeedItem): ReportKind | null {
  let half = 0, full = 0;
  for (const raw of item.types) {
    const t = raw.trim();
    if (HALF_TYPE.test(t)) half++;
    else if (FULL_TYPE.test(t)) full++;
  }
  const headHalf = HALF_HEAD.test(item.headline);
  const headFull = FULL_HEAD.test(item.headline);
  if (half === 0 && full === 0) {
    if (!FILED_FORM.test(item.headline) || A_NOTICE.test(item.headline)) return null;
    if (headHalf !== headFull) return headHalf ? "half" : "full";
    return "unknown";
  }
  // EROAD tags its half-year "Half Yearly Report, Full Year Audit Review, Half
  // Year Accounts" — go with the majority, then the headline.
  if (half !== full) return half > full ? "half" : "full";
  if (headHalf !== headFull) return headHalf ? "half" : "full";
  return "unknown";
}

/** Every half-year or full-year report in a feed, oldest first. */
export function periodicReports(items: FeedItem[]): PeriodicReport[] {
  const out: PeriodicReport[] = [];
  for (const it of items) {
    const kind = kindOf(it);
    if (kind) out.push({ date: sydneyDate(it.date), headline: it.headline, kind });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const BACK_ON_THE_BOARDS = /admission\s+to\s+official\s+list|reinstatement\s+to\s+official\s+quotation/i;

// ── The status ───────────────────────────────────────────────────────────────

/**
 * The reports in a feed that are about a LATER period than the one Stock
 * Doctor holds, oldest first. The two rules are spelled out on
 * `reportingStatus`, which is built on this; it is exported for the route that
 * goes on to READ such a report (app/api/asx-financials).
 */
export function laterPeriodReports(items: FeedItem[], balanceDate: string): PeriodicReport[] {
  const bal = balanceDate.slice(0, 10);
  const nextPeriodEnd = addMonths(bal, 6);
  const reports = periodicReports(items).filter((r) => r.date > bal);
  const own = reports.find((r) => r.date < nextPeriodEnd);
  return reports.filter((r) =>
    r.date >= nextPeriodEnd ||
    (!!own && own.kind !== "unknown" && r.kind !== "unknown" && r.kind !== own.kind && r.date > own.date));
}

/** A results day brings a presentation and a webcast notice tagged exactly
 *  like the report. True for those — not the document with the statements. */
export function isSupportingDocument(headline: string): boolean {
  return SUPPORTING.test(headline);
}

/**
 * Classify one company.
 *
 * WHICH REPORTS ARE FOR A LATER PERIOD than the one Stock Doctor holds:
 *   1. Anything lodged on or after the next half ends. A report cannot predate
 *      the period it covers, so it cannot be about the analysed period's
 *      successor any earlier — and the analysed period's own documents (the
 *      Appendix, then the annual report a month or two later) are all in well
 *      before six months are up.
 *   2. Before that date: a report of the OTHER kind from the one lodged for
 *      the analysed period. Half years and full years alternate, so a full-year
 *      report following a half-year one is a new period however soon it comes.
 *      That is NMG: half-year accounts for March 2026 on 4 June, then — having
 *      moved its year end to June — an annual report on 24 September, a week
 *      before rule 1 would have noticed.
 *
 * `today` is passed in so this can be tested against any date.
 */
export function reportingStatus(
  items: FeedItem[],
  balanceDate: string,
  today: string,
): Omit<ReportingStatus, "checkedAt"> | null {
  const bal = balanceDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bal)) return null;
  const now = today.slice(0, 10);

  const nextPeriodEnd = addMonths(bal, 6);
  const deadlineMonths: 2 | 3 = lodgesAppendix(items) ? 2 : 3;
  const dueBy = addMonths(nextPeriodEnd, deadlineMonths);

  const newer = laterPeriodReports(items, bal);

  let relisted: string | undefined;
  for (const it of items) {
    const d = sydneyDate(it.date);
    if (d > bal && BACK_ON_THE_BOARDS.test(it.types.join(" ")) && (!relisted || d > relisted)) relisted = d;
  }

  const base = { balanceDate: bal, nextPeriodEnd, dueBy, deadlineMonths, relisted };
  const analysed = formatPeriod(bal);

  if (newer.length > 0) {
    // "Since when" is the first report for the next HALF where there is one:
    // a US filer's first-quarter 10-Q also counts as newer under rule 2, but
    // Stock Doctor analyses half years, so it was not behind until the second.
    const earliest = newer.filter((r) => r.date >= nextPeriodEnd)[0] ?? newer[0];
    const sameDay = newer.filter((r) => r.date === earliest.date);
    const head = sameDay.filter((r) => APPENDIX.test(r.headline))[0]
      ?? sameDay.filter((r) => !SUPPORTING.test(r.headline))[0]
      ?? earliest;
    const first = { date: head.date, headline: head.headline };
    const last = newer[newer.length - 1];
    const latest = last.date > first.date ? { date: last.date, headline: last.headline } : undefined;
    return {
      ...base, state: "reported", first, latest,
      detail:
        `Reported on the ASX ${formatDay(first.date)} ("${first.headline}") — Stock Doctor is still on ${analysed}, ` +
        `so the score is built on the older numbers.` +
        (latest ? ` Latest report: "${latest.headline}", ${formatDay(latest.date)}.` : "") +
        (relisted ? ` (Re)admitted to quotation ${formatDay(relisted)}.` : ""),
    };
  }

  if (now <= nextPeriodEnd) {
    return { ...base, state: "current", detail: `Stock Doctor holds the latest period (${analysed}).` };
  }

  const rule = deadlineMonths === 2
    ? "two months after the period, Listing Rules 4.2B / 4.3B"
    : "three months — it does not lodge an Appendix 4D/4E";
  if (now <= addDays(dueBy, GRACE_DAYS)) {
    return {
      ...base, state: "awaiting",
      detail: `Not late: the report for the period to ${formatDay(nextPeriodEnd)} is due by ${formatDay(dueBy)} (${rule}).`,
    };
  }

  // Past the deadline with nothing found. Before calling that a red flag, be
  // sure the feed actually covers the window the report would have been in.
  const oldest = items.reduce((min, it) => {
    const d = sydneyDate(it.date);
    return !min || d < min ? d : min;
  }, "");
  if (!oldest || oldest > nextPeriodEnd) {
    return {
      ...base, state: "unknown",
      detail: `The ASX feed only reaches back to ${oldest ? formatDay(oldest) : "nothing"}, not to ${formatDay(nextPeriodEnd)} — cannot tell whether a report was lodged.`,
    };
  }
  return {
    ...base, state: "overdue",
    detail:
      `No half-year or full-year report on the ASX for the period to ${formatDay(nextPeriodEnd)}. ` +
      `It was due by ${formatDay(dueBy)} (${rule}) — ${daysBetween(dueBy, now)} days ago.` +
      (relisted ? ` (Re)admitted to quotation ${formatDay(relisted)}.` : ""),
  };
}

// ── Late lodgement, measured against the right period ───────────────────────

export interface LateLodgement { date: string; detail: string }

/**
 * An Appendix 4D/4E lodged after its deadline.
 *
 * Each Appendix is measured against the period it belongs to: one lodged
 * before the next half ends is the analysed period's own; the first one after
 * that belongs to the next half. Only companies that lodge the Appendix are
 * measured, as before — it is the document the two-month rule is written for.
 *
 * `since` bounds how far back a finding is reported, the same lookback the
 * rest of the governance checks use.
 *
 * KNOWN BLIND SPOT: an Appendix lodged MORE than six months after its own
 * balance date is indistinguishable, from dates alone, from an on-time one for
 * the following half, and is read as the latter. That case is caught while it
 * is happening instead — it is exactly what `reportingStatus` calls overdue.
 */
export function lateLodgements(items: FeedItem[], balanceDate: string | null, since: string): LateLodgement[] {
  const bal = (balanceDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bal)) return [];
  const nextPeriodEnd = addMonths(bal, 6);
  const followingEnd = addMonths(bal, 12);
  const lodged = items
    .filter((i) => APPENDIX.test(`${i.headline} ${i.types.join(" ")}`) && !A_NOTICE.test(i.headline))
    .map((i) => sydneyDate(i.date))
    .filter((d) => d > bal)
    .sort();

  const pairs: [string, string][] = [];           // [period end, date lodged]
  const own = lodged.filter((d) => d < nextPeriodEnd)[0];
  if (own) pairs.push([bal, own]);
  const next = lodged.filter((d) => d >= nextPeriodEnd && d < followingEnd)[0];
  if (next) pairs.push([nextPeriodEnd, next]);

  const out: LateLodgement[] = [];
  for (const [period, date] of pairs) {
    const due = addMonths(period, 2);
    const daysLate = daysBetween(due, date);
    if (daysLate <= GRACE_DAYS || date < since.slice(0, 10)) continue;
    out.push({
      date,
      detail: `Appendix lodged ${daysLate} days after the Listing Rule 4.3A deadline ` +
              `(balance date ${period}, due ${due})`,
    });
  }
  return out;
}

// ── Self-test ────────────────────────────────────────────────────────────────

/**
 * Prove the rules on fixed, made-up feeds and fixed dates.
 *
 * There is no way to run this code on the machine it is written on, and on the
 * day it shipped not one real stock was overdue — so the case the whole thing
 * exists for could not be shown against live data. Served by
 * /api/redflags?selftest=1; returns pass/fail per case and nothing else.
 */
export function reportingSelfTest(): { ok: boolean; steps: Record<string, boolean> } {
  const item = (date: string, headline: string, types: string[]): FeedItem => ({ date, headline, types });
  const lastYearsFinal = item("2025-11-17", "FY25 Results", ["Preliminary Final Report", "Full Year Accounts"]);
  const halfYear = item("2026-05-18", "Half Yearly Report and Accounts", ["Half Yearly Report", "Half Year Accounts"]);
  // A September year end, analysed to its March half: the next report is the
  // full year, due 30 November.
  const sep = [lastYearsFinal, halfYear];
  const state = (items: FeedItem[], bal: string, today: string) => reportingStatus(items, bal, today);
  const overdue = state(sep, "2026-03-31", "2026-12-10");
  const reported = state([...sep, item("2026-11-20", "Appendix 4E and Annual Report", ["Preliminary Final Report"])], "2026-03-31", "2026-12-10");
  // No Appendix anywhere: an explorer. Three months, not two.
  const explorer = [
    item("2025-12-12", "2025 Annual Report", ["Annual Report", "Full Year Accounts"]),
    item("2026-06-04", "Half Year Accounts", ["Half Yearly Report", "Half Year Accounts"]),
  ];
  // NMG: a full-year report three months after a half-year one.
  const movedYearEnd = [...explorer, item("2026-09-24", "2026 Annual Report", ["Annual Report", "Full Year Accounts"])];
  const moved = state(movedYearEnd, "2026-03-31", "2026-11-14");
  const late = (items: FeedItem[], bal: string) => lateLodgements(items, bal, "2020-01-01");
  const onTimePair = [
    item("2026-02-19T22:00:00.000Z", "Appendix 4E and Annual Report", ["Preliminary Final Report"]),
    item("2026-08-19T22:00:00.000Z", "Appendix 4D - 30 June 2026", ["Half Yearly Report"]),
  ];
  const lateNext = late([onTimePair[0], item("2026-09-15", "Appendix 4D - 30 June 2026", ["Half Yearly Report"])], "2025-12-31");
  const lateOwn = late([item("2026-03-20", "Appendix 4E", ["Preliminary Final Report"])], "2025-12-31");

  const steps: Record<string, boolean> = {
    monthEndToMonthEnd: addMonths("2025-12-31", 2) === "2026-02-28" && addMonths("2026-06-30", 2) === "2026-08-31"
      && addMonths("2026-04-30", 8) === "2026-12-31" && addMonths("2026-03-15", 2) === "2026-05-15",
    sydneyDateOfMorningLodgement: sydneyDate("2026-06-21T22:30:00.000Z") === "2026-06-22",
    awaitingBeforeDeadline: state(sep, "2026-03-31", "2026-11-14")?.state === "awaiting"
      && state(sep, "2026-03-31", "2026-11-14")?.dueBy === "2026-11-30",
    graceDaysAreNotOverdue: state(sep, "2026-03-31", "2026-12-03")?.state === "awaiting",
    overdueAfterDeadline: overdue?.state === "overdue" && /10 days ago/.test(overdue.detail),
    reportedWhenNextPeriodIsOnTheAsx: reported?.state === "reported" && reported.first?.date === "2026-11-20",
    currentBeforeNextPeriodEnds: state(sep, "2026-03-31", "2026-08-01")?.state === "current",
    explorerGetsThreeMonths: state(explorer, "2026-03-31", "2026-12-10")?.state === "awaiting"
      && state(explorer, "2026-03-31", "2026-12-10")?.dueBy === "2026-12-31"
      && state(explorer, "2026-03-31", "2027-01-10")?.state === "overdue",
    movedYearEndIsReported: moved?.state === "reported" && moved.first?.date === "2026-09-24",
    shortFeedIsUnknownNotOverdue: state([item("2026-11-01", "Change of Director's Interest Notice", [])], "2026-03-31", "2027-01-10")?.state === "unknown",
    noticeIsNotAReport: periodicReports([item("2026-11-10", "Appendix 4E release date", ["Notification of Results/Reporting Date"])]).length === 0,
    usQuarterlyByFormName: periodicReports([item("2026-08-04", "Q2 2026 Quarterly Report - Form 10-Q", ["Periodic Reports - Other"])])[0]?.kind === "half",
    onTimeNextPeriodIsNotLate: late(onTimePair, "2025-12-31").length === 0,
    lateNextPeriodIsLate: lateNext.length === 1 && /15 days/.test(lateNext[0].detail) && /2026-06-30/.test(lateNext[0].detail),
    lateOwnPeriodIsLate: lateOwn.length === 1 && /20 days/.test(lateOwn[0].detail),
    lookbackApplies: lateLodgements([item("2026-03-20", "Appendix 4E", [])], "2025-12-31", "2026-06-01").length === 0,
  };
  return { ok: Object.keys(steps).every((k) => steps[k]), steps };
}
