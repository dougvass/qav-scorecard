/**
 * Month labels follow the TRADINGVIEW convention: a bar belongs to the month
 * its trading actually happened in.
 *
 * Doug, 2026-11-07: "We already know that Tradingview uses month end date when
 * Yahoo uses the 1st of next mth for the same price point ... The tradingview
 * approach makes more sense so that is what I use. Make whatever adjustments
 * you need to ensure the data always reflects this when we are discussing it."
 *
 * Yahoo stamps a monthly bar at LOCAL MIDNIGHT ON THE 1st of the month it
 * covers. Sydney is UTC+10/+11, so that instant is the last day of the month
 * BEFORE in UTC:
 *
 *   raw 1790776800 = 2026-09-30T14:00Z = 2026-10-01 Sydney = OCTOBER's bar
 *
 * Reading the month off UTC therefore labelled every ASX bar one month early —
 * ASX's 92.90 high showed as 2021-11 when it is December 2021, KLS's 7.825 as
 * 2022-03 when it is April 2022. No arithmetic was affected, because every bar
 * shifted together, but every date quoted in a chart walkthrough was out by a
 * month. Convert with the payload's own `meta.gmtoffset` instead.
 */

/** The exchange these codes trade on; also Doug's own clock. */
export const EXCHANGE_TZ = "Australia/Sydney";

/**
 * "YYYY-MM" for a Yahoo bar, in the exchange's own calendar.
 * `gmtoffset` is `chart.result[0].meta.gmtoffset`, in seconds.
 */
export function monthOf(tsSeconds: number, gmtoffset: number): string {
  const d = new Date((tsSeconds + gmtoffset) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Same, as a comparable year*12+month ordinal. */
export function monthOrdinal(tsSeconds: number, gmtoffset: number): number {
  const d = new Date((tsSeconds + gmtoffset) * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * The month it is NOW on the exchange — what "the current, incomplete month"
 * means. It has to match the bar labels: deriving it from UTC instead would,
 * for the eleven hours after a Sydney month rolls over, strip the month that
 * had only just completed and leave the series ending a month short.
 */
export function currentMonth(now?: Date): string {
  const d = now ?? new Date();
  try {
    // en-CA renders as YYYY-MM-DD, so the first seven characters are the label.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: EXCHANGE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d).slice(0, 7);
  } catch {
    // No tz database in this runtime: +10 is the smaller of the two offsets, so
    // this errs towards keeping a bar rather than stripping a complete month.
    const f = new Date(d.getTime() + 10 * 3600_000);
    return `${f.getUTCFullYear()}-${String(f.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}
