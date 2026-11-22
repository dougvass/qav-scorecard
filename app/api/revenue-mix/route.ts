/**
 * Where a company's revenue comes from, in its own words.
 *
 *   GET /api/revenue-mix?code=NWH            -> the passages, from the latest
 *                                               annual report and results
 *                                               presentation
 *   GET /api/revenue-mix?code=NWH&list=1     -> the documents it would read
 *   GET /api/revenue-mix?code=NWH&key=<doc>  -> read one named document
 *   GET /api/revenue-mix?code=NWH&key=<doc>&pages=24,25 -> those pages, whole
 *
 * Doug, 2026-11-22: "each stock held isn't necessarily assigned to a GICS code
 * that reflects their main revenue stream. Can we scrape or review latest
 * annual report or Stock Doctor breakdown of revenue and business activities to
 * determine what commodity or other classification could impact a need to
 * sell."
 *
 * Stock Doctor's company page carries a written description of the business
 * and no revenue percentages, so the numbers have to come from the company. A
 * mining contractor is "Capital Goods" to GICS, and it is the annual report and
 * the results presentation that say three quarters of its revenue is earned on
 * gold mines. This route finds those two documents on the ASX feed and returns
 * the pages that talk about it: revenue by commodity, the segment note, work in
 * hand, major customers.
 *
 * It returns PASSAGES, not a verdict. Turning "Gold 68%, Copper 14%" printed
 * around a pie chart into a classification is a reading job, and the reviewed
 * result lives in lib/revenue-exposure.ts with the page it came from. Nothing
 * about anyone's holdings is sent here or kept: the caller names a code, and
 * the answer is public ASX material.
 */
import { BASE, Ann, entityXid, announcements } from "@/lib/asx-server";
import { pdfRows, pdfCells } from "@/lib/asx-pdf";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_KB = 45_000;
const BUDGET_MS = 50_000;

/** Phrases that introduce a revenue split. */
const CUE = /by commodity|commodity (exposure|mix|split|diversif|breakdown)|revenue by|revenue from|work[- ]in[- ]hand|order ?book|segment (revenue|information|report|result)|operating segments?|reportable segments?|disaggregat|major customers?|end[- ]?markets?|by sector|by client|by geography|principal activit|commodity price/i;
const COMMODITY = /\b(gold|copper|coal|iron ore|nickel|lithium|zinc|silver|uranium|bauxite|alumina|manganese|mineral sands|rare earths?|oil|gas|lng|platinum|diamonds?|tin|potash|salt|base metals|precious metals|battery minerals)\b/gi;

function isAnnualReport(a: Ann): boolean {
  const h = a.headline.toLowerCase();
  if (!/annual report/.test(h)) return false;
  return !/notice|general meeting|agm|governance|appendix 4g|sustainab|proxy|letter to|access to|availab|dispatch|correction|amended list/.test(h);
}

function isResultsPresentation(a: Ann): boolean {
  const h = a.headline.toLowerCase();
  if (!/presentation/.test(h)) return false;
  if (/agm|general meeting|conference|forum|roadshow|site visit|webinar|diggers|investor day/.test(h)) return false;
  return /result|full[- ]?year|fy ?\d\d|annual|half[- ]?year|1h|2h|h1|h2/.test(h);
}

function latest(list: Ann[]): Ann | null {
  return list.slice().sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

interface Passage { page: number; score: number; text: string }

/** The pages of a document most likely to hold a revenue split, best first. */
function passages(pages: string[][], max: number): Passage[] {
  const out: Passage[] = [];
  pages.forEach((rows, i) => {
    const text = rows.join("\n");
    const cues = (text.match(new RegExp(CUE.source, "gi")) ?? []).length;
    const commodities = new Set((text.match(COMMODITY) ?? []).map((m) => m.toLowerCase()));
    const percents = (text.match(/\d{1,3}(\.\d)?\s?%/g) ?? []).length;
    let score = cues * 2 + commodities.size;
    // A page naming several commodities beside percentages is the chart itself.
    if (commodities.size >= 2 && percents >= 2) score += 6;
    if (/by commodity|commodity (exposure|mix|split|diversif|breakdown)/i.test(text)) score += 6;
    if (score < 5) return;
    // Keep the rows that carry it, with a little of what surrounds them.
    const keep = new Set<number>();
    rows.forEach((r, j) => {
      COMMODITY.lastIndex = 0;
      if (CUE.test(r) || (COMMODITY.test(r) && /\d/.test(r))) {
        for (let k = Math.max(0, j - 2); k <= Math.min(rows.length - 1, j + 3); k++) keep.add(k);
      }
    });
    const picked = Array.from(keep).sort((a, b) => a - b).map((j) => rows[j]).join("\n");
    out.push({ page: i + 1, score, text: picked.slice(0, 1800) });
  });
  return out.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, max);
}

export async function GET(request: Request) {
  const started = Date.now();
  const q = new URL(request.url).searchParams;
  const code = (q.get("code") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return Response.json({ error: "code required" }, { status: 400 });
  const max = Math.min(12, Math.max(1, Number(q.get("max") ?? 6) || 6));

  try {
    const xid = await entityXid(code);
    if (!xid) return Response.json({ code, error: "not found on the ASX feed" }, { status: 404 });
    // Eighteen months back reaches the last annual report whatever the year end.
    const back = new Date(Date.now() - 550 * 86_400_000).toISOString().slice(0, 10);
    const anns = (await announcements(xid, back)).filter((a) => a.key && a.kb <= MAX_KB);

    const annual = latest(anns.filter(isAnnualReport));
    const deck = latest(anns.filter(isResultsPresentation));
    const describe = (a: Ann) => ({ headline: a.headline, date: a.date.slice(0, 10), key: a.key, kb: Math.round(a.kb), url: `${BASE}/file/${a.key}` });

    if (q.get("list") === "1") {
      const interesting = anns.filter((a) => /annual report|presentation|appendix 4e|full year|results/i.test(a.headline));
      return Response.json({
        code, annual: annual ? describe(annual) : null, presentation: deck ? describe(deck) : null,
        candidates: interesting.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map(describe),
      });
    }

    const named = q.get("key");
    const wanted = (q.get("pages") ?? "").split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
    const docs: Ann[] = named
      ? anns.filter((a) => a.key === named)
      : [deck, annual].filter((a): a is Ann => !!a);   // the deck first: it is short, and the chart is usually there
    if (!docs.length) return Response.json({ code, error: "no annual report or results presentation on the feed" }, { status: 404 });

    // `cells=1` with `key` and `pages`: the positioned fragments of those pages,
    // for a chart whose figures the rebuilt rows scramble.
    if (q.get("cells") === "1" && named && wanted.length) {
      return Response.json({ code, key: named, cells: await pdfCells(named, wanted.slice(0, 4)) });
    }

    const read = [];
    for (const d of docs) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left < 6_000) { read.push({ ...describe(d), skipped: "out of time" }); continue; }
      try {
        const { pages, numPages, read: got } = await pdfRows(d.key, Date.now() + left - 2_000);
        // `pages=25,28` returns those pages whole. A pie chart prints its labels
        // and its percentages on separate rows, so the picked rows alone can
        // leave "33%" with nothing beside it.
        const whole = wanted.filter((n) => n >= 1 && n <= pages.length)
          .map((n) => ({ page: n, score: 0, text: pages[n - 1].join("\n").slice(0, 6000) }));
        read.push({ ...describe(d), pages: numPages, pagesRead: got, passages: whole.length ? whole : passages(pages, max) });
      } catch (e) {
        read.push({ ...describe(d), error: e instanceof Error ? e.message : "could not be read" });
      }
    }
    return Response.json({ code, ms: Date.now() - started, documents: read });
  } catch (e) {
    return Response.json({ code, error: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}
