import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QAV Scorecard — ASX Stock Ranker",
  description:
    "Upload a Stock Doctor CSV and get an instant QAV (Quality At Value) scorecard for every ASX stock",
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
