import { verifyLedger } from "./ledger.mjs";

/* Receipts: one line per action, and the statement at the end of the month.
 *
 * WHY THIS FILE EXISTS. The way a product like this dies is quiet: it runs for
 * five months, nothing dramatic happens, and the founder cancels saying "it
 * never caught anything." The only honest answer to that is a statement that
 * can say what was done, what was at stake, and what it cost. So this file
 * turns the ledger into that statement, and it is held to the same rule as
 * everything else here: nothing on the page that was not measured.
 *
 * Three things it will not do, each because the flattering version of it is how
 * these products start lying:
 *
 *   1. It never blends the three numbers. Exposure at list price, direct cost
 *      prevented, and revenue actually recovered answer different questions.
 *      One combined figure would overstate all three, so there is no total.
 *   2. It never reports zero as if zero were a measurement. A month with no
 *      sweeps says "Akeso did not run", and a month with no completed sweep
 *      says so too. Neither is a clean month. That distinction is the whole
 *      credibility of the statement.
 *   3. It never states a fact the ledger entry does not contain. Every clause
 *      in an action line is built from a field that is actually present.
 *
 * Pure functions only. Reading the ledger and writing the file happen at the
 * edges, so all of this is testable with a plain array.
 */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/* Same escaping as the Check report. Account identifiers are the founder's
   data, not our markup, and one of them containing a bracket must never become
   a tag on the page. */
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/* Every time in this file is UTC and every rendering says so once. A receipt
   whose clock is ambiguous is worth less than no clock at all. */
const clockOf = (iso) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(iso)) ? String(iso).slice(11, 16) : null);

const dayOf = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!match) return null;
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${MONTHS_SHORT[monthIndex]} ${Number(match[3])}`;
};

const money = (amount) => `$${(Math.round(amount * 100) / 100).toFixed(2)}`;

/* ------------------------------------------------------------- one action */

/* One restore, in one line a founder can read out loud. Every clause is
   optional because every clause comes from a field that may not be there: an
   entry written by an older sweep knows the account and the outcome but not
   the plan name or what Stripe said, and inventing those is the exact failure
   this product exists to prevent. */
export function actionReceipt(entry) {
  if (!entry || entry.kind !== "restore") {
    return "This entry is not an access change, so there is nothing to describe.";
  }

  const account = entry.account === undefined || entry.account === null || entry.account === ""
    ? "an account with no id recorded"
    : `account ${entry.account}`;
  const plan = entry.plan ?? entry.tier ?? null;
  const applied = entry.result === "applied";
  const confirmed = applied && entry.verified === true;
  const direction = entry.direction === "grant" || entry.direction === "remove" ? entry.direction : null;

  /* The verb carries the honesty. "Restored" is only earned by a change that
     was applied AND read back; everything else is "tried to", which is what
     actually happened. */
  const what = direction === "grant" ? `${plan || "access"} for ${account}`
    : direction === "remove" ? `${plan ? `${plan} ` : ""}access for ${account}`
    : `access for ${account}`;
  const opening = confirmed
    ? (direction === "remove" ? `Removed ${what}.` : `Restored ${what}.`)
    : (direction === "remove" ? `Tried to remove ${what}.` : `Tried to restore ${what}.`);

  const evidence = [];
  if (entry.stripeStatus) {
    const since = dayOf(entry.stripeSince);
    evidence.push(`Stripe said ${entry.stripeStatus}${since ? ` since ${since}` : ""}`);
  }
  if (entry.before === false) evidence.push("the app said no access");
  else if (entry.before === true) evidence.push("the app still gave access");

  const changedAt = clockOf(entry.at);
  const confirmedAt = clockOf(entry.verifiedAt ?? entry.at);
  let outcome;
  if (confirmed) {
    const verb = direction === "remove" ? "Changed" : "Fixed";
    outcome = changedAt && confirmedAt
      ? `${verb} ${changedAt}, confirmed ${confirmedAt} UTC.`
      : "Confirmed by reading the account back afterwards.";
  } else if (applied) {
    /* Applied but not read back. Doctrine: success is claimed only after the
       re-read agrees, so this does not count as a restore anywhere. */
    outcome = `${changedAt ? `Changed ${changedAt} UTC. ` : ""}Akeso could not read it back to confirm, so it does not count as a restore. Check this account yourself.`;
  } else {
    /* A call that failed tells us nothing about what the app now holds, so
       this line must not claim "nothing changed". */
    const why = entry.reason || entry.error || (entry.result ? `the app answered ${entry.result}` : null);
    outcome = `The change was not confirmed${why ? ` (${why})` : ""}, so it is not counted. Check this account yourself.`;
  }

  return [opening, evidence.length ? `${evidence.join(", ")}.` : null, outcome].filter(Boolean).join(" ");
}

/* -------------------------------------------------------- the month, folded */

/* Folds the whole ledger down to one calendar month. Takes the entire history
   on purpose: the chain can only be checked from its own beginning, and a
   statement that cannot say whether its evidence was edited is just a claim. */
export function monthlyStatement(entries = [], { month, now = new Date() } = {}) {
  const asOf = new Date(now);
  if (Number.isNaN(asOf.getTime())) throw new TypeError("monthlyStatement needs a real date for now");

  const target = month ?? `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
  /* A month string we do not understand would quietly match nothing and print
     "Akeso did not run", which is a lie about the software rather than a
     complaint about the argument. */
  if (!MONTH_PATTERN.test(target)) throw new TypeError(`month must look like 2026-08, got ${JSON.stringify(month)}`);

  const year = Number(target.slice(0, 4));
  const monthNumber = Number(target.slice(5, 7));
  const monthLabel = `${MONTHS_LONG[monthNumber - 1]} ${year}`;

  const all = Array.isArray(entries) ? entries : [];
  const dated = all.filter((entry) => typeof entry?.at === "string");
  const inMonth = dated.filter((entry) => entry.at.slice(0, 7) === target);
  const unreadable = all.filter((entry) => entry?.kind === "unreadable").length;
  const undated = all.length - dated.length - unreadable;

  /* ---- sweeps. "Ran" means it produced a comparison. A sweep that could not
     read both sides measured nothing, and our failure is never a verdict about
     the customer's app. */
  const sweepEntries = inMonth.filter((entry) => entry.kind === "sweep");
  const ran = sweepEntries.filter((entry) => entry.comparison && typeof entry.comparison === "object");
  const couldNotRun = sweepEntries.filter((entry) => !(entry.comparison && typeof entry.comparison === "object"));
  const cleanSweeps = ran.filter((entry) => entry.comparison.clean === true);

  /* ---- restores. Confirmed means applied AND read back afterwards. An
     "applied" that was never verified is a failure here, never a success:
     counting it would let the statement claim work it cannot prove. */
  const restores = inMonth.filter((entry) => entry.kind === "restore");
  const confirmed = restores.filter((entry) => entry.result === "applied" && entry.verified === true);
  const notConfirmed = restores.filter((entry) => !(entry.result === "applied" && entry.verified === true));
  const accessRestored = confirmed.filter((entry) => entry.direction === "grant").length;
  const accessRemoved = confirmed.filter((entry) => entry.direction === "remove").length;

  const failures = notConfirmed.map((entry) => ({
    account: entry.account ?? null,
    direction: entry.direction ?? null,
    why: entry.result === "applied"
      ? "the change was made but Akeso could not read it back to confirm"
      : `the change did not complete${entry.result ? ` (${entry.result})` : ""}`,
  }));

  /* ---- number one of three: what was at stake, at list price. Averaged only
     over sweeps that actually measured it, because a month of failed sweeps
     averaging to zero would read as "nothing was leaking". */
  const measuredExposure = ran
    .map((entry) => entry.comparison.monthlyExposure)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const unpaidAccessExposure = measuredExposure.length
    ? Math.round((measuredExposure.reduce((sum, value) => sum + value, 0) / measuredExposure.length) * 100) / 100
    : null;

  /* ---- coverage. Today counts as a day that should have had a sweep, so a
     monitor that stopped this morning shows up as a gap immediately rather
     than at midnight. */
  const monthStart = Date.UTC(year, monthNumber - 1, 1);
  const nextMonth = Date.UTC(year, monthNumber, 1);
  const daysInMonth = new Date(nextMonth - 86400000).getUTCDate();
  const daysInWindow = asOf.getTime() < monthStart ? 0
    : asOf.getTime() >= nextMonth ? daysInMonth
    : asOf.getUTCDate();
  /* Only a completed sweep covers a day. A day whose only attempt failed
     measured nothing, and letting a dead Stripe key look like coverage is
     exactly the kind of false comfort this statement is for. */
  const daysMeasured = new Set(ran.map((entry) => entry.at.slice(0, 10))).size;
  const daysWithNoSweep = Math.max(0, daysInWindow - daysMeasured);

  const didNotRun = sweepEntries.length === 0;
  const nothingMeasured = ran.length === 0;

  const notes = [];
  if (didNotRun) {
    notes.push(`Akeso did not run in ${monthLabel}. No sweep happened, so nothing was measured. A month with no sweeps is not a clean month.`);
  } else if (nothingMeasured) {
    const reason = couldNotRun.map((entry) => entry.couldNotRun).filter(Boolean).at(-1);
    notes.push(`Akeso tried ${couldNotRun.length} time${couldNotRun.length === 1 ? "" : "s"} this month and could not complete a sweep${reason ? `. The last reason was: ${reason}` : ""}. That is a problem with the run, not a verdict about your app.`);
  } else if (couldNotRun.length) {
    notes.push(`${couldNotRun.length} sweep${couldNotRun.length === 1 ? "" : "s"} could not run and measured nothing. Those are problems with the run, not findings about your app.`);
  }
  if (!didNotRun && daysWithNoSweep > 0) {
    notes.push(`${daysWithNoSweep} day${daysWithNoSweep === 1 ? "" : "s"} of this month had no completed sweep. Anything that went wrong and came back on those days would not appear here.`);
  }
  if (failures.length) {
    notes.push(`${failures.length} access change${failures.length === 1 ? " was" : "s were"} not confirmed by reading the account back, so ${failures.length === 1 ? "it is" : "they are"} not counted as restored.`);
  }
  if (unreadable) notes.push(`${unreadable} ledger entr${unreadable === 1 ? "y" : "ies"} could not be read, so nothing in ${unreadable === 1 ? "it" : "them"} is counted here.`);
  if (undated > 0) notes.push(`${undated} ledger entr${undated === 1 ? "y has" : "ies have"} no timestamp and could not be placed in a month.`);
  if (!didNotRun && !nothingMeasured && !failures.length && cleanSweeps.length === ran.length) {
    notes.push(`Every completed sweep found every account matching Stripe.`);
  }

  const headline = didNotRun ? `Akeso did not run in ${monthLabel}.`
    : nothingMeasured ? `Akeso could not complete a sweep in ${monthLabel}.`
    : accessRestored > 0 ? `Akeso restored access for ${accessRestored} paying customer${accessRestored === 1 ? "" : "s"} in ${monthLabel}.`
    : accessRemoved > 0 ? `Akeso removed access from ${accessRemoved} canceled customer${accessRemoved === 1 ? "" : "s"} in ${monthLabel}.`
    : daysWithNoSweep === 0 ? `Akeso checked every day of ${monthLabel} and found nothing wrong.`
    : `Akeso ran ${ran.length} sweep${ran.length === 1 ? "" : "s"} in ${monthLabel} and found nothing wrong on those days.`;

  const subheadline = didNotRun
    ? "No sweep happened this month, so there is nothing here that was measured."
    : nothingMeasured
      ? "Every attempt failed before it could read both sides. Nothing here is a verdict about your app."
      : accessRestored > 0 || accessRemoved > 0
        ? "Each change below was read back afterwards to confirm it held."
        : daysWithNoSweep === 0
          ? "Every account's access agreed with Stripe on every day that was checked."
          : "On the days it ran, every account's access agreed with Stripe.";

  const whatHappensNext = didNotRun
    ? "Start the monitor again. Until it runs, this month cannot be called clean."
    : nothingMeasured
      ? "Find out why the sweeps could not finish, usually a Stripe key or an app that was not reachable, then run one by hand."
      : failures.length
        ? "Look at the accounts listed as not confirmed. Akeso will not call them restored until it can read them back."
        : daysWithNoSweep > 0
          ? "Put the sweep on a schedule so the gaps close. Days without a sweep are days this statement cannot speak for."
          : "Nothing needs you. Akeso keeps sweeping and only interrupts when a person is affected.";

  return {
    month: target,
    monthLabel,
    headline,
    subheadline,
    whatHappensNext,
    didNotRun,
    nothingMeasured,

    sweeps: sweepEntries.length,
    sweepsClean: cleanSweeps.length,
    sweepsCouldNotRun: couldNotRun.length,
    sweepsWithDrift: ran.filter((entry) => entry.comparison.clean === false).length,

    accessRestored,
    accessRemoved,
    restoresVerified: confirmed.length,
    restoresFailed: notConfirmed.length,
    failures,

    /* The three numbers. Separate keys, separate reasons, never a total. */
    unpaidAccessExposure,
    unpaidAccessExposureNote: unpaidAccessExposure === null
      ? "Not measured. No sweep this month completed a reading, so there is nothing to average."
      : `Average across the ${measuredExposure.length} sweep${measuredExposure.length === 1 ? "" : "s"} that measured it. This is the list price of access being given away, not money you will get back.`,
    unpaidAccessExposureSweeps: measuredExposure.length,
    directCostPrevented: null,
    directCostPreventedNote: "Not measured. Akeso does not see your hosting or support costs, so it will not put a number here.",
    revenueRecovered: null,
    revenueRecoveredNote: "Not measured. Akeso does not see your payouts, so it will not put a number here.",

    notes,
    actions: restores.map((entry) => ({
      account: entry.account ?? null,
      direction: entry.direction ?? null,
      confirmed: entry.result === "applied" && entry.verified === true,
      at: entry.at,
      line: actionReceipt(entry),
    })),
    coverage: {
      firstSweepAt: ran[0]?.at ?? null,
      lastSweepAt: ran.at(-1)?.at ?? null,
      daysWithNoSweep,
      daysMeasured,
      daysInWindow,
    },
    history: historyOf(all),
    generatedAt: asOf.toISOString(),
  };
}

/* Whether the evidence behind this statement was edited after it was written.
   Only answerable when we were handed the history from its beginning: checking
   a slice would report a break that is really just a missing start, and a false
   tamper alarm is worse than an honest "not checked". */
function historyOf(entries) {
  if (!entries.length) return { checked: false, reason: "there is no history to check yet" };
  if ((entries[0].prev ?? null) !== null) {
    return { checked: false, reason: "this is part of the history, not the whole of it, so the chain could not be checked from the start" };
  }
  const result = verifyLedger(entries);
  return { checked: true, ...result };
}

/* -------------------------------------------------------------- rendering */

const label = (text) => `  ${text.padEnd(36)}`;

/* The terminal version. Same facts, same order, same refusals as the page. */
export function renderStatementText(statement) {
  const lines = [];
  lines.push(``);
  lines.push(`Akeso statement for ${statement.monthLabel}`);
  lines.push(`Times are UTC.`);
  lines.push(``);
  lines.push(statement.headline);
  lines.push(statement.subheadline);
  lines.push(``);

  lines.push(`${label("Sweeps that finished")}: ${statement.sweeps === 0 ? "none" : statement.sweeps - statement.sweepsCouldNotRun}`);
  lines.push(`${label("Of those, everything matched")}: ${statement.sweeps === 0 ? "not measured" : statement.sweepsClean}`);
  lines.push(`${label("Sweeps that could not run")}: ${statement.sweepsCouldNotRun}`);
  lines.push(`${label("Days with no finished sweep")}: ${statement.coverage.daysWithNoSweep} of ${statement.coverage.daysInWindow}`);
  lines.push(``);
  lines.push(`${label("Access restored to paying people")}: ${statement.accessRestored}`);
  lines.push(`${label("Access removed after cancelling")}: ${statement.accessRemoved}`);
  lines.push(`${label("Confirmed by reading it back")}: ${statement.restoresVerified}`);
  lines.push(`${label("Changes that did not confirm")}: ${statement.restoresFailed}`);
  lines.push(``);
  lines.push(`${label("Unpaid access exposure")}: ${statement.unpaidAccessExposure === null ? "not measured" : `${money(statement.unpaidAccessExposure)} a month at list price`}`);
  lines.push(`    ${statement.unpaidAccessExposureNote}`);
  lines.push(`${label("Direct cost prevented")}: not measured`);
  lines.push(`    ${statement.directCostPreventedNote}`);
  lines.push(`${label("Revenue recovered")}: not measured`);
  lines.push(`    ${statement.revenueRecoveredNote}`);
  lines.push(``);
  lines.push(`These three numbers are never added together. They answer different questions,`);
  lines.push(`and one figure made out of all three would overstate every one of them.`);

  if (statement.actions.length) {
    lines.push(``);
    lines.push(`What was done`);
    for (const action of statement.actions) lines.push(`  ${action.line}`);
  }

  if (statement.notes.length) {
    lines.push(``);
    lines.push(`Worth knowing`);
    for (const note of statement.notes) lines.push(`  ${note}`);
  }

  lines.push(``);
  lines.push(`History`);
  lines.push(`  ${historyLine(statement.history)}`);
  lines.push(``);
  lines.push(`What happens next`);
  lines.push(`  ${statement.whatHappensNext}`);
  lines.push(``);
  return lines.join("\n");
}

/* Tamper-EVIDENT, never tamper-proof: the chain lives on the same machine as
   anyone who could rewrite it, and someone who recomputes the hashes leaves no
   trace. Claiming more than this is the overclaim an auditor finds first. */
function historyLine(history) {
  if (!history?.checked) return `Not checked: ${history?.reason || "the history was not available"}.`;
  if (!history.intact) return `Broken at entry ${history.brokenAt}: ${history.reason}. Treat the numbers above as unproven.`;
  return `${history.entries} entries, chain unbroken. Tamper-evident: an entry changed after it was written shows up here.`;
}

/* ------------------------------------------------------------------- page */

/* The same page furniture as the Check report: same variables, same card,
   same wordmark, same rows. A founder should not be able to tell that two
   different files drew these. */
export function renderStatementHtml(statement) {
  const row = ({ tone = "", mark = "", name, detail = "" }) =>
    `<div class="row${tone ? ` ${tone}` : ""}"><span class="mark">${mark}</span><span class="name">${escapeHtml(name)}</span><span class="detail">${escapeHtml(detail)}</span></div>`;

  const checkedRows = [
    row({
      tone: statement.didNotRun ? "mute" : "",
      mark: statement.didNotRun ? "?" : "",
      name: "Sweeps that finished",
      detail: statement.didNotRun ? "none, so nothing was measured" : String(statement.sweeps - statement.sweepsCouldNotRun),
    }),
    row({
      tone: statement.didNotRun || statement.nothingMeasured ? "mute" : "",
      name: "Of those, everything matched",
      detail: statement.didNotRun || statement.nothingMeasured ? "not measured" : String(statement.sweepsClean),
    }),
    row({
      tone: statement.sweepsCouldNotRun ? "warn" : "",
      mark: statement.sweepsCouldNotRun ? "!" : "",
      name: "Sweeps that could not run",
      detail: statement.sweepsCouldNotRun ? `${statement.sweepsCouldNotRun}, a problem with the run, not with your app` : "0",
    }),
    row({
      tone: statement.coverage.daysWithNoSweep ? "warn" : "",
      mark: statement.coverage.daysWithNoSweep ? "!" : "",
      name: "Days with no finished sweep",
      detail: `${statement.coverage.daysWithNoSweep} of ${statement.coverage.daysInWindow}`,
    }),
  ].join("\n");

  const doneRows = [
    row({
      tone: statement.accessRestored ? "ok" : "",
      mark: statement.accessRestored ? "✓" : "",
      name: "Access restored to paying people",
      detail: String(statement.accessRestored),
    }),
    row({ name: "Access removed after cancelling", detail: String(statement.accessRemoved) }),
    row({ name: "Confirmed by reading it back", detail: String(statement.restoresVerified) }),
    row({
      tone: statement.restoresFailed ? "warn" : "",
      mark: statement.restoresFailed ? "!" : "",
      name: "Changes that did not confirm",
      detail: statement.restoresFailed ? `${statement.restoresFailed}, not counted as restored` : "0",
    }),
  ].join("\n");

  const numberRows = [
    row({
      tone: statement.unpaidAccessExposure === null ? "mute" : "",
      mark: statement.unpaidAccessExposure === null ? "?" : "",
      name: "Unpaid access exposure",
      detail: statement.unpaidAccessExposure === null ? "not measured" : `${money(statement.unpaidAccessExposure)} a month at list price`,
    }),
    row({ tone: "mute", mark: "?", name: "Direct cost prevented", detail: "not measured" }),
    row({ tone: "mute", mark: "?", name: "Revenue recovered", detail: "not measured" }),
  ].join("\n");

  const numberNotes = [
    statement.unpaidAccessExposureNote,
    statement.directCostPreventedNote,
    statement.revenueRecoveredNote,
  ].map((note) => `<li>${escapeHtml(note)}</li>`).join("\n");

  const actionRows = statement.actions.map((action) =>
    `<div class="row ${action.confirmed ? "ok" : "warn"}"><span class="mark">${action.confirmed ? "✓" : "!"}</span><span class="name wide">${escapeHtml(action.line)}</span></div>`,
  ).join("\n");

  const noteItems = statement.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso Statement · ${escapeHtml(statement.monthLabel)}</title>
<style>
  :root { --bg:#f5f6f8; --card:#ffffff; --ink:#16181d; --ink2:#4f5666; --ink3:#878e9b; --line:#e8eaee;
    --ok:#12784b; --warn:#96620a; --bad:#b3261e; --note:#2f4a78; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0e12; --card:#14171d; --ink:#e9ebef; --ink2:#a8aeba;
    --ink3:#767d8a; --line:#262b33; --ok:#4cbe83; --warn:#dfa94c; --bad:#ef8578; --note:#8aa9dc; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:664px; margin:0 auto; padding:32px 20px 64px; }
  .local { text-align:center; font-size:12.5px; color:var(--ink3); margin:0 0 18px; }
  .shell { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:40px 48px 44px;
    box-shadow:0 1px 2px rgba(16,20,28,.04), 0 8px 24px -18px rgba(16,20,28,.18); }
  .brand { display:flex; align-items:baseline; gap:7px; padding-bottom:24px; margin-bottom:36px; border-bottom:1px solid var(--line); }
  .brand .wordmark { font-size:15px; font-weight:600; letter-spacing:-.01em; }
  .brand .wordmarkSub { font-size:15px; color:var(--ink3); }
  .brand .when { margin-left:auto; font-size:12.5px; color:var(--ink3); font-variant-numeric:tabular-nums; }
  .gradeCard { display:flex; gap:26px; align-items:center; }
  .gradeCard h1 { margin:0 0 7px; font-size:22px; font-weight:600; letter-spacing:-.015em; line-height:1.25; }
  .gradeCard p { margin:0; color:var(--ink2); font-size:14.5px; }
  .app { font-size:12.5px; color:var(--ink3); margin-top:10px; }
  h2 { font-size:11.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); margin:46px 0 4px; }
  .intro { margin:4px 0 14px; color:var(--ink2); font-size:13.5px; max-width:56ch; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; gap:12px; padding:12px 2px; border-bottom:1px solid var(--line); align-items:baseline; font-size:14px; }
  .mark { width:18px; text-align:center; flex:none; font-weight:600; }
  .row.ok .mark { color:var(--ok); } .row.warn .mark { color:var(--warn); }
  .row.bad .mark { color:var(--bad); } .row.bad .name { color:var(--bad); font-weight:600; }
  .row.note .mark { color:var(--note); } .row.mute { color:var(--ink3); }
  .name { flex:1; } .name.wide { flex:auto; }
  .detail { color:var(--ink3); font-size:12.5px; text-align:right; max-width:40%; }
  ul.limits { margin:8px 0 0; padding-left:18px; color:var(--ink2); font-size:13.5px; }
  ul.limits li { margin-bottom:7px; }
  .cta { margin-top:48px; border:1px solid var(--line); border-radius:12px; padding:24px 26px;
    background:color-mix(in srgb, var(--ink) 2.5%, transparent); }
  .cta h3 { margin:0 0 6px; font-size:16px; font-weight:600; } .cta p { margin:0; color:var(--ink2); font-size:13.5px; }
  footer { margin-top:24px; text-align:center; font-size:12px; color:var(--ink3); }
</style></head><body><div class="wrap">
  <div class="local">This statement is a file on your computer. Nothing was sent anywhere.</div>
  <div class="shell">
  <div class="brand"><span class="wordmark">Akeso</span><span class="wordmarkSub">Statement</span><span class="when">${escapeHtml(statement.month)}</span></div>
  <div class="gradeCard">
    <div>
      <h1>${escapeHtml(statement.headline)}</h1>
      <p>${escapeHtml(statement.subheadline)}</p>
      <div class="app">${escapeHtml(statement.monthLabel)} · all times UTC</div>
    </div>
  </div>

  <h2>What was checked</h2>
  <p class="intro">A sweep compares who Stripe says is paying against who your app actually lets in. Only a sweep that finished counts as a day that was checked.</p>
  <div class="rows">${checkedRows}</div>

  <h2>What was done</h2>
  <p class="intro">Access is only counted as restored once Akeso has read the account back and seen the change hold.</p>
  <div class="rows">${doneRows}</div>

  <h2>The three numbers</h2>
  <p class="intro">These are never added together. They answer different questions, and one figure made out of all three would overstate every one of them.</p>
  <div class="rows">${numberRows}</div>
  <ul class="limits">${numberNotes}</ul>
${statement.actions.length ? `
  <h2>Every change, one line each</h2>
  <div class="rows">${actionRows}</div>
` : ""}${statement.notes.length ? `
  <h2>Worth knowing</h2>
  <ul class="limits">${noteItems}</ul>
` : ""}
  <h2>History</h2>
  <ul class="limits"><li>${escapeHtml(historyLine(statement.history))}</li></ul>

  <div class="cta"><h3>What happens next</h3><p>${escapeHtml(statement.whatHappensNext)}</p></div>
  </div>
  <footer>Akeso Statement · ${escapeHtml(statement.monthLabel)} · ${statement.sweeps - statement.sweepsCouldNotRun} finished sweeps · local run</footer>
</div></body></html>`;
}
