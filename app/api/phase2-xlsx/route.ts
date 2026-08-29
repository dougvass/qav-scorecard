/**
 * POST /api/phase2-xlsx
 *
 * Accepts a QAV analysis workbook (.xlsx) as multipart/form-data.
 * Reads the "QAV_updated" sheet and extracts:
 *   - Column AQ  "6. PE Hi/Lo"   → S_pe_hi_lo  (2 = lowest, 0 = middle, -1 = highest)
 *   - Column AR  "7. Equity Inc" → S_equity_inc (1 = increasing, 0 = not)
 *
 * Returns: Record<string, { S_equity_inc: number|null, S_pe_hi_lo: number|null }>
 *
 * The header row in QAV_updated is row 36 (Excel) = row index 35 (0-based).
 */

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

interface Phase2Result {
  S_equity_inc: number | null;
  S_pe_hi_lo: number | null;
  /** Balance date of the last reported numbers (col D "Last Period Analysed"),
   *  ISO yyyy-mm-dd. Drives the data-freshness rule: don't buy on numbers
   *  older than 6 months — hold off during reporting season until new data. */
  lastPeriod: string | null;
}

function toScore(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** Excel date cell → ISO yyyy-mm-dd. Handles Date objects (cellDates), Excel
 *  serial numbers, and pre-formatted strings. */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && isFinite(v) && v > 20000 && v < 80000) {
    // Excel serial (1900 epoch): days since 1899-12-30
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    // cellDates so "Last Period Analysed" comes through as Date, not serial
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array", cellDates: true });

    // Locate the data sheet + header row. Two layouts are supported:
    //   • legacy QAV analysis workbook — sheet "QAV_updated", headers on row 36
    //     ("6. PE Hi/Lo", "7. Equity Inc", "Last Period Analysed")
    //   • Market Index ASX workbook — sheet "All ASX Listed Companies", headers
    //     on row 9, with the QAV columns inserted at D-F ("PE Hi/Lo",
    //     "Equity Increasing", "Last Reported")
    // Rather than hard-coding either, scan the first 40 rows of each sheet for
    // the row that carries a "Code" column plus at least one QAV metric.
    const isCode   = (h: string) => h.trim().toLowerCase() === "code";
    const isPe     = (h: string) => /pe\s*hi\s*\/?\s*lo/i.test(h);
    const isEquity = (h: string) => /equity\s*inc/i.test(h);
    const isPeriod = (h: string) => /last\s*period\s*analysed|last\s*reported|period\s*end/i.test(h);

    /** Both layouts can carry two columns that match the same test: the legacy
     *  sheet has the SCORED "7. Equity Inc" (1/0) alongside the raw
     *  "Is Equity increasing YoY last 3years? (Y/N)". We want the score, and
     *  the score's header is always the terser of the two. */
    const pickShortest = (headers: string[], test: (h: string) => boolean) =>
      headers.filter(test).sort((a, b) => a.length - b.length)[0];

    // Sheets we know by name, checked before the generic scan so a workbook
    // holding several candidate sheets (the legacy one also has "Newdata" and
    // "Olddata" snapshots) always resolves to the live one.
    const PREFERRED_SHEETS = ["QAV_updated", "All ASX Listed Companies"];

    // Take the BEST match, not the first: the legacy workbook has a "Newdata"
    // sheet carrying Code + a date but neither metric, which would otherwise
    // win simply by sitting earlier in the workbook and silently drop every
    // PE Hi/Lo and Equity score.
    let rows: Record<string, unknown>[] | null = null;
    let peHiLoKey = "", equityIncKey = "", lastPeriodKey = "", bestScore = 0;

    const ordered = [
      ...PREFERRED_SHEETS.filter(s => wb.SheetNames.includes(s)),
      ...wb.SheetNames.filter(s => !PREFERRED_SHEETS.includes(s)),
    ];

    for (const sheetName of ordered) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet?.["!ref"]) continue;
      const maxScan = Math.min(XLSX.utils.decode_range(sheet["!ref"]).e.r, 40);
      for (let headerRow = 0; headerRow <= maxScan; headerRow++) {
        const probe = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          range: headerRow, defval: null,
        });
        if (!probe.length) continue;
        const headers = Object.keys(probe[0]);
        if (!headers.some(isCode)) continue;
        const pe = pickShortest(headers, isPe);
        const eq = pickShortest(headers, isEquity);
        const lp = pickShortest(headers, isPeriod);
        // weight the two scores above the date — the date alone is not a QAV sheet
        const score = (pe ? 2 : 0) + (eq ? 2 : 0) + (lp ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          rows = probe;
          peHiLoKey = pe ?? ""; equityIncKey = eq ?? ""; lastPeriodKey = lp ?? "";
        }
        if (score > 0) break; // header row found on this sheet; move to the next
      }
      if (bestScore === 5) break;  // full match — no better sheet exists
    }

    if (!rows) {
      return NextResponse.json(
        { error: "No QAV data sheet found — expected a sheet with a 'Code' column plus " +
                 "'PE Hi/Lo', 'Equity Increasing' or a last-reported date column" },
        { status: 422 }
      );
    }

    const codeKey = Object.keys(rows[0]).find(isCode) ?? "Code";
    const results: Record<string, Phase2Result> = {};

    for (const row of rows) {
      const code = String(row[codeKey] ?? "").trim().toUpperCase();
      if (!code || code === "CODE") continue;

      const entry: Phase2Result = {
        S_pe_hi_lo:   toScore(row[peHiLoKey]),
        S_equity_inc: toScore(row[equityIncKey]),
        lastPeriod:   toIsoDate(row[lastPeriodKey]),
      };
      // The Market Index sheet lists every ASX line (~2,700 rows, most with no
      // QAV data yet). Keep only rows carrying at least one value, so a mostly
      // empty sheet doesn't wipe existing scores or bloat localStorage.
      if (entry.S_pe_hi_lo !== null || entry.S_equity_inc !== null || entry.lastPeriod !== null) {
        results[code] = entry;
      }
    }

    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to parse XLSX" },
      { status: 500 }
    );
  }
}
