/**
 * Web-app manifest — what makes "Add to Home Screen" produce an app rather
 * than a bookmark: its own icon, its own name, and no browser chrome.
 *
 * Doug, 2026-11-14: "how could this site be setup as an app on my iPhone home
 * screen that I can activate and refresh when needed."
 *
 * The icon and the standalone window are the easy half. What makes it USEFUL
 * on a phone is that the data is now on the server (lib/server-store.ts): sign
 * in once and the CSV, Phase 2, the 3PTL run and holdings are all there, and
 * the checks that have not run today start by themselves on opening.
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "QAV Scorecard",
    short_name: "QAV",
    description: "ASX stock ranker — Tony Kynaston's Quality At Value method",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#4f46e5",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
    ],
  };
}
