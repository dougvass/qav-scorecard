"use client";

/**
 * QAV-over-time sparkline, plus a click-through detail chart.
 *
 * Hand-rolled SVG rather than a charting library: the whole thing is ~40 lines
 * of path maths, it renders ~450 times per table, and pulling in Recharts for
 * this would cost more bundle than the entire rest of the app.
 */

import React, { useState, useRef, useEffect } from "react";
import { HistoryPoint } from "@/lib/history-storage";

const W = 64, H = 20, PAD = 2;

/** Map points to an SVG path over the QAV series. Returns null when there is
 *  nothing meaningful to draw (fewer than two scored days). */
function pathFor(points: HistoryPoint[], w = W, h = H, pad = PAD) {
  const pts = points.filter((p) => typeof p.qav === "number") as (HistoryPoint & { qav: number })[];
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.qav);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  return {
    d: pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p.qav).toFixed(2)}`).join(" "),
    pts, min, max,
    last: { x: x(pts.length - 1), y: y(vals[vals.length - 1]) },
    xy: (i: number) => [x(i), y(pts[i].qav)] as const,
  };
}

/** Colour by direction of travel — QAV rising is the thing worth noticing. */
function trendColor(first: number, last: number) {
  if (last > first * 1.02) return "#059669"; // emerald-600
  if (last < first * 0.98) return "#dc2626"; // red-600
  return "#6b7280";                          // gray-500
}

export function QavSparkline({ points, code }: { points?: HistoryPoint[]; code: string }) {
  const [open, setOpen] = useState(false);
  const p = pathFor(points ?? []);

  if (!p) {
    return (
      <span
        className="text-xs text-gray-300 select-none"
        title={
          !points?.length
            ? "No history yet — a snapshot is saved each time you load a CSV"
            : "Only one snapshot so far; a trend needs at least two"
        }
      >
        —
      </span>
    );
  }

  const first = p.pts[0].qav, last = p.pts[p.pts.length - 1].qav;
  const color = trendColor(first, last);
  const change = first ? ((last - first) / Math.abs(first)) * 100 : 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded hover:bg-gray-100 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
        title={`${code}: QAV ${first.toFixed(1)} → ${last.toFixed(1)} (${change >= 0 ? "+" : ""}${change.toFixed(0)}%) over ${p.pts.length} snapshots — click for detail`}
      >
        <svg width={W} height={H} className="overflow-visible">
          <path d={p.d} fill="none" stroke={color} strokeWidth={1.5}
                strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={p.last.x} cy={p.last.y} r={2} fill={color} />
        </svg>
      </button>
      {open && <QavHistoryModal code={code} points={p.pts} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Full-size chart: QAV line with a 10-QAV buy-list threshold marker. */
function QavHistoryModal({
  code, points, onClose,
}: { code: string; points: (HistoryPoint & { qav: number })[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const CW = 560, CH = 220, L = 44, R = 12, T = 14, B = 28;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vals = points.map((p) => p.qav);
  // Always include the QAV=10 buy threshold in range so the line's position
  // relative to it is readable, which is the whole question being asked.
  const min = Math.min(...vals, 10), max = Math.max(...vals, 10);
  const span = max - min || 1;
  const x = (i: number) => L + (i / Math.max(1, points.length - 1)) * (CW - L - R);
  const y = (v: number) => T + (1 - (v - min) / span) * (CH - T - B);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.qav).toFixed(1)}`).join(" ");
  const ticks = [min, min + span / 2, max];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
         onClick={(e) => { if (e.target === ref.current?.parentElement) onClose(); }}>
      <div ref={ref} className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-800">{code} — QAV history</h3>
            <p className="text-xs text-gray-500">
              {points.length} snapshots · {points[0].d} → {points[points.length - 1].d}
            </p>
          </div>
          <button onClick={onClose}
                  className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100">Close</button>
        </div>

        <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} className="select-none"
             onMouseLeave={() => setHover(null)}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={L} x2={CW - R} y1={y(t)} y2={y(t)} stroke="#f3f4f6" strokeWidth={1} />
              <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#9ca3af">
                {t.toFixed(0)}
              </text>
            </g>
          ))}
          {/* QAV 10 = the buy-list cutoff */}
          <line x1={L} x2={CW - R} y1={y(10)} y2={y(10)}
                stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
          <text x={CW - R} y={y(10) - 4} textAnchor="end" fontSize={9} fill="#b45309">
            buy list ≥ 10
          </text>

          <path d={d} fill="none" stroke="#0284c7" strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />

          {points.map((p, i) => (
            <circle key={i} cx={x(i)} cy={y(p.qav)} r={hover === i ? 4 : 2.5}
                    fill={p.qav >= 10 ? "#059669" : "#dc2626"} />
          ))}
          {/* generous invisible hit areas — the real points are far too small */}
          {points.map((_, i) => (
            <rect key={`h${i}`} x={x(i) - 8} y={T} width={16} height={CH - T - B}
                  fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}

          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={CH - B}
                    stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
              <text x={Math.min(x(hover) + 6, CW - 120)} y={T + 12} fontSize={11} fill="#334155">
                {points[hover].d} · QAV {points[hover].qav.toFixed(1)}
                {points[hover].sentiment ? ` · ${points[hover].sentiment}` : ""}
              </text>
            </g>
          )}

          <text x={L} y={CH - 8} fontSize={10} fill="#9ca3af">{points[0].d}</text>
          <text x={CW - R} y={CH - 8} fontSize={10} fill="#9ca3af" textAnchor="end">
            {points[points.length - 1].d}
          </text>
        </svg>

        <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
          {([
            ["first", points[0].qav],
            ["latest", points[points.length - 1].qav],
            ["low", Math.min(...vals)],
            ["high", Math.max(...vals)],
          ] as const).map(([label, v]) => (
            <div key={label} className="rounded bg-gray-50 py-1.5">
              <div className="text-gray-400">{label}</div>
              <div className="font-semibold text-gray-700">{v.toFixed(1)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
