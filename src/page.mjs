import { JOURNEY_CSS, buildJourney, renderJourney } from "./journey.mjs";
import { nextStep } from "./next-step.mjs";
import { lastOfKind, verifyLedger } from "./ledger.mjs";
import { pendingApprovals } from "./approvals.mjs";
import { buildReceipt } from "./monitor.mjs";
import { certificationStatus, coverageStatement } from "./certification.mjs";
import { scheduleState, describeSchedule } from "./schedule.mjs";
import { rulePrecision, precisionReport } from "./precision.mjs";

/* The one page.
 *
 * The master document allows exactly one page, "Settings and Receipts", and
 * says that if a second page gets designed, ask whether it is a dashboard in
 * disguise. This is that page: everything Akeso knows about this app, read
 * from the ledger on disk, drawn as the same three-step loop the terminal and
 * the report use, with what is waiting for a human right under it.
 *
 * It is a file on the founder's machine, like the report. It has no buttons
 * that do anything, on purpose: every action is a command, and the page names
 * the command. That keeps the write path where it already is, behind the
 * safety gate, instead of behind a click.
 *
 * Nothing on this page is drawn from anything but the ledger. A number that
 * was not measured is shown as unmeasured, a stage that did not run is not
 * coloured done, and a month Akeso did not run in is not a clean month.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const when = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "");

export function renderPage({ root, ledger = [], detection = null, schemaFingerprint = null, now = Date.now() }) {
  const journey = buildJourney({ detection, ledger });
  const journeyHtml = renderJourney(journey, { escape: escapeHtml });
  const step = nextStep({ ledger, detection });

  const coverage = certificationStatus(ledger, { schemaFingerprint, now });
  const coverageText = coverageStatement(coverage);
  /* Schedule lines only once coverage is on. Before certification a sweep is
     a look, not a watch, and "no gaps since Akeso started watching" under a
     headline saying it is not watching reads as a contradiction. */
  const schedule = ledger.length && coverage.certified && !coverage.stale ? describeSchedule(scheduleState(ledger, { now })) : [];
  const waiting = pendingApprovals(ledger, { now });
  const receipt = buildReceipt(ledger);
  const lastSweep = lastOfKind(ledger, "sweep");
  const lastCheck = lastOfKind(ledger, "check");
  const lastFix = lastOfKind(ledger, "fix");
  const intact = verifyLedger(ledger);

  const precision = precisionReport(rulePrecision(ledger));

  const appName = detection?.framework?.packageName || (root ? root.split("/").filter(Boolean).at(-1) : "this app");

  /* The three things that feed each other, in the order they feed. Each cell
     says the same three things the journey rows say, so the connection reads
     as one sentence per stage. */
  const feed = [
    {
      label: "The check found",
      value: lastCheck?.grade ? `grade ${lastCheck.grade}` : lastCheck ? "the code, unexecuted" : "nothing yet",
      detail: lastCheck ? `${when(lastCheck.at)}${lastCheck.findings?.length ? `. ${lastCheck.findings.join(". ")}.` : ""}` : "Run the check.",
      hands: (() => {
        const failing = (lastCheck?.scenarioResults || []).filter((r) => r.outcome === "fail").length;
        /* A passing check hands nothing to the fix; saying "0 failing scenarios,
           handed to the fix" describes a handoff that did not happen. */
        return failing > 0 ? `${failing} failing scenario${failing === 1 ? "" : "s"}, handed to the fix` : "";
      })(),
    },
    {
      label: "The fix wrote",
      value: lastFix ? `${lastFix.files?.length || 0} files` : "nothing yet",
      detail: lastFix ? `${when(lastFix.at)}. ${lastFix.repairs?.length || 0} repairs: ${(lastFix.repairs || []).join(", ")}` : "Nothing to hand on until the check finds something.",
      hands: lastFix ? "Correct handling from now on, handed to the monitor to keep true" : "",
    },
    {
      label: "The monitor saw",
      value: lastSweep
        ? lastSweep.couldNotRun ? "a run that could not finish"
          : lastSweep.comparison?.comparable === false ? "nothing it could compare"
          : lastSweep.comparison?.clean ? "everything matching" : "accounts that do not match"
        : "nothing yet",
      detail: lastSweep
        ? `${when(lastSweep.at)}. ${lastSweep.comparison?.counts?.matched ?? 0} accounts compared.${lastSweep.couldNotRun ? ` Stopped: ${lastSweep.couldNotRun}` : ""}`
        : "Runs after the code passes.",
      hands: waiting.length ? `${waiting.length} removal${waiting.length === 1 ? "" : "s"} handed to you to decide` : "",
    },
  ];

  const feedHtml = feed.map((cell) => `<div class="cell">
    <div class="cellLabel">${escapeHtml(cell.label)}</div>
    <div class="cellValue">${escapeHtml(cell.value)}</div>
    <div class="cellDetail">${escapeHtml(cell.detail)}</div>
    ${cell.hands ? `<div class="cellHands">${escapeHtml(cell.hands)}</div>` : ""}
  </div>`).join("");

  const waitingHtml = waiting.length
    ? waiting.map((row) => `<div class="row ${row.ready ? "warn" : "mute"}">
        <span class="mark">${row.ready ? "!" : "·"}</span>
        <span class="name">${escapeHtml(row.account)}<span class="sub">${escapeHtml(row.reason || "")}${typeof row.priceMonthly === "number" ? ` · $${row.priceMonthly.toFixed(2)} a month at list` : ""}</span></span>
        <span class="detail">${row.ready ? "ready for your yes" : `opens ${when(row.readyAt)}`}</span>
      </div>`).join("")
    : `<div class="row mute"><span class="mark">·</span><span class="name wide">Nothing is waiting for you. Akeso never takes access away on its own, so this list is the only place removals ever appear.</span></div>`;

  const numbers = [
    { label: "Access restored to paying customers", value: String(receipt.accessRestored), note: `${receipt.verifiedRestores} confirmed by reading back` },
    { label: "Access removed after cancellation", value: String(receipt.accessRemoved), note: "only ever after a person said yes" },
    { label: "Unpaid access exposure, per sweep", value: receipt.sweeps ? `$${receipt.unpaidAccessExposure.toFixed(2)} a month` : "not measured", note: "at list price. Exposure, not money recovered" },
    { label: "Revenue recovered", value: "not measured", note: "Akeso does not see your payouts, so it will not put a number here" },
  ].map((n) => `<div class="num"><div class="numValue">${escapeHtml(n.value)}</div><div class="numLabel">${escapeHtml(n.label)}</div><div class="numNote">${escapeHtml(n.note)}</div></div>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
<style>
  :root { --bg:#f5f6f8; --card:#ffffff; --ink:#16181d; --ink2:#4f5666; --ink3:#878e9b; --line:#e8eaee;
    --ok:#12784b; --warn:#96620a; --bad:#b3261e; --note:#2f4a78; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0e12; --card:#14171d; --ink:#e9ebef; --ink2:#a8aeba;
    --ink3:#767d8a; --line:#262b33; --ok:#4cbe83; --warn:#dfa94c; --bad:#ef8578; --note:#8aa9dc; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:720px; margin:0 auto; padding:32px 20px 64px; }
  .local { text-align:center; font-size:12.5px; color:var(--ink3); margin:0 0 18px; }
  .shell { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:40px 48px 44px;
    box-shadow:0 1px 2px rgba(16,20,28,.04), 0 8px 24px -18px rgba(16,20,28,.18); }
  .brand { display:flex; align-items:baseline; gap:7px; padding-bottom:24px; margin-bottom:34px; border-bottom:1px solid var(--line); }
  .brand .wordmark { font-size:15px; font-weight:600; letter-spacing:-.01em; }
  .brand .wordmarkSub { font-size:15px; color:var(--ink3); }
  .brand .when { margin-left:auto; font-size:12.5px; color:var(--ink3); font-variant-numeric:tabular-nums; }
  h1 { margin:0 0 6px; font-size:22px; font-weight:600; letter-spacing:-.015em; line-height:1.25; }
  .lede { margin:0 0 30px; color:var(--ink2); font-size:14.5px; max-width:58ch; }
  h2 { font-size:11.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); margin:44px 0 10px; }
  .intro { margin:0 0 14px; color:var(--ink2); font-size:13.5px; max-width:58ch; }
  .feed { display:grid; grid-template-columns:repeat(3, 1fr); gap:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-top:22px; }
  .cell { padding:18px 18px 16px; border-right:1px solid var(--line); position:relative; }
  .cell:last-child { border-right:0; }
  .cell:not(:last-child)::after { content:""; position:absolute; right:-7px; top:50%; width:12px; height:12px; border-top:1px solid var(--line); border-right:1px solid var(--line); transform:translateY(-50%) rotate(45deg); background:var(--card); }
  .cellLabel { font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--ink3); }
  .cellValue { font-size:17px; font-weight:600; letter-spacing:-.01em; margin:5px 0 4px; }
  .cellDetail { font-size:12.5px; color:var(--ink2); }
  .cellHands { margin-top:9px; font-size:12px; color:var(--ink3); border-top:1px dashed var(--line); padding-top:8px; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; gap:12px; padding:12px 2px; border-bottom:1px solid var(--line); align-items:baseline; font-size:14px; }
  .mark { width:18px; text-align:center; flex:none; font-weight:600; }
  .row.warn .mark { color:var(--warn); } .row.mute { color:var(--ink3); }
  .name { flex:1; } .name.wide { flex:auto; }
  .name .sub { display:block; font-size:12.5px; color:var(--ink3); }
  .detail { color:var(--ink3); font-size:12.5px; text-align:right; max-width:40%; }
  .nums { display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; }
  .num { border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .numValue { font-size:22px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .numLabel { font-size:13.5px; margin-top:2px; }
  .numNote { font-size:12px; color:var(--ink3); margin-top:4px; }
  .cover { border:1px solid var(--line); border-radius:12px; padding:18px 20px; font-size:14px; color:var(--ink2); }
  .cover.on { border-color:color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .cover .head { font-weight:600; color:var(--ink); margin-bottom:4px; }
  ul.lines { margin:8px 0 0; padding-left:18px; color:var(--ink2); font-size:13.5px; } ul.lines li { margin-bottom:6px; }
  .nextBox { margin-top:34px; border:1px solid var(--line); border-radius:12px; padding:22px 24px; background:color-mix(in srgb, var(--ink) 2.5%, transparent); }
  .nextBox .nextLabel { font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink3); }
  .nextBox h3 { margin:6px 0 5px; font-size:16.5px; font-weight:600; letter-spacing:-.01em; }
  .nextBox p { margin:0 0 14px; color:var(--ink2); font-size:13.5px; max-width:58ch; }
  pre.cmd { background:color-mix(in srgb, var(--ink) 5%, transparent); border-radius:8px; padding:13px 15px; overflow-x:auto;
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; margin:0; }
  footer { margin-top:24px; text-align:center; font-size:12px; color:var(--ink3); }
  @media (max-width:640px) { .shell { padding:28px 20px; } .feed { grid-template-columns:1fr; } .cell { border-right:0; border-bottom:1px solid var(--line); } .cell::after { display:none !important; } .nums { grid-template-columns:1fr; } }
${JOURNEY_CSS}
</style></head><body><div class="wrap">
  <div class="local">This page is a file on your computer. Nothing was sent anywhere.</div>
  <div class="shell">
  <div class="brand"><span class="wordmark">Akeso</span><span class="wordmarkSub">${escapeHtml(appName)}</span><span class="when">${escapeHtml(new Date(now).toISOString().slice(0, 10))}</span></div>

  <h1>${escapeHtml(step.headline)}</h1>
  <p class="lede">${escapeHtml(step.why || "")}</p>

  ${journeyHtml.strip}

  <div class="feed">${feedHtml}</div>

  ${journeyHtml.detail}

  <h2>Waiting for you</h2>
  <p class="intro">Akeso restores access on its own. It never removes access on its own. Anything it wants to take away sits here until you decide.</p>
  <div class="rows">${waitingHtml}</div>
  ${waiting.length ? `<pre class="cmd" style="margin-top:12px">npx akeso-check approvals</pre>` : ""}

  <h2>Coverage</h2>
  <div class="cover ${coverage.certified && !coverage.stale ? "on" : ""}">
    <div class="head">${escapeHtml(coverageText.headline)}</div>
    ${(coverageText.lines || []).slice(1).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
    ${schedule.length ? `<ul class="lines">${schedule.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}
  </div>

  <h2>Receipts</h2>
  <p class="intro">Three numbers, never added together. Only money actually collected would count as recovered, and Akeso cannot see that.</p>
  <div class="nums">${numbers}</div>
  ${precision?.length ? `<ul class="lines">${precision.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}

  <div class="nextBox">
    <div class="nextLabel">Do this next</div>
    <h3>${escapeHtml(step.headline)}</h3>
    ${step.why ? `<p>${escapeHtml(step.why)}</p>` : ""}
    ${step.command ? `<pre class="cmd">${escapeHtml(step.command)}</pre>` : ""}
  </div>

  </div>
  <footer>Akeso · ${ledger.length} entries in .akeso/ledger.jsonl · ${intact.intact ? "chain unbroken" : `chain BROKEN at entry ${intact.brokenAt}`} · every number above was read from that file</footer>
</div></body></html>`;
}
