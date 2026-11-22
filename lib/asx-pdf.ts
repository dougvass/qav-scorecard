/**
 * An ASX document as rows of text. SERVER-ONLY (unpdf, several-megabyte PDFs).
 *
 * Moved out of the asx-financials route on 2026-11-22 so the revenue-mix route
 * can read the same documents the same way.
 */
import { getDocumentProxy } from "unpdf";
import { BASE, HEADERS } from "@/lib/asx-server";

/** Rows of text, one array per page, rebuilt from the positioned fragments. */
export async function pdfRows(key: string, deadline: number, maxPages = 260): Promise<{ pages: string[][]; numPages: number; read: number }> {
  const res = await fetch(`${BASE}/file/${key}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const limit = Math.min(doc.numPages, maxPages);
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


/**
 * One page as positioned fragments. A pie chart's figures and labels are laid
 * out around the circle, so rebuilt rows scramble them: Macmahon's FY26 slide
 * prints four charts side by side and its rows read "12 10 10 / 18 / 26 6".
 * With x and y the figures can be put back with the chart they belong to.
 */
export async function pdfCells(key: string, pageNumbers: number[]): Promise<Record<number, { s: string; x: number; y: number }[]>> {
  const res = await fetch(`${BASE}/file/${key}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
  const out: Record<number, { s: string; x: number; y: number }[]> = {};
  for (const n of pageNumbers) {
    if (n < 1 || n > doc.numPages) continue;
    const content = await (await doc.getPage(n)).getTextContent();
    out[n] = (content.items as { str?: string; transform?: number[] }[])
      .map((raw) => ({ s: (raw.str ?? "").trim(), x: Math.round(raw.transform?.[4] ?? 0), y: Math.round(raw.transform?.[5] ?? 0) }))
      .filter((c) => c.s);
  }
  return out;
}
