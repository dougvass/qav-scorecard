import type { Metadata } from "next";

// The ETF page is a client component, which cannot export metadata itself.
export const metadata: Metadata = {
  title: "QAV ETF Ranker — ASX ETFs",
  description:
    "ASX ETFs ranked by the 3-Point Trendline and net distribution yield, with the QAV score of every fund in the Stock Doctor list beside it",
};

export default function EtfLayout({ children }: { children: React.ReactNode }) {
  return children;
}
