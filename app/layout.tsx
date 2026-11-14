import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QAV Scorecard — ASX Stock Ranker",
  description:
    "Upload a Stock Doctor CSV and get an instant QAV (Quality At Value) scorecard for every ASX stock",
  // iOS: open from the home screen as its own app, without Safari's bars.
  // The icon comes from app/apple-icon.tsx and the rest from app/manifest.ts.
  appleWebApp: {
    capable: true,
    title: "QAV",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        {children}
      </body>
    </html>
  );
}
