import { buildJourney } from "./journey.mjs";
import { nextStep } from "./next-step.mjs";
import { lastOfKind, verifyLedger } from "./ledger.mjs";
import { pendingApprovals } from "./approvals.mjs";
import { buildReceipt } from "./monitor.mjs";
import { certificationStatus, coverageStatement } from "./certification.mjs";
import { scheduleState, describeSchedule } from "./schedule.mjs";
import { rulePrecision, precisionReport } from "./precision.mjs";

/* The one page, drawn as what it is: a ledger.
 *
 * The product keeps an append-only ledger and pays out in receipts, so the
 * page is a ruled book. A gutter down the left carries the spine of the
 * three steps and the small labels; the body carries entries as ruled lines;
 * every figure sits right-aligned in a tabular column, and the totals have
 * the accountant's double rule above them. One serif line for the headline,
 * because a ledger has one heading and everything under it is set in the
 * hand that records facts: monospace, tabular, unadorned.
 *
 * Nothing on this page is drawn from anything but the ledger. A number that
 * was not measured is written as unmeasured, a step that did not run is not
 * inked as done, and a month Akeso did not run in is not a clean month. There
 * are no buttons: every action is a command, and the last line names it.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const when = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "");
const money = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "");

export function renderPage({ root, ledger = [], detection = null, schemaFingerprint = null, now = Date.now() }) {
  const journey = buildJourney({ detection, ledger });
  const step = nextStep({ ledger, detection });
  const coverage = certificationStatus(ledger, { schemaFingerprint, now });
  const coverageText = coverageStatement(coverage);
  const covered = coverage.certified && !coverage.stale;
  const schedule = ledger.length && covered ? describeSchedule(scheduleState(ledger, { now })) : [];
  const waiting = pendingApprovals(ledger, { now });
  const receipt = buildReceipt(ledger);
  const lastCheck = lastOfKind(ledger, "check");
  const lastFix = lastOfKind(ledger, "fix");
  const lastSweep = lastOfKind(ledger, "sweep");
  const intact = verifyLedger(ledger);
  const precision = precisionReport(rulePrecision(ledger));
  const appName = detection?.framework?.packageName || (root ? root.split("/").filter(Boolean).at(-1) : "this app");

  /* The spine: one entry per step, each a ruled line with the fact on the
     right. "done" is inked only when the step executed. */
  const failing = (lastCheck?.scenarioResults || []).filter((r) => r.outcome === "fail").length;
  /* A fact is coloured by what it means, never by which step it belongs to:
     "mismatches found" on a step that ran fine is a finding, not good news. */
  const stageFacts = {
    checked: {
      fact: lastCheck?.grade ? `grade ${lastCheck.grade}` : lastCheck ? "code read only" : "not run",
      tone: lastCheck?.grade === "A" ? "ok" : lastCheck?.grade && lastCheck.grade !== "?" ? "bad" : "",
      sub: [
        lastCheck ? when(lastCheck.at) : "",
        failing > 0 ? `${failing} failing scenario${failing === 1 ? "" : "s"}, handed to the fix` : "",
        lastCheck?.findings?.length ? lastCheck.findings.join("; ") : "",
      ].filter(Boolean),
    },
    repaired: {
      fact: lastFix ? `${lastFix.files?.length || 0} files` : journey.stages[1].state === "not_needed" ? "not needed" : "not run",
      tone: journey.stages[1].state === "done" ? "ok" : journey.stages[1].state === "failed" ? "bad" : "",
      sub: [
        lastFix ? when(lastFix.at) : "",
        lastFix?.repairs?.length ? `${lastFix.repairs.length} repairs: ${lastFix.repairs.join(", ")}` : "",
        journey.stages[1].state === "done" ? "proven: the same test passed afterwards" : journey.stages[1].state === "failed" ? "not proven: the test still fails" : "",
      ].filter(Boolean),
    },
    watched: {
      fact: !lastSweep ? "not run"
        : lastSweep.couldNotRun ? "could not run"
        : lastSweep.comparison?.comparable === false ? "compared nothing"
        : lastSweep.comparison?.clean ? "all matching" : "mismatches found",
      tone: !lastSweep ? "" : lastSweep.couldNotRun ? "bad" : lastSweep.comparison?.comparable === false ? "" : lastSweep.comparison?.clean ? "ok" : "bad",
      sub: [
        lastSweep ? when(lastSweep.at) : "",
        lastSweep && !lastSweep.couldNotRun ? `${lastSweep.comparison?.counts?.matched ?? 0} accounts compared` : "",
        lastSweep?.couldNotRun ? String(lastSweep.couldNotRun) : "",
      ].filter(Boolean),
    },
  };

  const spine = journey.stages.map((stage, i) => {
    const facts = stageFacts[stage.id];
    const last = i === journey.stages.length - 1;
    return `<div class="entry st-${stage.state}${stage.id === journey.currentId ? " current" : ""}">
      <div class="gutter"><span class="node"></span>${last ? "" : `<span class="rail"></span>`}</div>
      <div class="line">
        <span class="label">${escapeHtml(stage.label)}</span>
        <span class="fact ${facts.tone}">${escapeHtml(facts.fact)}</span>
      </div>
      ${facts.sub.length ? `<div class="subline">${facts.sub.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");

  /* The rule is written whether or not anything is waiting: a reader who
     lands on a list of accounts should never wonder whether Akeso already
     acted on it. */
  const waitingRows = waiting.length
    ? waiting.map((row) => `<div class="line ${row.ready ? "ready" : ""}">
        <span class="label">${escapeHtml(row.account)}<span class="why">${escapeHtml(row.reason || "")}</span></span>
        <span class="fig">${escapeHtml(money(row.priceMonthly))}</span>
        <span class="fact">${row.ready ? "ready for your yes" : `opens ${escapeHtml(when(row.readyAt))}`}</span>
      </div>`).join("") + `<div class="subline"><span>Akeso never removes access on its own. Nothing above has happened.</span></div>`
    : `<div class="line quiet"><span class="label">Nothing is waiting for you.</span><span class="fact">Akeso never removes access on its own</span></div>`;

  const coverageRows = [
    `<div class="line ${covered ? "on" : "quiet"}"><span class="label">${escapeHtml(coverageText.headline)}</span><span class="fact">${covered ? "covered" : "not covered"}</span></div>`,
    ...(covered ? [] : (coverageText.lines || []).slice(1).map((l) => `<div class="subline"><span>${escapeHtml(l)}</span></div>`)),
    ...schedule.map((l) => `<div class="subline"><span>${escapeHtml(l)}</span></div>`),
  ].join("");

  const receiptRows = `
    <div class="line"><span class="label">Access restored to paying customers</span><span class="fig">${receipt.accessRestored}</span></div>
    <div class="subline"><span>${receipt.verifiedRestores} confirmed by reading back</span></div>
    <div class="line"><span class="label">Access removed after cancellation</span><span class="fig">${receipt.accessRemoved}</span></div>
    <div class="subline"><span>only ever after a person said yes</span></div>
    <div class="line"><span class="label">Unpaid access exposure, per sweep</span><span class="fig">${receipt.sweeps ? `${money(receipt.unpaidAccessExposure)} / mo` : "not measured"}</span></div>
    <div class="subline"><span>at list price; exposure, not money recovered</span></div>
    <div class="line total"><span class="label">Revenue recovered</span><span class="fig">not measured</span></div>
    <div class="subline"><span>Akeso does not see your payouts, so it will not put a number here</span></div>
    ${precision?.length ? precision.map((l) => `<div class="subline"><span>${escapeHtml(l)}</span></div>`).join("") : ""}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
<style>
  :root {
    --paper:#f6f3ec; --paper2:#efebe2; --ink:#1c1b18; --ink2:#5d5950; --ink3:#8f8a7e; --rule:#dcd6c8; --rule2:#c9c2b1;
    --ok:#1f7a4d; --bad:#b23a2e; --wait:#9a6b12;
  }
  @media (prefers-color-scheme: dark) { :root {
    --paper:#131211; --paper2:#1a1917; --ink:#ece8df; --ink2:#b3ada0; --ink3:#7d786d; --rule:#2a2825; --rule2:#3a3733;
    --ok:#5ec48b; --bad:#f08a7c; --wait:#e0b45a;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.5 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
  .book { max-width:760px; margin:0 auto; padding:56px 28px 80px; }

  .masthead { display:grid; grid-template-columns:132px 1fr; align-items:baseline; padding-bottom:14px; border-bottom:1px solid var(--ink); }
  .masthead .name { font-size:13px; letter-spacing:.14em; text-transform:uppercase; }
  .masthead .meta { display:flex; justify-content:space-between; gap:16px; color:var(--ink3); font-size:12.5px; }
  .head { display:grid; grid-template-columns:132px 1fr; padding:34px 0 30px; border-bottom:1px solid var(--rule); }
  .head h1 { margin:0; font:500 30px/1.18 ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif; letter-spacing:-.008em; max-width:32ch; }
  .head .why { grid-column:2; margin:12px 0 0; color:var(--ink2); font-size:13px; line-height:1.55; max-width:60ch; }

  .section { display:grid; grid-template-columns:132px 1fr; padding:26px 0 4px; }
  .section .cap { font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink3); padding-top:9px; }
  .section .body { min-width:0; }

  .entry { display:grid; grid-template-columns:36px 1fr; align-items:start; }
  .entry .gutter { position:relative; height:100%; }
  .entry .node { position:absolute; left:6px; top:14px; width:9px; height:9px; border-radius:50%; border:1.5px solid var(--ink3); background:var(--paper); }
  .entry .rail { position:absolute; left:10px; top:24px; bottom:-14px; width:1.5px; background:var(--rule2); }
  .entry.st-done .node { background:var(--ok); border-color:var(--ok); } .entry.st-done .rail { background:var(--ok); }
  .entry.st-not_needed .node { background:var(--rule2); border-color:var(--rule2); } .entry.st-not_needed .rail { background:var(--ok); }
  .entry.st-failed .node { background:var(--bad); border-color:var(--bad); }
  .entry.st-partial .node { border-color:var(--wait); }
  .entry.st-next .node { border-color:var(--ink); border-style:dashed; }
  .entry.st-todo .label, .entry.st-todo .fact { color:var(--ink3); }
  .entry .line, .entry .subline { grid-column:2; }
  .fact.ok { color:var(--ok); } .fact.bad { color:var(--bad); }

  .line { display:flex; gap:18px; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--rule); }
  .line .label { flex:1; min-width:0; }
  .line .why { display:block; color:var(--ink3); font-size:12px; margin-top:2px; }
  .line .fig { min-width:96px; text-align:right; }
  .line .fact { color:var(--ink2); text-align:right; white-space:nowrap; }
  .line.quiet .label, .line.quiet .fact { color:var(--ink3); }
  .line.on .fact { color:var(--ok); }
  .line.ready .fact { color:var(--wait); }
  .line.total { border-top:1px solid var(--ink); border-bottom:3px double var(--ink); margin-top:8px; padding:11px 0; }
  .subline { display:flex; flex-wrap:wrap; gap:0 18px; padding:5px 0 8px; color:var(--ink3); font-size:12px; border-bottom:1px solid var(--rule); }
  .subline span { min-width:0; }
  .entry .subline { border-bottom:0; padding:4px 0 10px; }
  .entry .line { border-bottom:0; }

  .next { display:grid; grid-template-columns:132px 1fr; padding:30px 0 0; }
  .next .cap { font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink3); padding-top:12px; }
  .next pre { margin:0; padding:12px 16px; background:var(--paper2); border:1px solid var(--rule2); font:inherit; overflow-x:auto; }
  .next pre::before { content:"$ "; color:var(--ink3); }

  .colophon { margin-top:56px; padding-top:12px; border-top:1px solid var(--rule); display:flex; justify-content:space-between; gap:16px; color:var(--ink3); font-size:12px; }
  .colophon .broken { color:var(--bad); }

  @media (max-width:560px) {
    .book { padding:36px 18px 60px; }
    .masthead, .head, .section, .next { grid-template-columns:1fr; }
    .section .cap, .next .cap { padding:0 0 6px; }
    .head .why { grid-column:1; }
    .line { flex-wrap:wrap; }
    .line .fact { white-space:normal; text-align:left; width:100%; }
    .colophon { flex-direction:column; gap:4px; }
  }
</style></head><body><div class="book">

  <div class="masthead">
    <span class="name">Akeso</span>
    <span class="meta"><span>${escapeHtml(appName)}</span><span>${escapeHtml(new Date(now).toISOString().slice(0, 10))}</span></span>
  </div>

  <div class="head">
    <span></span>
    <h1>${escapeHtml(step.headline)}</h1>
    ${step.why ? `<p class="why">${escapeHtml(step.why)}</p>` : ""}
  </div>

  <div class="section">
    <span class="cap">Steps</span>
    <div class="body">${spine}</div>
  </div>

  <div class="section">
    <span class="cap">Waiting</span>
    <div class="body">${waitingRows}</div>
  </div>

  <div class="section">
    <span class="cap">Coverage</span>
    <div class="body">${coverageRows}</div>
  </div>

  <div class="section">
    <span class="cap">Receipts</span>
    <div class="body">${receiptRows}</div>
  </div>

  ${step.command ? `<div class="next"><span class="cap">Next</span><pre>${escapeHtml(step.command)}</pre></div>` : ""}

  <div class="colophon">
    <span>${ledger.length} entries in .akeso/ledger.jsonl</span>
    <span class="${intact.intact ? "" : "broken"}">${intact.intact ? "chain unbroken" : `chain BROKEN at entry ${intact.brokenAt}`}</span>
  </div>

  <div class="colophon" style="border-top:0;margin-top:6px;padding-top:0">
    <span>This page is a file on your computer. Nothing was sent anywhere.</span>
    <span>${waiting.length ? "npx akeso-check approvals" : ""}</span>
  </div>

</div></body></html>`;
}
