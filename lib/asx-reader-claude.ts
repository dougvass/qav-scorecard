/**
 * Reading a report's statement lines with Claude. SERVER-ONLY.
 *
 * Doug, 2026-11-14: "Claude API could be worth investigating."
 *
 * WHY. The rule-based reader in lib/asx-financials.ts finds a statement line by
 * its wording. Back-tested on 20 Australian-dollar annual reports that Stock
 * Doctor had already analysed, it got the operating cash flow right on 11, the
 * equity on 13 and the EPS on 8 — it reads a 30-page half-year report well and
 * a 200-page annual report badly, because the same label turns up in a
 * parent-entity note, a segment table and a five-year summary. Choosing the
 * right one of several same-named lines is a reading problem, not a pattern
 * problem.
 *
 * WHAT CLAUDE IS ASKED TO DO — and not do. It is given the text of the handful
 * of pages around the cash flow statement and asked to point at four lines and
 * copy their figures exactly as printed, with the page and the line. It does no
 * arithmetic and no conversion: the rolling twelve months, the currency and the
 * reconciliation against Stock Doctor all stay in `deriveFromReport`, which
 * treats a reading from here exactly as it treats one from the rules. So a
 * wrong reading is still caught by the same checks and still waits for Doug.
 *
 * OFF UNTIL A KEY EXISTS. With no `ANTHROPIC_API_KEY` in the environment this
 * is never called and the rule-based reader is used, as before. Doug creates
 * the key and sets it in Vercel; nothing here stores or logs it.
 *
 * COST. The pages sent are text, about ten of them: roughly 10-20 thousand
 * input tokens and a few thousand out, so on the order of ten to twenty cents
 * a report at Claude Opus 5.5's prices — and a report is read once per stock
 * per period, not on every run.
 *
 * NOT YET RUN AGAINST A LIVE KEY (2026-11-14): there was no key to run it
 * with. The request follows the SDK's documented structured-output call; the
 * first real read is the test, and any failure falls back to the rules.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Found, ReportedFigures } from "./asx-financials";

export function claudeReaderConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

const Line = z.object({
  current: z.number().describe("The figure in the CURRENT period's column, exactly as printed; a bracketed figure is negative."),
  prior: z.number().nullable().describe("The figure in the comparative column beside it, or null if there is none."),
  page: z.number().describe("The page number given in the '=== page N ===' marker above the line."),
  text: z.string().describe("The whole line, copied exactly as it appears in the text supplied."),
});

const Reading = z.object({
  periodEnd: z.string().nullable().describe("The balance date the report is made up to, as YYYY-MM-DD."),
  months: z.number().nullable().describe("The length of the current period in months: 6 for a half year, 12 for a year, or what the report says (a changed year end can be 9 or 15)."),
  currency: z.string().describe("ISO code of the currency the statements are presented in: AUD, USD, NZD, PGK ..."),
  scale: z.number().describe("What the printed figures are multiples of: 1 for whole units, 1000 for thousands, 1000000 for millions."),
  operatingCashFlow: Line.nullable().describe("Net cash from (used in) operating activities, from the consolidated statement of cash flows."),
  totalEquity: Line.nullable().describe("Total equity (net assets) of the consolidated group, from the statement of financial position."),
  profitAttributable: Line.nullable().describe("Profit or loss after tax for the period attributable to the owners / members of the parent; if the report does not split it, the profit after tax for the period."),
  basicEps: Line.nullable().describe("Basic earnings per share for the period."),
  epsUnit: z.enum(["cents", "dollars"]).nullable().describe("Whether the basic EPS line is printed in cents (or the currency's hundredth, e.g. toea) or in whole currency units."),
  notes: z.string().describe("One or two sentences on anything unusual: a changed year end, restated comparatives, a figure that could not be found. Empty if nothing."),
});

type ReadingT = z.infer<typeof Reading>;

const SYSTEM = `You read the financial statements of companies listed on the Australian Securities Exchange and locate specific lines in them.

You will be given the text of some pages from one report, rebuilt from a PDF: each printed row is one line of text, with its figures at the end of the line, and each page starts with a marker "=== page N ===". Columns are in the printed order, so on a row with two figures the first is normally the current period and the second the comparative; read the column headings on that page to be sure, because some reports print three periods, or group and parent side by side.

Find four lines and report them exactly as printed:
- net cash from operating activities, from the consolidated statement of cash flows;
- total equity of the consolidated group, from the statement of financial position (the balance sheet);
- profit after tax attributable to the owners of the parent, from the statement of profit or loss;
- basic earnings per share, from the statement of profit or loss.

These figures feed a share valuation, so the choice of line matters more than anything else. Take each one from the primary consolidated statement itself. The same label also appears in places that are not what is wanted — the parent-entity note, segment information, a multi-year summary, a reconciliation, a "results for announcement to the market" table of percentage changes — and a figure from one of those is wrong for this purpose even though its label matches.

Copy the figures; do not calculate, convert, annualise or round them. Leave the units as the statements print them and report the multiple separately. If a line is not in the pages supplied, return null for it rather than the nearest alternative: a missing figure is handled downstream, a wrong one is not noticed.`;

/**
 * The pages worth sending: the statements sit together, so a window around the
 * cash flow statement holds all four lines, and the opening pages hold the
 * Appendix 4D/4E summary with the period and the units. With no cash flow page
 * to anchor on, the pages that mention the statements' own words most.
 */
export function pagesToSend(pages: string[][], anchorPage: number | null): number[] {
  const chosen = new Set<number>();
  for (let p = 1; p <= Math.min(3, pages.length); p++) chosen.add(p);
  if (anchorPage) {
    for (let p = Math.max(1, anchorPage - 6); p <= Math.min(pages.length, anchorPage + 3); p++) chosen.add(p);
  } else {
    const scored = pages.map((rows, i) => {
      const t = rows.join(" ").toLowerCase();
      let s = 0;
      if (/operating activities/.test(t)) s += 3;
      if (/investing activities/.test(t) && /financing activities/.test(t)) s += 3;
      if (/total equity|net assets/.test(t) && /total liabilities/.test(t)) s += 3;
      if (/earnings per share/.test(t)) s += 2;
      if (/profit (or loss )?for the (half[- ]?year|year|period)/.test(t)) s += 1;
      return { page: i + 1, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10);
    for (const x of scored) chosen.add(x.page);
  }
  return Array.from(chosen).sort((a, b) => a - b);
}

function toFound(line: ReadingT["operatingCashFlow"], multiply = 1): Found | null {
  if (!line) return null;
  return {
    current: line.current * multiply,
    prior: line.prior === null ? null : line.prior * multiply,
    third: null,
    page: line.page,
    text: line.text,
  };
}

export interface ClaudeReading {
  figures: ReportedFigures;
  notes: string;
  pages: number[];
  usage: { input: number; output: number };
}

/**
 * Ask Claude for the four lines. Throws on any failure — the caller falls back
 * to the rule-based reading and says why.
 */
export async function readWithClaude(
  pages: string[][],
  anchorPage: number | null,
  headline: string,
  timeoutMs: number,
): Promise<ClaudeReading> {
  const send = pagesToSend(pages, anchorPage);
  const text = send.map((p) => `=== page ${p} ===\n${pages[p - 1].join("\n")}`).join("\n\n");

  // One attempt, bounded by what is left of the function's time: a retry here
  // would run past the limit, and the rules are the fallback anyway.
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `The report is "${headline}". Pages ${send.join(", ")} of ${pages.length} follow.\n\n${text}`,
    }],
    output_config: {
      // Thinking is always on for this model; effort is the control. Medium:
      // the task is locating lines, not reasoning at length, and the function
      // has under a minute for the PDF and this call together.
      effort: "medium",
      format: zodOutputFormat(Reading),
    },
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to read the report");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
  const r = response.parsed_output;
  if (!r) throw new Error("Claude's answer did not match the expected shape");

  // EPS is carried in cents throughout; a line printed in dollars is converted
  // here, which is the one piece of unit handling that belongs to the reading.
  const epsMultiplier = r.epsUnit === "dollars" ? 100 : 1;
  return {
    figures: {
      periodEnd: r.periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(r.periodEnd) ? r.periodEnd : null,
      months: r.months,
      currency: (r.currency || "AUD").toUpperCase(),
      scale: r.scale === 1e3 || r.scale === 1e6 ? r.scale : 1,
      ocf: toFound(r.operatingCashFlow),
      equity: toFound(r.totalEquity),
      npat: toFound(r.profitAttributable),
      eps: toFound(r.basicEps, epsMultiplier),
    },
    notes: r.notes,
    pages: send,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
