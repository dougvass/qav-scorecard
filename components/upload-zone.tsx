"use client";

import { useCallback, useState } from "react";
import { Upload, FileText, AlertCircle } from "lucide-react";

interface UploadZoneProps {
  onFile: (file: File) => void;
  loading: boolean;
}

export function UploadZone({ onFile, loading }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      if (!file.name.endsWith(".csv")) {
        setError("Please upload a CSV file exported from Stock Doctor.");
        return;
      }
      onFile(file);
    },
    [onFile]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div className="w-full max-w-2xl mx-auto">
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`
          flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-xl cursor-pointer
          transition-all duration-200
          ${dragging
            ? "border-indigo-500 bg-indigo-50"
            : "border-gray-300 bg-gray-50 hover:bg-gray-100 hover:border-gray-400"
          }
          ${loading ? "opacity-60 pointer-events-none" : ""}
        `}
      >
        <div className="flex flex-col items-center gap-3 text-center px-6">
          {loading ? (
            <>
              <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Scoring stocks…</p>
            </>
          ) : (
            <>
              <Upload className="w-10 h-10 text-gray-400" />
              <div>
                <p className="text-sm font-semibold text-gray-700">
                  Drop your Stock Doctor CSV here
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  or click to browse — Windows-1252 encoding handled automatically
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <FileText className="w-3.5 h-3.5" />
                <span>Stock Doctor → Stock Filter → Export to CSV</span>
              </div>
            </>
          )}
        </div>
        <input
          type="file"
          accept=".csv"
          className="hidden"
          disabled={loading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>

      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
