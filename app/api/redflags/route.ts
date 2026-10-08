/**
 * Red flags: the Bible's qualified-audit check (Column AR) and the corporate
 * governance "Mill Rule" (section F). See lib/redflags.ts for both specs.
 *
 *   POST /api/redflags  { codes: [{code, balanceDate?}] | string[] }   batch ≤10
 *   GET  /api/redflags?code=CCX                                        debug one
 *
 * NODE runtime, not edge: reading the Appendix 4E means parsing a PDF, and the
 * batch is capped at 10 because those PDFs run from 64KB to 18MB. That cap is
 * the point rather than a limitation — this is a check you run over holdings
 * and the top of the buy list, the way Tony does it by hand, not over 500
 * stocks.
 *
 * The ASX plumbing, all verified 2026-10-08:
 *   search    {BASE}/search/predictive?searchText=CODE   -> use `xidEntity`,
 *             NOT `xid`; `xid` returns an empty announcement list and looks
 *             like a dead endpoint.
 *   announce  {BASE}/markets/announcements?entityXids={xidEntity}&...
 *   the PDF   {BASE}/file/{documentKey}                  -> no auth, no token
 */
import { getDocumentProxy } from "unpdf";
import {
  classifyAudit, governanceHits, lateReport,
  AuditStatus, GovernanceHit, RedFlagEntry,
} from "@/lib/redflags";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://asx.api.markitdigital.com/asx-research/1.0";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

/** Governance lookback. The Mill Rule says a flag stands "until they have fixed
 *  the issue", which nothing here can judge, so we show anything recent and let
 *  Doug decide rather than flagging a company forever. */
const GOVERNANCE_YEARS = 2;

/** Above this, the filing is a bundled annual report; we read only its front
 *  pages, where the Appendix 4E cover sits. See trap 3 in lib/redflags.ts. */
const BUNDLED_KB = 1500;
const FRONT_PAGES = 20;
const FULL_PAGES = 60;

const APPENDIX = /appendix\s*4[de]\b/i;

interface Ann { headline: string; types: string[]; date: string; key: string; kb: number }

async function jget(url: string, timeout = 15_000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function entityXid(code: string): Promise<string | null> {
  const d = await jget(`${BASE}/search/predictive?searchText=${encodeURIComponent(code)}`);
  const items = ((d.data as Record<string, unknown>)?.items ?? []) as Record<string, unknown>[];
  for (const it of items) {
    if (String(it.symbol ?? "").toUpperCase() === code.toUpperCase()) {
      return it.xidEntity != null ? String(it.xidEntity) : null;
    }
  }
  return null;
}

function sizeKb(s: string): number {
  const m = /([\d.]+)\s*KB/i.exec(s ?? "");
  if (m) return parseFloat(m[1]);
  const g = /([\d.]+)\s*MB/i.exec(s ?? "");
  return g ? parseFloat(g[1]) * 1024 : Number.POSITIVE_INFINITY;
}

async function announcements(xid: string): Promise<Ann[]> {
  const today = new Date().toISOString().slice(0, 10);
  const d = await jget(
    `${BASE}/markets/announcements?entityXids=${xid}&page=0&itemsPerPage=120&summaryCountsDate=${today}`,
    20_000,
  );
  const items = ((d.data as Record<string, unknown>)?.items ?? []) as Record<string, unknown>[];
  return items.map((it) => ({
    headline: String(it.headline ?? ""),
    types: (it.announcementTypes as string[]) ?? [],
    date: String(it.date ?? ""),
    key: String(it.documentKey ?? ""),
    kb: sizeKb(String(it.fileSize ?? "")),
  }));
}

/** The SMALLEST recent Appendix 4E/4D — the short cover document that carries
 *  the structured item, not the bundled annual report. */
function pickAppendix(anns: Ann[]): Ann | null {
  const c = anns.filter((a) => APPENDIX.test(`${a.headline} ${a.types.join(" ")}`));
  if (!c.length) return null;
  return c.slice().sort((a, b) => a.kb - b.kb)[0];
}

async function appendixText(a: Ann): Promise<string> {
  const res = await fetch(`${BASE}/file/${a.key}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocumentProxy(buf);
  const limit = a.kb > BUNDLED_KB ? FRONT_PAGES : FULL_PAGES;
  const pages = Math.min(doc.numPages, limit);
  // pdfjs's own page API rather than unpdf's extractText: it is the stable
  // interface, and extracting PAGE BY PAGE is the whole point — a bundled
  // annual report runs to 250 pages and only its front matter holds the
  // Appendix 4E item (trap 3 in lib/redflags.ts).
  const out: string[] = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items as { str?: string }[];
    out.push(items.map((i) => i.str ?? "").join(" "));
  }
  return out.join("\n");
}

async function checkOne(code: string, balanceDate: string | null): Promise<RedFlagEntry & { code: string }> {
  const now = new Date().toISOString();
  const base = { code, audit: "error" as AuditStatus, governance: [] as GovernanceHit[], checkedAt: now };
  try {
    const xid = await entityXid(code);
    if (!xid) return { ...base, audit: "no filing", auditReason: "ASX code not found" };

    const anns = await announcements(xid);
    const since = new Date(Date.now() - GOVERNANCE_YEARS * 365 * 86_400_000).toISOString();
    const gov = governanceHits(anns.map((a) => ({ headline: a.headline, types: a.types, date: a.date })), since);

    const ap = pickAppendix(anns);
    if (ap) {
      const late = lateReport(balanceDate, ap.date);
      if (late) gov.push(late);
    }
    if (!ap) return { ...base, audit: "no filing", auditReason: "no Appendix 4E/4D found", governance: gov };

    let audit: AuditStatus = "unknown";
    let reason = "could not read the Appendix";
    let severity: number | undefined;
    try {
      const r = classifyAudit(await appendixText(ap));
      audit = r.status; reason = r.reason; severity = r.severity;
    } catch (e) {
      reason = `PDF unreadable: ${e instanceof Error ? e.message : "error"}`;
    }
    return {
      code, audit, auditReason: reason, auditSeverity: severity,
      auditSource: { headline: ap.headline, date: ap.date.slice(0, 10), url: `${BASE}/file/${ap.key}` },
      governance: gov, checkedAt: now,
    };
  } catch (e) {
    return { ...base, auditReason: e instanceof Error ? e.message : "error" };
  }
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const code = sp.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "code required" }, { status: 400 });
  return Response.json(await checkOne(code, sp.get("balanceDate")));
}

export async function POST(request: Request) {
  const body = (await request.json()) as { codes?: (string | { code: string; balanceDate?: string })[] };
  const raw = (body.codes ?? []).slice(0, 10);
  if (!raw.length) return Response.json({ error: "codes required" }, { status: 400 });
  const list = raw.map((c) => (typeof c === "string" ? { code: c, balanceDate: undefined } : c));
  // Sequential on purpose: these are multi-megabyte PDFs and the ASX API is a
  // third party we should not hammer with ten parallel downloads.
  const out: Record<string, RedFlagEntry> = {};
  for (const { code, balanceDate } of list) {
    const r = await checkOne(code.toUpperCase(), balanceDate ?? null);
    const { code: _c, ...entry } = r;
    out[code.toUpperCase()] = entry;
  }
  return Response.json(out);
}
