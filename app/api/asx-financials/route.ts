/**
 * Read a company's own report from the ASX, for when Stock Doctor is a period
 * behind. See lib/asx-financials.ts for what is extracted and why.
 *
 *   GET  /api/asx-financials?code=GQG&balanceDate=2025-12-31[&debug=1][&pages=23,27]
 *   GET  /api/asx-financials?selftest=1
 *   POST /api/asx-financials  { code, balanceDate }
 *
 * `balanceDate` is the period Stock Doctor holds. The route finds the report
 * for the period AFTER it (the same test the reporting check uses), downloads
 * the PDF, rebuilds its rows of text, and returns the three statement figures
 * with the page and line each came from. No Stock Doctor number is sent here:
 * the reconciliation against them is done in the browser.
 *
 * NODE runtime: this parses PDFs that run to several megabytes.
 */
import { getDocumentProxy } from "unpdf";
import { laterPeriodReports, isSupportingDocument, sydneyDate, addMonths, FeedItem } from "@/lib/reporting";
import { extractFigures, asxFinancialsSelfTest, ReportedFigures } from "@/lib/asx-financials";
import { BASE, HEADERS, Ann, entityXid, announcements } from "@/lib/asx-server";
import { claudeReaderConfigured, readWithClaude } from "@/lib/asx-reader-claude";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** A full annual report is a couple of hundred pages; the statements sit in
 *  the back half, so the whole document is read — within a time budget. */
const MAX_PAGES = 260;
const MAX_DOCS = 3;
const MAX_KB = 30_000;
const BUDGET_MS = 45_000;
/** The function's own limit is 60s; leave a margin for the response. */
const FUNCTION_MS = 56_000;
/** Claude gets what is left after the PDF, within these bounds. */
const CLAUDE_MAX_MS = 40_000;
const CLAUDE_MIN_MS = 8_000;
const FIGURES: ("ocf" | "equity" | "eps" | "npat")[] = ["ocf", "equity", "eps", "npat"];

/** Rows of text, one array per page, rebuilt from the positioned fragments. */
async function pdfRows(key: string, deadline: number): Promise<{ pages: string[][]; numPages: number; read: number }> {
  const res = await fetch(`${BASE}/file/${key}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const limit = Math.min(doc.numPages, MAX_PAGES);
  const pages: string[][] = [];
  for (let p = 1; p <= limit; p++) {
    if (Date.now() > deadline) break;
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const cells: { s: string; x: number; y: number }[] = [];
    for (const raw of content.items as { str?: string; transform?: number[] }[]) {
      const s = (raw.str ?? "").trim();
      if (!s) continue;
      cells.push({ s, x: raw.transform?.[4] ?? 0, y: raw.transform?.[5] ?? 0 });
    }
    // A printed row is the fragments sharing a baseline. Sort top to bottom,
    // start a new row when the baseline moves by more than a couple of points.
    cells.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: string[] = [];
    let current: { s: string; x: number; y: number }[] = [];
    let baseline = Number.NaN;
    const flush = () => {
      if (current.length) rows.push(current.sort((a, b) => a.x - b.x).map((c) => c.s).join(" "));
      current = [];
    };
    for (const c of cells) {
      if (isNaN(baseline) || Math.abs(c.y - baseline) > 2.2) { flush(); baseline = c.y; }
      current.push(c);
    }
    flush();
    pages.push(rows);
  }
  return { pages, numPages: doc.numPages, read: pages.length };
}

/** The documents most likely to hold the statements, best first. */
function rankDocuments(docs: Ann[]): Ann[] {
  const score = (a: Ann) => {
    const h = a.headline.toLowerCase();
    let s = 0;
    if (/accounts|financial (report|statements)/.test(h)) s += 4;
    if (/annual report/.test(h)) s += 3;
    if (/appendix\s*4[de]|\b4[de]\b/.test(h)) s += 2;
    if (/half[- ]?year(ly)? report|10-[qk]/.test(h)) s += 2;
    if (/results?/.test(h)) s += 1;
    if (a.types.some((t) => /accounts/i.test(t))) s += 1;
    return s;
  };
  return docs.slice().sort((a, b) => score(b) - score(a) || a.kb - b.kb);
}

interface Fx {
  pair: string; atPeriodEnd: number | null; atBalanceDate: number | null; average: number | null;
  points: number; error?: string;
}

/**
 * The Reserve Bank's daily exchange rates, table F11.1: units of each currency
 * per A$1. One official file covers every currency an ASX-listed company
 * reports in — including the Kina, which the market-data feeds do not carry.
 * (Yahoo was tried first and rate-limits a server: HTTP 429.)
 */
const RBA_FX_URL = "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv";
const RBA_DATE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
const RBA_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
let rbaCache: { at: number; csv: string } | null = null;

async function rbaCsv(): Promise<string> {
  if (rbaCache && Date.now() - rbaCache.at < 6 * 3_600_000) return rbaCache.csv;
  const res = await fetch(RBA_FX_URL, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  if (!res.ok) throw new Error(`RBA HTTP ${res.status}`);
  const csv = await res.text();
  rbaCache = { at: Date.now(), csv };
  return csv;
}

/**
 * Rates at the two balance dates, and the average over the reported period.
 * A date with no fixing (a weekend, a holiday) takes the last one before it.
 */
async function exchangeRates(currency: string, balanceDate: string, periodEnd: string, months: number): Promise<Fx> {
  const pair = `AUD${currency}`;
  const empty: Fx = { pair, atPeriodEnd: null, atBalanceDate: null, average: null, points: 0 };
  try {
    const lines = (await rbaCsv()).replace(/^\uFEFF/, "").split(/\r?\n/);
    let col = -1;
    for (let i = 0; i < lines.length && i < 40 && col < 0; i++) {
      const c = lines[i].split(",").map((x) => x.trim());
      if (c[0] !== "Title" && c[0] !== "Units") continue;
      for (let j = 1; j < c.length; j++) {
        if (c[j].replace(/\s+/g, "").toUpperCase() === `A$1=${currency}` || c[j].toUpperCase() === currency) { col = j; break; }
      }
    }
    if (col < 0) return { ...empty, error: `the Reserve Bank's table has no ${currency} column` };
    const series: { d: string; c: number }[] = [];
    for (const line of lines) {
      const c = line.split(",");
      const m = RBA_DATE.exec((c[0] ?? "").trim());
      if (!m) continue;
      const v = parseFloat(c[col]);
      if (!isFinite(v) || v <= 0) continue;
      const month = RBA_MONTHS.indexOf(m[2].toLowerCase());
      if (month < 0) continue;
      series.push({ d: `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`, c: v });
    }
    series.sort((a, b) => a.d.localeCompare(b.d));
    if (series.length === 0) return { ...empty, error: "no rates in the Reserve Bank's table" };
    const onOrBefore = (date: string) => {
      let v: number | null = null;
      for (const p of series) { if (p.d <= date) v = p.c; else break; }
      return v;
    };
    const from = addMonths(periodEnd, -months);
    const window = series.filter((p) => p.d > from && p.d <= periodEnd);
    const average = window.length ? window.reduce((a, p) => a + p.c, 0) / window.length : null;
    const out: Fx = { pair, atPeriodEnd: onOrBefore(periodEnd), atBalanceDate: onOrBefore(balanceDate), average, points: window.length };
    if (series[0].d > balanceDate) out.error = `the Reserve Bank's table starts ${series[0].d}`;
    return out;
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "error" };
  }
}

async function readOne(code: string, balanceDate: string, debug: boolean, showPages: number[]) {
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const xid = await entityXid(code);
  if (!xid) return { code, balanceDate, status: "not found" as const, reason: "ASX code not found" };

  const anns = await announcements(xid, balanceDate);
  const feed: FeedItem[] = anns.map((a) => ({ headline: a.headline, types: a.types, date: a.date }));
  const later = laterPeriodReports(feed, balanceDate);
  if (later.length === 0) return { code, balanceDate, status: "none" as const, reason: "No report on the ASX for a later period." };

  // The report for the NEXT half where there is one; see reportingStatus.
  const nextPeriodEnd = addMonths(balanceDate.slice(0, 10), 6);
  const head = later.filter((r) => r.date >= nextPeriodEnd)[0] ?? later[0];
  const sameDay = anns.filter((a) =>
    sydneyDate(a.date) === head.date &&
    later.some((r) => r.date === head.date && r.headline === a.headline) &&
    !isSupportingDocument(a.headline) && a.kb <= MAX_KB);
  const docs = rankDocuments(sameDay).slice(0, MAX_DOCS);
  if (docs.length === 0) return { code, balanceDate, status: "none" as const, reason: "The report is there but no readable document was found.", reportDate: head.date };

  let figures: (ReportedFigures & { candidates?: Record<string, unknown> }) | null = null;
  const sources: Record<string, { headline: string; date: string; url: string }> = {};
  const tried: { headline: string; kb: number; pages?: number; read?: number; error?: string }[] = [];
  const shown: Record<string, string[]> = {};
  // The document Claude would be shown: the one whose cash flow statement the
  // rules found, else the first that could be read.
  let best: { pages: string[][]; anchor: number | null; src: { headline: string; date: string; url: string } } | null = null;
  for (const d of docs) {
    if (Date.now() > deadline) break;
    try {
      const { pages, numPages, read } = await pdfRows(d.key, deadline);
      tried.push({ headline: d.headline, kb: Math.round(d.kb), pages: numPages, read });
      if (tried.length === 1) for (const n of showPages) if (pages[n - 1]) shown[String(n)] = pages[n - 1];
      const got = extractFigures(pages);
      const src = { headline: d.headline, date: sydneyDate(d.date), url: `${BASE}/file/${d.key}` };
      if (!best || (got.ocf && best.anchor === null)) best = { pages, anchor: got.ocf ? got.ocf.page : null, src };
      if (!figures) {
        figures = got;
        for (const k of FIGURES) if (got[k]) sources[k] = src;
      } else {
        // A later document only fills what an earlier one did not have.
        for (const k of FIGURES) {
          if (!figures[k] && got[k]) { figures[k] = got[k]; sources[k] = src; }
        }
        if (!figures.periodEnd && got.periodEnd) { figures.periodEnd = got.periodEnd; figures.months = got.months; }
        if (figures.scale === 1 && got.scale !== 1) figures.scale = got.scale;
      }
      if (figures.ocf && figures.equity && (figures.eps || figures.npat)) break;
    } catch (e) {
      tried.push({ headline: d.headline, kb: Math.round(d.kb), error: e instanceof Error ? e.message : "error" });
    }
  }
  if (!figures) return { code, balanceDate, status: "unreadable" as const, reason: "No document could be read.", tried };

  // With a key set, Claude chooses the lines and the rules' reading becomes the
  // fallback and a cross-check. Any failure — no time left, a timeout, an
  // answer in the wrong shape — leaves the rules' reading in place and says so.
  let reader: "claude" | "rules" = "rules";
  let readerNote: string | undefined;
  let agreesWithRules: Record<string, boolean> | undefined;
  if (claudeReaderConfigured() && best) {
    const timeLeft = started + FUNCTION_MS - Date.now();
    if (timeLeft < CLAUDE_MIN_MS) {
      readerNote = "No time left for Claude after reading the PDF; rule-based reading used.";
    } else {
      try {
        const claude = await readWithClaude(best.pages, best.anchor, best.src.headline, Math.min(CLAUDE_MAX_MS, timeLeft));
        agreesWithRules = {};
        for (const k of FIGURES) {
          const theirs = claude.figures[k];
          if (!theirs) continue;                       // not found by Claude: keep what the rules had
          const ours = figures[k];
          agreesWithRules[k] = !!ours && ours.current === theirs.current;
          figures[k] = theirs;
          sources[k] = best.src;
        }
        if (claude.figures.periodEnd) figures.periodEnd = claude.figures.periodEnd;
        if (claude.figures.months !== null) figures.months = claude.figures.months;
        figures.currency = claude.figures.currency;
        figures.scale = claude.figures.scale;
        reader = "claude";
        readerNote = claude.notes || undefined;
      } catch (e) {
        readerNote = `Claude could not be used (${e instanceof Error ? e.message : "error"}); rule-based reading used.`;
      }
    }
  }

  const { candidates, ...clean } = figures;
  const months = clean.months ?? (head.kind === "half" ? 6 : 12);
  const fx = clean.currency !== "AUD" && clean.periodEnd
    ? await exchangeRates(clean.currency, balanceDate.slice(0, 10), clean.periodEnd, months)
    : null;

  return {
    code, balanceDate: balanceDate.slice(0, 10), status: "read" as const,
    reportDate: head.date, kind: head.kind,
    figures: clean, sources, fx, tried,
    reader, readerNote, agreesWithRules,
    ms: Date.now() - started,
    readAt: new Date().toISOString(),
    ...(debug ? { candidates } : {}),
    ...(showPages.length ? { pageRows: shown } : {}),
  };
}

async function safe(code: string, balanceDate: string | null, debug: boolean, showPages: number[] = []) {
  if (!code) return Response.json({ error: "code required" }, { status: 400 });
  if (!balanceDate || !/^\d{4}-\d{2}-\d{2}/.test(balanceDate)) {
    return Response.json({ error: "balanceDate required (YYYY-MM-DD)" }, { status: 400 });
  }
  try {
    return Response.json(await readOne(code, balanceDate, debug, showPages));
  } catch (e) {
    return Response.json({ code, balanceDate, status: "error", reason: e instanceof Error ? e.message : "error" });
  }
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  // The reading and the arithmetic on made-up statements: pass/fail only.
  if (sp.get("selftest")) return Response.json(asxFinancialsSelfTest());
  // Which reader is in use — says only whether a key is set, never the key.
  if (sp.get("reader")) return Response.json({ reader: claudeReaderConfigured() ? "claude" : "rules" });
  // `pages=23,27` returns those pages' rows as rebuilt — for checking a reading
  // against the PDF, and for working out why a line was missed.
  const pages = (sp.get("pages") ?? "").split(",").map((n) => Number(n)).filter((n) => n > 0).slice(0, 6);
  return safe((sp.get("code") ?? "").trim().toUpperCase(), sp.get("balanceDate"), !!sp.get("debug"), pages);
}

export async function POST(request: Request) {
  const body = (await request.json()) as { code?: string; balanceDate?: string; debug?: boolean };
  return safe((body.code ?? "").trim().toUpperCase(), body.balanceDate ?? null, !!body.debug);
}
