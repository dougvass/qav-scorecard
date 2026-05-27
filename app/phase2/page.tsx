"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { BarChart2, FileSpreadsheet, Trash2, ArrowLeft, CheckCircle } from "lucide-react";
import { PHASE2_STORAGE_KEY, Phase2Entry, StoredPhase2 } from "@/lib/phase2-storage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2)   return "just now";
  if (mins < 60)  return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function peLabel(v: number | null): { text: string; cls: string } {
  if (v === null)  return { text: "—",       cls: "text-gray-300" };
  if (v > 0)       return { text: `+${v} ✓`, cls: "text-emerald-600 font-semibold" };
  if (v === 0)     return { text: "0",        cls: "text-amber-600" };
  return              { text: `${v} ✗`,       cls: "text-red-500 font-semibold" };
}

function eqLabel(v: number | null): { text: string; cls: string } {
  if (v === null) return { text: "—",    cls: "text-gray-300" };
  if (v > 0)      return { text: "+1 ✓", cls: "text-emerald-600 font-semibold" };
  return               { text: "0",      cls: "text-amber-600" };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Phase2Page() {
  const [stored, setStored]       = useState<StoredPhase2 | null>(null);
  const [uploading, setUploading] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PHASE2_STORAGE_KEY);
      if (raw) setStored(JSON.parse(raw) as StoredPhase2);
    } catch { /* ignore corrupt storage */ }
  }, []);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/phase2-xlsx", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Server error ${res.status}`);

      const record: StoredPhase2 = {
        timestamp: new Date().toISOString(),
        source: file.name,
        data: json as Record<string, Phase2Entry>,
      };
      localStorage.setItem(PHASE2_STORAGE_KEY, JSON.stringify(record));
      setStored(record);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse spreadsheet.");
    } finally {
      setUploading(false);
    }
  }

  function clearData() {
    localStorage.removeItem(PHASE2_STORAGE_KEY);
    setStored(null);
  }

  // Entries with at least one non-null score, sorted A→Z
  const entries = stored
    ? Object.entries(stored.data)
        .filter(([, v]) => v.S_pe_hi_lo !== null || v.S_equity_inc !== null)
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to scorecard
            </Link>
            <div className="w-px h-5 bg-gray-200" />
            <div className="flex items-center gap-2.5">
              <div className="bg-teal-600 rounded-lg p-1.5">
                <BarChart2 className="w-4 h-4 text-white" />
              </div>
              <span className="font-semibold text-gray-800">Phase 2 Data</span>
              <span className="text-xs text-gray-400">PE Hi/Lo · Equity Inc</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {stored && (
              <button
                onClick={clearData}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear stored data
              </button>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-60 transition-colors"
            >
              <FileSpreadsheet className={`w-4 h-4 ${uploading ? "animate-pulse" : ""}`} />
              {uploading ? "Reading…" : stored ? "Upload new version" : "Upload QAV spreadsheet"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </header>

      <main className="max-w-screen-xl mx-auto px-6 py-8 space-y-6">
        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Success flash */}
        {justSaved && (
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-700 px-5 py-3 rounded-xl text-sm">
            <CheckCircle className="w-4 h-4" />
            Saved — {entries.length} stocks stored. The main scorecard will pick this up automatically.
          </div>
        )}

        {/* Empty state */}
        {!stored && !uploading && (
          <div className="flex flex-col items-center gap-6 py-20 text-center">
            <div className="bg-teal-50 rounded-2xl p-6 border border-teal-100">
              <FileSpreadsheet className="w-12 h-12 text-teal-400 mx-auto" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-gray-900">No Phase 2 data stored yet</h2>
              <p className="text-gray-500 max-w-md">
                Upload your <strong>QAV analysis workbook</strong> (.xlsx). The app reads columns
                AQ (PE Hi/Lo) and AR (Equity Inc) from the <em>QAV_updated</em> sheet and stores
                them here. The main scorecard applies them automatically on every CSV upload.
              </p>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-xl bg-teal-600 text-white hover:bg-teal-700 transition-colors"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Upload QAV spreadsheet
            </button>
          </div>
        )}

        {/* Stored data info + table */}
        {stored && (
          <>
            {/* Meta bar */}
            <div className="flex flex-wrap items-center gap-4 bg-white border border-gray-200 rounded-xl px-5 py-3 text-sm">
              <span className="text-gray-500">
                <strong className="text-gray-800">{entries.length}</strong> stocks with Phase 2 data
              </span>
              <span className="text-gray-300">|</span>
              <span className="text-gray-500">
                From <strong className="text-gray-700">{stored.source}</strong>
              </span>
              <span className="text-gray-300">|</span>
              <span className="text-gray-500">
                Updated <strong className="text-gray-700">{timeAgo(stored.timestamp)}</strong>{" "}
                <span className="text-gray-400">
                  ({new Date(stored.timestamp).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })})
                </span>
              </span>
              <span className="ml-auto text-xs text-teal-600 bg-teal-50 px-2.5 py-1 rounded-full border border-teal-100">
                ✓ Auto-applied on scorecard
              </span>
            </div>

            {/* Scoring key */}
            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              <span className="font-semibold text-gray-600">PE Hi/Lo:</span>
              <span className="text-emerald-600 font-semibold">+2 = lowest in 3 yrs</span>
              <span className="text-amber-600">0 = middle</span>
              <span className="text-red-500 font-semibold">−1 = highest in 3 yrs</span>
              <span className="ml-4 font-semibold text-gray-600">Equity Inc:</span>
              <span className="text-emerald-600 font-semibold">+1 = increasing YoY</span>
              <span className="text-amber-600">0 = not increasing</span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">#</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Code</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">PE Hi/Lo</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">Equity Inc</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {entries.map(([code, v], idx) => {
                    const pe = peLabel(v.S_pe_hi_lo);
                    const eq = eqLabel(v.S_equity_inc);
                    return (
                      <tr key={code} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-xs text-gray-400">{idx + 1}</td>
                        <td className="px-4 py-2.5">
                          <a
                            href={`https://finance.yahoo.com/quote/${code}.AX/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold text-indigo-700 hover:underline"
                          >
                            {code}
                          </a>
                        </td>
                        <td className={`px-4 py-2.5 text-center font-mono text-sm ${pe.cls}`}>{pe.text}</td>
                        <td className={`px-4 py-2.5 text-center font-mono text-sm ${eq.cls}`}>{eq.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
