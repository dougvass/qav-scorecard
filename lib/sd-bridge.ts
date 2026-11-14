/**
 * Stock Doctor -> QAV, without the download.
 *
 * Doug, 2026-11-14: "Can more be automated.. eg. logging in to stock doctor,
 * running the QAV_checklist stock filter and taking the downloaded CSV and
 * importing it into the site?"
 *
 * WHAT WAS LEARNED ABOUT STOCK DOCTOR (probed in his signed-in session):
 *
 *   - "Save to CSV" on /StockFilter is an ordinary form post. The page fills
 *     eight hidden fields on `#saveCsvForm` and submits it to
 *     /StockFilter/CsvExport; the server answers with the CSV as an attachment,
 *     which is what raises Chrome's save dialog.
 *   - The same post made with fetch() returns the CSV as bytes instead — no
 *     dialog, no file in Downloads. Compared against the export Doug saved by
 *     hand the same morning: header identical, all 446 rows identical and in
 *     the same order. The ONLY difference is the timestamp on the first line
 *     ("STOCKFILTER - 14 Nov 2026 11:40:41:AM"), which is why two exports are
 *     never byte-identical.
 *   - The filter's criteria must go through the page's own
 *     `validateCriteriaList(model)` first. It rewrites the operands in place
 *     ("Greater Than" -> "GreaterThan"); post the raw view-model and the server
 *     fails with "Error converting value 'Greater Than' to type
 *     SDO.Data.Operand".
 *   - A saved filter is an <li> whose id is the filter's id. Clicking it puts
 *     that id in the page's Knockout view-model (`MainFilterGroup.FilterId`)
 *     about 1.5s BEFORE its criteria arrive; the page is ready when the id
 *     matches and `jQuery.active` is back to 0. Exporting inside that gap
 *     returns a header with no rows — the first end-to-end run did exactly
 *     that.
 *   - Stock Doctor sends no Content-Security-Policy and no
 *     Cross-Origin-Opener-Policy, so a window it opens can be messaged.
 *
 * HOW THE HANDOVER WORKS. A bookmarklet, clicked on Stock Doctor's Stock Filter
 * page, loads the saved filter, fetches the export, opens this site and
 * postMessages the CSV text to it. The page (app/page.tsx) listens, accepts a
 * message ONLY from the Stock Doctor origin, loads the CSV exactly as if it had
 * been dropped, and acknowledges with the row count.
 *
 * Why postMessage and not a server endpoint: the CSV is Stock Doctor's
 * subscriber data and this site has no login, so anything stored server-side
 * would be readable by anyone with the URL. This way it travels from one of his
 * tabs to another and is kept only in his browser (lib/csv-storage.ts).
 *
 * Why a self-contained bookmarklet and not a script loaded from this site: the
 * code runs inside his signed-in Stock Doctor session, so it should be exactly
 * what he dragged to his bookmarks bar, not whatever this site serves later.
 * The cost is that a change here means dragging the bookmark again.
 *
 * It signs nobody in. If the Stock Doctor session has expired the export comes
 * back as a login page, the bookmarklet says so, and he signs in as usual.
 */

/** The only origin a CSV is accepted from. */
export const SD_ORIGIN = "https://www.stockdoctor.com.au";

/** The saved filter the bookmarklet runs. Matched by its exact name. */
export const SD_FILTER_NAME = "2. QAV_checklist";

/** Message shapes, both directions. */
export interface BridgeCsvMessage { type: "qav-csv"; name: string; csv: string }
/** `error` is set, with rows 0, when the CSV arrived but could not be read —
 *  so the sender can say why instead of waiting for an answer that never comes. */
export interface BridgeAckMessage { type: "qav-csv-ack"; rows: number; error?: string }

export function isBridgeCsvMessage(d: unknown): d is BridgeCsvMessage {
  const m = d as Partial<BridgeCsvMessage> | null;
  return !!m && m.type === "qav-csv" && typeof m.csv === "string" && m.csv.length > 0;
}

/**
 * The bookmarklet's source. String.raw so the regex backslashes and the \u
 * escapes reach the browser untouched — in an ordinary template literal `\s`
 * silently becomes `s`. Nothing in here may contain a backtick or `${`.
 *
 * Deliberately plain, old-style JavaScript: it runs on someone else's page.
 */
const BOOKMARKLET_SOURCE = String.raw`(async function () {
  var QAV = "__QAV__", FILTER = "__FILTER__";
  var box = document.getElementById("qav-bridge") || document.body.appendChild(document.createElement("div"));
  box.id = "qav-bridge";
  box.style.cssText = "position:fixed;z-index:2147483647;top:14px;right:14px;max-width:340px;background:#4338ca;color:#fff;padding:10px 14px;border-radius:10px;font:14px/1.35 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)";
  var say = function (m) { box.textContent = "QAV \u2192 " + m; };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  if (location.hostname !== "www.stockdoctor.com.au") { box.remove(); alert("Open Stock Doctor first, then click this bookmark."); return; }
  if (!/^\/StockFilter/i.test(location.pathname)) { say("opening the Stock Filter \u2014 click the bookmark again there"); location.href = "/StockFilter"; return; }
  var w = window.open(QAV + "/", "qavScorecard");
  if (!w) { say("pop-up blocked \u2014 allow pop-ups for stockdoctor.com.au, then click again"); return; }
  try {
    say("loading \u201c" + FILTER + "\u201d\u2026");
    var li = Array.prototype.slice.call(document.querySelectorAll("li[id]")).filter(function (l) { return l.textContent.replace(/\s+/g, " ").trim() === FILTER; })[0];
    if (!li) throw new Error("saved filter \u201c" + FILTER + "\u201d not found");
    (li.querySelector("a") || li).click();
    // READY means the criteria have arrived, not just the filter's id. The id
    // lands in the view-model about 1.5s BEFORE its 30 criteria do (measured:
    // id at 0.7s with ONE placeholder criterion and a request still in flight,
    // all 30 at 2.2s). Exporting in that gap posts the placeholder filter and
    // Stock Doctor answers with a header and no rows. So: this filter's id AND
    // the page's own ajax counter at zero, on two samples running.
    // setGicsSelectedNodes() must NOT be called during the wait - mid-load it
    // empties the sector selection, which also yields no rows.
    var quiet = 0;
    for (var i = 0; i < 120 && quiet < 2; i++) {
      await wait(250);
      var ok = false;
      try {
        var probe = jQuery.parseJSON(ko.toJSON(filtersViewModel.MainFilterGroup));
        ok = String(probe.FilterId) === String(li.id) && jQuery.active === 0;
      } catch (e) {}
      quiet = ok ? quiet + 1 : 0;
    }
    if (quiet < 2) throw new Error("the filter did not finish loading");
    say("exporting\u2026");
    var q = function (s) { return document.querySelector(s) || {}; };
    var text = "", n = 0;
    // An export with no rows is retried rather than sent: it means the page
    // was still settling, and an empty CSV is never what was asked for.
    for (var attempt = 0; attempt < 5 && n === 0; attempt++) {
      if (attempt) await wait(1000);
      setGicsSelectedNodes();
      var model = jQuery.parseJSON(ko.toJSON(filtersViewModel.MainFilterGroup));
      if (validateCriteriaList(model) === false) throw new Error("Stock Doctor rejected the filter's criteria");
      var body = new URLSearchParams();
      body.set("csvModel", JSON.stringify(model));
      body.set("csvPage", "1");
      body.set("csvSortField", "Code");
      body.set("csvIsDesc", "false");
      body.set("csvSortFieldId", "");
      body.set("csvSelectedGicsIds", q(".selectedSectors").value || "");
      body.set("csvIncludeUnknownGics", String(!!q("#includeUnknownGics").checked));
      body.set("csvIncludePortfolioStocks", String(!!q("#includeStocksInPort").checked));
      var res = await fetch("/StockFilter/CsvExport", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), credentials: "same-origin" });
      text = new TextDecoder("windows-1252").decode(await res.arrayBuffer());
      var at = text.indexOf("Code,Name");
      if (!res.ok || at < 0) throw new Error("Stock Doctor did not return a CSV \u2014 are you still signed in?");
      n = text.slice(at).split(/\r?\n/).filter(function (l) { return l.trim(); }).length - 1;
    }
    if (n === 0) throw new Error("Stock Doctor returned the filter with no stocks in it");
    var name = FILTER + " " + new Date().toLocaleDateString("en-CA") + ".csv";
    say("sending " + n + " stocks\u2026");
    var done = false;
    window.addEventListener("message", function (e) {
      if (e.origin === QAV && e.data && e.data.type === "qav-csv-ack") {
        done = true;
        if (e.data.error) { say("QAV could not read it: " + e.data.error); return; }
        say(e.data.rows + " stocks loaded \u2713");
        setTimeout(function () { box.remove(); }, 6000);
      }
    });
    for (var j = 0; j < 90 && !done; j++) {
      try { w.postMessage({ type: "qav-csv", name: name, csv: text }, QAV); } catch (e) {}
      await wait(400);
    }
    if (!done) say("the QAV tab did not answer \u2014 is it still open?");
  } catch (err) {
    say("failed: " + (err && err.message ? err.message : err));
  }
})();`;

/**
 * The `javascript:` URL to drag to the bookmarks bar.
 *
 * `qavOrigin` is where the CSV is sent — pass `window.location.origin`, so a
 * preview deployment hands out a bookmarklet that targets itself.
 */
export function bookmarkletHref(qavOrigin: string, filterName: string = SD_FILTER_NAME): string {
  const code = BOOKMARKLET_SOURCE
    .replace("__QAV__", qavOrigin.replace(/\/+$/, ""))
    .replace("__FILTER__", filterName.replace(/["\\]/g, ""))
    // The comments are for whoever maintains this, not for the bookmark: drop
    // every whole-line comment and the indentation. Newlines are kept, so no
    // statement depends on a semicolon that is not there.
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .join("\n");
  return "javascript:" + encodeURIComponent(code);
}
