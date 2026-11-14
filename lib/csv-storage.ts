/**
 * The last Stock Doctor CSV, remembered in this browser.
 *
 * Until 2026-11-14 the CSV lived only in React state, so every visit — and
 * every refresh — started at the upload screen, and nothing downstream could
 * be automated: there was nowhere for a CSV to arrive except a file dropped
 * by hand. Doug: "Can more be automated.. eg. logging in to stock doctor,
 * running the QAV_checklist stock filter and taking the downloaded CSV and
 * importing it into the site?"
 *
 * Remembering the last one is the piece everything else hangs off:
 *   - the site reopens already scored, on the numbers last loaded;
 *   - a CSV handed over from the Stock Doctor tab (lib/sd-bridge.ts) sticks;
 *   - "open it and refresh" becomes possible, because there is something to
 *     refresh.
 *
 * Stored as the decoded TEXT of the export, not the parsed rows: the text is
 * ~155KB against ~400KB of JSON, and re-parsing it on load takes a few
 * milliseconds. localStorage is the working copy, as for every other store in
 * this app. Once Doug has set a passcode and signed in, it is also mirrored to
 * the server (lib/server-store.ts) so the same CSV opens on his phone — behind
 * the passcode, because it is Stock Doctor's subscriber data and the URL is
 * public. Signed out, it stays in this browser only.
 */

import { setSynced, removeSynced } from "./server-store";

export const CSV_STORAGE_KEY = "qav_csv_v1";

export interface StoredCsv {
  /** File name, or a generated one when it came straight from Stock Doctor. */
  name: string;
  /** ISO timestamp of when it was loaded into the site. */
  loadedAt: string;
  /** How it arrived: dropped by hand, or handed over from the Stock Doctor tab. */
  source: "upload" | "stockdoctor";
  /** The export, decoded from Windows-1252. */
  text: string;
}

export function loadStoredCsv(): StoredCsv | null {
  try {
    const raw = localStorage.getItem(CSV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCsv;
    return parsed && typeof parsed.text === "string" && parsed.text.length > 0 ? parsed : null;
  } catch {
    return null;   // unreadable is the same as absent
  }
}

/** Returns false when the browser refused it (quota). The CSV still loads for
 *  this visit; it just will not be there on the next one. */
export function saveStoredCsv(csv: StoredCsv): boolean {
  return setSynced(CSV_STORAGE_KEY, JSON.stringify(csv));
}

export function clearStoredCsv(): void {
  removeSynced(CSV_STORAGE_KEY);
}

/** "14 Nov, 11:42 am" — when the remembered CSV was loaded. */
export function formatLoadedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });
}

/** Whole days between a load and now, in local calendar days. */
export function daysSince(iso: string): number | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}
