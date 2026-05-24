// Client-only utility: uses TextDecoder (browser / Edge runtime)
import { StockRow } from "./types";

/**
 * Parse a Stock Doctor CSV export into StockRow[].
 *
 * SD exports:
 *  - ~35 lines of preamble before the "Code,Name,…" header
 *  - cp1252 (Windows-1252) encoded
 *  - Numbers use comma as thousands separator  (e.g. "1,234,567")
 *  - Some numeric columns arrive as strings like "1,234.56"
 */
export async function parseStockDoctorCSV(file: File): Promise<StockRow[]> {
  const buffer = await file.arrayBuffer();

  // Decode with Windows-1252 (handles the ¢ character in "EPS (¢) Fcst yr1")
  let text: string;
  try {
    text = new TextDecoder("windows-1252").decode(buffer);
  } catch {
    text = new TextDecoder("utf-8").decode(buffer);
  }

  const lines = text.split(/\r?\n/);

  // Find the header row that starts with "Code,Name"
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("Code,Name")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(
      'Could not find "Code,Name" header row. Is this a Stock Doctor CSV export?'
    );
  }

  const dataLines = lines.slice(headerIdx);

  // Simple CSV parser that handles quoted fields
  function parseLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  const headers = parseLine(dataLines[0]);

  // Columns that should be parsed as numbers (strip commas)
  const numericCols = new Set([
    "Avg Trade 3M ($000)",
    "Price Chg 5yr (%)",
    "Price Chg 6mth (%)",
    "CF: Net Operating ($)",
    "NPAT Bef Abnormals ($)",
    "Shares Outstanding (M)",
    "Share Price ($)",
    "Price to CashFlow",
    "Market Cap ($M)",
    "Div Yield (%)",
    "PE",
    "Equity ($)",
    "EPS Bef Abnormals (c)",
    "EPS (¢) Fcst yr1",
    "Rev Gth 1yr (%)",
    "Rev Gth 2yr (% pa)",
    "EPS After Abnormals (c)",
    "Interest Coverage",
    "Net Debt to Equity",
    "Prof Pretax Gth 1yr (%)",
    "Prof Pretax Gth 2yr (% pa)",
    "Consensus Tgt ($)",
    "CEO/MD + Chairman Holdings ($)",
    "All Directors' Holdings ($)",
    "ROIC (%)",
  ]);

  function parseNum(val: string): number | null {
    if (!val || val.trim() === "" || val.trim() === "N/A") return null;
    // Remove thousands commas then parse
    const cleaned = val.replace(/,/g, "").trim();
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }

  const rows: StockRow[] = [];

  for (let i = 1; i < dataLines.length; i++) {
    const line = dataLines[i].trim();
    if (!line) continue;

    const values = parseLine(line);
    if (values.length < 3) continue;

    const row: Record<string, string | number | null> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j].trim();
      const raw = (values[j] || "").trim();
      if (numericCols.has(header)) {
        row[header] = parseNum(raw);
      } else {
        row[header] = raw || "";
      }
    }

    // Skip rows without a Code
    if (!row["Code"]) continue;

    rows.push(row as unknown as StockRow);
  }

  return rows;
}
