import type { Metadata } from "next";

// The ETF page is a client component, which cannot export metadata itself.
export const metadata: Metadata = {
  title: "QAV ETF & LIC Ranker",
  description: "ASX ETFs and listed investment companies ranked by 3PTL trend, net yield, fee and total return.",
};

export default function EtfLayout({ children }: { children: React.ReactNode }) {
  return children;
}
