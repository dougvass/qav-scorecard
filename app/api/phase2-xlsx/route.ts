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
}

function toScore(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });

    const ws = wb.Sheets["QAV_updated"];
    if (!ws) {
      return NextResponse.json(
        { error: "Sheet 'QAV_updated' not found — upload the QAV analysis workbook" },
        { status: 422 }
      );
    }

    // Row 35 (0-based) is the header row; data begins from row 36.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      range: 35,
      defval: null,
    });

    // Find column keys robustly (substring match in case of trailing whitespace/newlines)
    const sampleHeaders = Object.keys(rows[0] ?? {});
    const peHiLoKey   = sampleHeaders.find(h => h.includes("PE Hi/Lo"))   ?? "6. PE Hi/Lo";
    const equityIncKey = sampleHeaders.find(h => h.includes("Equity Inc")) ?? "7. Equity Inc";

    const results: Record<string, Phase2Result> = {};

    for (const row of rows) {
      const code = String(row["Code"] ?? "").trim();
      if (!code || code === "Code") continue;

      results[code] = {
        S_pe_hi_lo:   toScore(row[peHiLoKey]),
        S_equity_inc: toScore(row[equityIncKey]),
      };
    }

    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to parse XLSX" },
      { status: 500 }
    );
  }
}
