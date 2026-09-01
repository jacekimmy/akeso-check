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

const plural = (count, one, many) => (count === 1 ? one : many);

/* Reasons written elsewhere in the product are already whole sentences. One of
   them dropped inside another sentence must not end up with two full stops. */
const clause = (text) => String(text).replace(/\s*\.\s*$/, "");

/* What each recorded outcome means, in the words a founder reads.
 *
 * The ledger stores Akeso's own classification of a write ("no_op",
 * "could_not_reach"). Printing that token raw does two bad things at once: it
 * means nothing to the reader, and in the case of could_not_reach it blames
 * the app for a call that in several paths never left this machine. */
const RESULT_MEANING = {
  /* Only reached when the change was applied and NOT read back: an applied
     change that verified is never a failure. */
  applied: "the change was made but Akeso could not read it back to confirm",
  no_op: "your app said nothing needed changing but did not say what the account reads as, so nothing was confirmed",
  conflict: "the account changed while Akeso was writing to it, so your app refused and nothing was changed",
  unsupported: "your app refused this change on purpose, so nothing was changed",
  could_not_reach: "Akeso could not reach your app, so this is a problem with the run and not a finding about your app",
  failed: "your app tried and could not make the change",
};

const whyNotCounted = (entry) => RESULT_MEANING[entry.result]
  ?? (entry.result
    ? `the change did not confirm, and Akeso recorded the outcome as "${entry.result}"`
    : "the change did not confirm, and no outcome was recorded");

/* Applied AND read back afterwards. Nothing else is a change that happened. */
const isConfirmed = (entry) => entry.result === "applied" && entry.verified === true;
/* Your app was already in the state Akeso was about to set, and said so when
   read back. That is neither a restore nor a failure, and counting it as
   either would misdescribe a run in which nothing was wrong. */
const isNoChangeNeeded = (entry) => entry.result === "no_op" && entry.verified === true;

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
  const confirmed = isConfirmed(entry);
  const nothingNeeded = isNoChangeNeeded(entry);
  const direction = entry.direction === "grant" || entry.direction === "remove" ? entry.direction : null;

  /* The verb carries the honesty. "Restored" is only earned by a change that
     was applied AND read back; everything else is "tried to", which is what
     actually happened. */
  const what = direction === "grant" ? `${plan || "access"} for ${account}`
    : direction === "remove" ? `${plan ? `${plan} ` : ""}access for ${account}`
    : `access for ${account}`;
  const opening = nothingNeeded
    ? `Nothing needed changing for ${account}.`
    : confirmed
      ? (direction === "remove" ? `Removed ${what}.` : `Restored ${what}.`)
      : (direction === "remove" ? `Tried to remove ${what}.` : `Tried to restore ${what}.`);

  const evidence = [];
  if (entry.stripeStatus) {
    const since = dayOf(entry.stripeSince);
    evidence.push(`Stripe said ${entry.stripeStatus}${since ? ` since ${since}` : ""}`);
  }
  if (entry.before === false) evidence.push("the app said no access");
  else if (entry.before === true) evidence.push("the app still gave access");
  /* The evidence starts a sentence, and which clause comes first depends on
     what the entry happens to hold. */
  const evidenceSentence = evidence.length
    ? `${evidence.join(", ").charAt(0).toUpperCase()}${evidence.join(", ").slice(1)}.`
    : null;

  const changedAt = clockOf(entry.at);
  /* Only a recorded verification time may be printed as one. `restoreEntry`
     does not carry verifiedAt, so falling back to the change time would print
     a confirmation clock, on almost every real line, for a reading whose time
     nobody wrote down. The re-read is a fact; its clock is not. */
  const confirmedAt = clockOf(entry.verifiedAt);
  let outcome;
  if (nothingNeeded) {
    outcome = `${changedAt ? `Checked ${changedAt} UTC. ` : ""}Your app already had this account in the state Akeso asked for, and read it back to say so.`;
  } else if (confirmed) {
    const verb = direction === "remove" ? "Changed" : "Fixed";
    outcome = changedAt && confirmedAt
      ? `${verb} ${changedAt}, confirmed ${confirmedAt} UTC.`
      : changedAt
        ? `${verb} ${changedAt} UTC, then read back to confirm it held.`
        : "Read back afterwards to confirm it held.";
  } else if (applied) {
    /* Applied but not read back. Doctrine: success is claimed only after the
       re-read agrees, so this does not count as a restore anywhere. */
    outcome = `${changedAt ? `Changed ${changedAt} UTC. ` : ""}Akeso could not read it back to confirm, so it does not count as a restore. Check this account yourself.`;
  } else if (entry.result === "could_not_reach") {
    /* Ours, not theirs, and several of these paths never sent anything at all.
       "The app answered could_not_reach" was both jargon and a false statement
       about the customer's app. */
    const why = entry.reason || entry.error || null;
    outcome = `Akeso could not reach your app, so it does not know whether anything changed${why ? `: ${clause(why)}` : ""}. That is a problem with the run, not a finding about your app. Check this account yourself.`;
  } else {
    /* A call that failed tells us nothing about what the app now holds, so
       this line must not claim "nothing changed". */
    const why = entry.reason || entry.error || RESULT_MEANING[entry.result] || null;
    outcome = why
      ? `The change was not confirmed: ${clause(why)}. It is not counted. Check this account yourself.`
      /* An outcome Akeso has no plain words for is still shown, because the
         alternative is a line that says a change failed and will not say
         what was recorded. */
      : `The change was not confirmed${entry.result ? `, and Akeso recorded the outcome as "${entry.result}"` : ""}. It is not counted. Check this account yourself.`;
  }

  return [opening, evidenceSentence, outcome].filter(Boolean).join(" ");
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
  /* Sorted by the time on the entry, not by where it sits in the array. The
     ledger is append-only, so the two normally agree; when a clock jumps they
     do not, and a fold that answers "first" and "last" from array position
     would then swap them. */
  const ran = sweepEntries
    .filter((entry) => entry.comparison && typeof entry.comparison === "object")
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  const couldNotRun = sweepEntries.filter((entry) => !(entry.comparison && typeof entry.comparison === "object"));
  const cleanSweeps = ran.filter((entry) => entry.comparison.clean === true);
  /* A sweep that found a disagreement is the whole reason this product exists.
     Counted separately from "not clean" so that a sweep which recorded no
     verdict at all cannot be quietly filed as either one. */
  const driftSweeps = ran.filter((entry) => entry.comparison.clean === false);
  const noVerdict = ran.length - cleanSweeps.length - driftSweeps.length;
  /* Of those, the ones that ran perfectly well and simply had nothing to
     compare: no Stripe subscription matched any account the app reported.
     Worth naming separately, because "we could not tell" and "the account ids
     do not line up" send a founder to two completely different places. */
  const comparedNothing = ran.filter((entry) => entry.comparison.comparable === false).length;
  const allClean = ran.length > 0 && cleanSweeps.length === ran.length;

  /* The verdict for the month comes from the newest completed reading, not
     from the whole month: a mismatch on the 3rd that was gone by the 4th is
     not an open mismatch, and a month that ENDED with one must never be
     described as clean. */
  const lastFinished = ran.at(-1) ?? null;
  const openMismatch = lastFinished?.comparison.clean === false;
  const lastDrift = lastFinished?.drift && typeof lastFinished.drift === "object" ? lastFinished.drift : null;
  const counted = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  /* Removals are queued for a human and never applied by a sweep, so this
     number is the one thing on the page that is genuinely waiting on the
     founder. Absent from older entries, in which case nothing is claimed. */
  const waitingForYou = lastDrift ? counted(lastDrift.removalsQueued) : null;
  const lockedOutThen = lastDrift ? counted(lastDrift.grants) : null;

  /* ---- restores. Confirmed means applied AND read back afterwards. An
     "applied" that was never verified is a failure here, never a success:
     counting it would let the statement claim work it cannot prove. */
  const restores = inMonth.filter((entry) => entry.kind === "restore");
  const confirmed = restores.filter(isConfirmed);
  const noChangeNeeded = restores.filter(isNoChangeNeeded);
  const notConfirmed = restores.filter((entry) => !isConfirmed(entry) && !isNoChangeNeeded(entry));
  const accessRestored = confirmed.filter((entry) => entry.direction === "grant").length;
  const accessRemoved = confirmed.filter((entry) => entry.direction === "remove").length;

  /* A sweep records the state it found BEFORE it restores anything, so the
     sweep that found a locked-out customer and put them back one second later
     is not evidence of an open problem. What is true is narrower and is what
     gets said: the last reading found a disagreement, these changes came
     after it, and nothing has been measured since. */
  const changedSinceLastSweep = lastFinished
    ? confirmed.filter((entry) => entry.at > lastFinished.at).length
    : 0;

  const failures = notConfirmed.map((entry) => ({
    account: entry.account ?? null,
    direction: entry.direction ?? null,
    why: whyNotCounted(entry),
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
  const measuredDays = [...new Set(ran.map((entry) => entry.at.slice(0, 10)))];
  /* A sweep dated after the moment this statement was made cannot be evidence
     about a day that has not happened yet. Three such sweeps used to fill a
     three-day window and produce "checked every day of May". A clock that
     disagrees with the ledger is worth saying out loud, not counting. */
  const daysMeasured = measuredDays.filter((day) => Number(day.slice(8, 10)) <= daysInWindow).length;
  const daysAheadOfClock = measuredDays.length - daysMeasured;
  const daysWithNoSweep = Math.max(0, daysInWindow - daysMeasured);
  const fullyCovered = daysInWindow > 0 && daysWithNoSweep === 0;

  const didNotRun = sweepEntries.length === 0;
  const nothingMeasured = ran.length === 0;

  const lastSweepDay = lastFinished ? dayOf(lastFinished.at) : null;

  const notes = [];
  if (didNotRun) {
    notes.push(`Akeso did not run in ${monthLabel}. No sweep happened, so nothing was measured. A month with no sweeps is not a clean month.`);
    if (restores.length) {
      /* Changes with no sweep behind them are real and must be visible, but
         they are not a measurement of the month either. */
      notes.push(`${restores.length} access ${plural(restores.length, "change was", "changes were")} recorded this month even though no sweep ran. ${plural(restores.length, "It is", "They are")} listed below.`);
    }
  } else if (nothingMeasured) {
    const reason = couldNotRun.map((entry) => entry.couldNotRun).filter(Boolean).at(-1);
    notes.push(`Akeso tried ${couldNotRun.length} time${couldNotRun.length === 1 ? "" : "s"} this month and could not complete a sweep${reason ? `. The last reason was: ${clause(reason)}` : ""}. That is a problem with the run, not a verdict about your app.`);
  } else if (couldNotRun.length) {
    notes.push(`${couldNotRun.length} sweep${couldNotRun.length === 1 ? "" : "s"} could not run and measured nothing. ${plural(couldNotRun.length, "That is a problem", "Those are problems")} with the run, not ${plural(couldNotRun.length, "a finding", "findings")} about your app.`);
  }
  /* The disagreement itself. Without this the page could show a month of
     sweeps that every single time found a canceled customer still being let
     in, and still say nothing was wrong. */
  if (driftSweeps.length) {
    notes.push(`${driftSweeps.length} of the ${ran.length} finished ${plural(ran.length, "sweep", "sweeps")} found at least one account whose access did not agree with Stripe.`);
  }
  if (openMismatch) {
    const detail = [
      lockedOutThen === null ? null : `${lockedOutThen} paying ${plural(lockedOutThen, "customer had", "customers had")} no access at that moment`,
      waitingForYou === null ? null : `${waitingForYou} canceled ${plural(waitingForYou, "customer", "customers")} still had access and ${plural(waitingForYou, "was", "were")} waiting for you to approve removing it`,
    ].filter(Boolean).join(", and ");
    notes.push(`The last finished sweep${lastSweepDay ? `, on ${lastSweepDay},` : ""} found access that did not agree with Stripe${detail ? `: ${detail}` : ""}.`);
    notes.push(changedSinceLastSweep
      ? `Akeso changed ${changedSinceLastSweep} account${changedSinceLastSweep === 1 ? "" : "s"} after that sweep and read each one back. Nothing has been measured since, so the next sweep is what will show whether the month ends clean.`
      : `Nothing has been changed since that sweep.`);
  }
  if (waitingForYou !== null) {
    /* Doctrine: a removal never happens without a person saying yes. If any
       are waiting, the statement is the wrong place to be quiet about it. */
    notes.push(`Akeso never takes paid access away on its own. Run npx akeso-check approvals to see what is waiting for you.`);
  }
  if (comparedNothing > 0) {
    notes.push(`${comparedNothing} finished ${plural(comparedNothing, "sweep", "sweeps")} compared nothing at all: no Stripe subscription matched any account your app reported. Stripe has to carry the same account id your app uses. Until it does, these runs prove nothing either way.`);
  }
  if (noVerdict - comparedNothing > 0) {
    const rest = noVerdict - comparedNothing;
    notes.push(`${rest} finished ${plural(rest, "sweep", "sweeps")} did not record whether everything matched, so ${plural(rest, "it does", "they do")} not count as a day that came back clean.`);
  }
  if (!didNotRun && daysWithNoSweep > 0) {
    notes.push(`${daysWithNoSweep} day${daysWithNoSweep === 1 ? "" : "s"} of this month had no completed sweep. Anything that went wrong and came back on those days would not appear here.`);
  }
  if (daysAheadOfClock > 0) {
    notes.push(`${daysAheadOfClock} ${plural(daysAheadOfClock, "day of sweeps is", "days of sweeps are")} dated later than the moment this statement was made, so ${plural(daysAheadOfClock, "it is", "they are")} not counted as covered. The clock on this machine or in the ledger is wrong.`);
  }
  if (failures.length) {
    notes.push(`${failures.length} access change${failures.length === 1 ? " did" : "s did"} not confirm, so ${failures.length === 1 ? "it is" : "they are"} not counted as restored. Each one is listed below with what happened.`);
  }
  if (noChangeNeeded.length) {
    notes.push(`${noChangeNeeded.length} change${noChangeNeeded.length === 1 ? "" : "s"} turned out not to be needed: your app already had ${plural(noChangeNeeded.length, "that account", "those accounts")} the way Akeso asked for. Not a failure, and not counted as restored either.`);
  }
  if (unreadable) notes.push(`${unreadable} ledger entr${unreadable === 1 ? "y" : "ies"} could not be read, so nothing in ${unreadable === 1 ? "it" : "them"} is counted here.`);
  if (undated > 0) notes.push(`${undated} ledger entr${undated === 1 ? "y has" : "ies have"} no timestamp and could not be placed in a month.`);
  if (!didNotRun && !nothingMeasured && !failures.length && allClean) {
    notes.push(`Every completed sweep found every account matching Stripe.`);
  }

  /* "Found nothing wrong" is the most dangerous sentence on the page, so it
     sits at the bottom of this chain behind every measurement that would
     contradict it: a sweep that found a disagreement, and a sweep that never
     recorded a verdict at all. */
  const headline = didNotRun ? `Akeso did not run in ${monthLabel}.`
    : nothingMeasured ? `Akeso could not complete a sweep in ${monthLabel}.`
    : accessRestored > 0 ? `Akeso restored access for ${accessRestored} paying customer${accessRestored === 1 ? "" : "s"} in ${monthLabel}.`
    : accessRemoved > 0 ? `Akeso removed access from ${accessRemoved} canceled customer${accessRemoved === 1 ? "" : "s"} in ${monthLabel}.`
    : openMismatch ? `Akeso found access that does not agree with Stripe in ${monthLabel}.`
    : driftSweeps.length ? `Akeso found access that did not agree with Stripe earlier in ${monthLabel}, and the last sweep found none.`
    : comparedNothing > 0 && comparedNothing === noVerdict ? (ran.length === 1
      /* Naming the real cause, because "did not record what it found" sends a
         founder looking for a bug in Akeso when the answer is that Stripe and
         their app disagree about what an account is called. */
      ? `Akeso ran one sweep in ${monthLabel}, and it had nothing to compare.`
      : `Akeso ran ${ran.length} sweeps in ${monthLabel}, and ${comparedNothing} of them had nothing to compare.`)
    : noVerdict > 0 ? (ran.length === 1
      ? `Akeso ran one sweep in ${monthLabel}, and it did not record what it found.`
      : `Akeso ran ${ran.length} sweeps in ${monthLabel}, and ${noVerdict} of them did not record what was found.`)
    : fullyCovered ? `Akeso checked every day of ${monthLabel} and found nothing wrong.`
    : `Akeso ran ${ran.length} sweep${ran.length === 1 ? "" : "s"} in ${monthLabel} and found nothing wrong on those days.`;

  const subheadline = didNotRun
    ? `No sweep happened this month, so there is nothing here that was measured.${restores.length ? ` The ${plural(restores.length, "access change", "access changes")} below happened without one.` : ""}`
    : nothingMeasured
      ? "Every attempt failed before it could read both sides. Nothing here is a verdict about your app."
      : openMismatch
        ? (changedSinceLastSweep
          ? `The last finished sweep${lastSweepDay ? `, on ${lastSweepDay},` : ""} found accounts whose access did not agree with Stripe, and Akeso changed ${changedSinceLastSweep} of them afterwards. Nothing has been measured since.`
          : `The last finished sweep${lastSweepDay ? `, on ${lastSweepDay},` : ""} found accounts whose access did not agree with Stripe, and nothing has been changed since.`)
        : accessRestored > 0 || accessRemoved > 0
          ? failures.length
            /* The headline counts only confirmed changes, so a blanket "each
               change was read back" would be false the moment one was not. */
            ? "Only changes Akeso read back afterwards are counted here. The ones that did not confirm are listed below."
            : "Each change below was read back afterwards to confirm it held."
          : driftSweeps.length
            /* The last sweep being clean does not make the month clean, and
               "every account agreed on every day" would be a plain untruth. */
            ? `The last finished sweep found everything matching Stripe. Earlier in the month, ${driftSweeps.length} ${plural(driftSweeps.length, "sweep", "sweeps")} did not.`
          : comparedNothing > 0 && comparedNothing === noVerdict
            ? "No Stripe subscription matched any account your app reported, so nothing here is a verdict about your billing."
          : noVerdict > 0
            ? "Some sweeps finished without recording what they found, so this month cannot be called clean."
            : fullyCovered
              ? "Every account's access agreed with Stripe on every day that was checked."
              : "On the days it ran, every account's access agreed with Stripe.";

  /* Split the way the report's next-step box is: the thing to do, then why.
     Every statement ends with one, because a page a founder cannot act on is
     a page they stop opening. */
  /* Ordered by who is worse off. A mismatch is a person on the wrong side of
     a paywall that Akeso has actually measured; an unconfirmed change is an
     account Akeso cannot speak for; a gap is only a blind spot. */
  const [whatHappensNext, whatHappensNextWhy] = didNotRun
    ? ["Start the monitor again.", "Until it runs, this month cannot be called clean, only unmeasured."]
    : nothingMeasured
      ? ["Find out why the sweeps could not finish.", "Usually a Stripe key that stopped working or an app that was not reachable. Run one sweep by hand to see the error."]
      : openMismatch && waitingForYou !== null
        ? ["Check the removals waiting for you.", `Akeso never takes paid access away on its own. ${waitingForYou} ${plural(waitingForYou, "was", "were")} waiting as of the last sweep. Run npx akeso-check approvals to see what is waiting now and decide.`]
        : openMismatch && changedSinceLastSweep
          ? ["Run one more sweep to confirm the fixes.", `Akeso changed ${changedSinceLastSweep} account${changedSinceLastSweep === 1 ? "" : "s"} after the last sweep and read each one back, but nothing has been measured since.`]
          : openMismatch
            ? ["Look at the accounts that do not agree with Stripe.", `The last finished sweep${lastSweepDay ? ` on ${lastSweepDay}` : ""} found some, and nothing has been changed since. Run one sweep now to see whether it is still true.`]
          : failures.length
            ? ["Check the accounts that did not confirm.", "Akeso will not call them restored until it can read them back, so they are not counted above."]
            : noVerdict > 0
              ? ["Run one sweep by hand and read what it reports.", "Some sweeps finished without recording a verdict, so this month cannot be called clean on what is here."]
              : daysWithNoSweep > 0
                ? ["Put the sweep on a schedule so the gaps close.", "Days without a sweep are days this statement cannot speak for."]
                : ["Nothing needs you.", "Akeso keeps sweeping and only interrupts when a person is affected."];

  return {
    month: target,
    monthLabel,
    headline,
    subheadline,
    whatHappensNext,
    whatHappensNextWhy,
    didNotRun,
    nothingMeasured,
    openMismatch: Boolean(openMismatch),
    removalsWaitingAtLastSweep: waitingForYou,

    sweeps: sweepEntries.length,
    sweepsClean: cleanSweeps.length,
    sweepsComparedNothing: comparedNothing,
    sweepsCouldNotRun: couldNotRun.length,
    sweepsWithDrift: driftSweeps.length,
    sweepsWithNoVerdict: noVerdict,

    accessRestored,
    accessRemoved,
    restoresVerified: confirmed.length,
    restoresFailed: notConfirmed.length,
    /* Neither a restore nor a failure: your app was already right. Kept as its
       own number so it cannot inflate either of the two beside it. */
    changesNotNeeded: noChangeNeeded.length,
    failures,

    /* The three numbers. Separate keys, separate reasons, never a total. */
    unpaidAccessExposure,
    unpaidAccessExposureNote: unpaidAccessExposure === null
      ? (ran.length
        /* A month of finished sweeps that recorded no price is not a month
           without sweeps, and saying so would blame the wrong thing. */
        ? "Not measured. No finished sweep this month recorded a list price, so there is nothing to average."
        : "Not measured. No sweep this month completed a reading, so there is nothing to average.")
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
      confirmed: isConfirmed(entry),
      /* Marked apart so the page does not put a warning next to a run in
         which nothing was wrong. */
      notNeeded: isNoChangeNeeded(entry),
      at: entry.at,
      line: actionReceipt(entry),
    })),
    coverage: {
      firstSweepAt: ran[0]?.at ?? null,
      lastSweepAt: lastFinished?.at ?? null,
      daysWithNoSweep,
      daysMeasured,
      daysInWindow,
      daysAheadOfClock,
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
  /* A ledger line holding a bare `null` parses fine and is not an object. The
     verifier reads `.kind` off every entry, so one of these used to end the
     whole statement with a TypeError: a malformed history must be reported,
     never a crash that hides the month. */
  if (!entries.every((entry) => entry && typeof entry === "object")) {
    return { checked: false, reason: "at least one entry is not a record at all, so the chain could not be checked" };
  }
  /* Entries built in memory carry no chain at all. Running the verifier over
     them would report BROKEN, which is a false tamper alarm, and a false
     tamper alarm is worse than an honest "not checked". */
  if (typeof entries[0].hash !== "string") {
    return { checked: false, reason: "these entries do not carry the ledger's chain, so nothing could be checked" };
  }
  if ((entries[0].prev ?? null) !== null) {
    return { checked: false, reason: "this is part of the history, not the whole of it, so the chain could not be checked from the start" };
  }
  const result = verifyLedger(entries);
  return { checked: true, ...result };
}

/* -------------------------------------------------------------- rendering */

const label = (text) => `  ${text.padEnd(36)}`;

/* The value column already says "not measured", so the reason under it should
   not open by saying it again. */
const reasonOnly = (note) => note.replace(/^Not measured\.\s*/, "");

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
  /* Nothing measured means nothing to report, in both renderings. A "0" here
     reads as a count of clean sweeps, which is a measurement nobody made. */
  lines.push(`${label("Of those, everything matched")}: ${statement.didNotRun || statement.nothingMeasured ? "not measured" : statement.sweepsClean}`);
  if (statement.sweepsWithDrift) lines.push(`${label("Of those, found a mismatch")}: ${statement.sweepsWithDrift}`);
  if (statement.sweepsWithNoVerdict) lines.push(`${label("Of those, recorded no verdict")}: ${statement.sweepsWithNoVerdict}`);
  lines.push(`${label("Sweeps that could not run")}: ${statement.sweepsCouldNotRun}`);
  lines.push(`${label("Days with no finished sweep")}: ${statement.coverage.daysWithNoSweep} of ${statement.coverage.daysInWindow}`);
  lines.push(``);
  lines.push(`${label("Access restored to paying customers")}: ${statement.accessRestored}`);
  lines.push(`${label("Access removed after cancellation")}: ${statement.accessRemoved}`);
  lines.push(`${label("Confirmed by reading it back")}: ${statement.restoresVerified}`);
  lines.push(`${label("Changes that did not confirm")}: ${statement.restoresFailed}`);
  if (statement.changesNotNeeded) lines.push(`${label("Changes that were not needed")}: ${statement.changesNotNeeded}`);
  lines.push(``);
  lines.push(`${label("Unpaid access exposure")}: ${statement.unpaidAccessExposure === null ? "not measured" : `${money(statement.unpaidAccessExposure)} a month at list price`}`);
  lines.push(`    ${reasonOnly(statement.unpaidAccessExposureNote)}`);
  lines.push(`${label("Direct cost prevented")}: not measured`);
  lines.push(`    ${reasonOnly(statement.directCostPreventedNote)}`);
  lines.push(`${label("Revenue recovered")}: not measured`);
  lines.push(`    ${reasonOnly(statement.revenueRecoveredNote)}`);
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
  lines.push(`Do this next`);
  lines.push(`  ${statement.whatHappensNext}`);
  lines.push(`  ${statement.whatHappensNextWhy}`);
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
   same wordmark, same rows, same next-step box. A founder should not be able
   to tell that two different files drew these. The one declaration that
   differs is `.nextBox p`, whose bottom margin in the report separates it from
   a command block this page does not have. */
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
    /* The disagreement gets its own line rather than being left as the gap
       between two other numbers. It is the finding the founder is paying for. */
    statement.sweepsWithDrift ? row({
      tone: "warn",
      mark: "!",
      name: "Of those, found a mismatch",
      detail: `${statement.sweepsWithDrift}, access that did not agree with Stripe`,
    }) : null,
    statement.sweepsWithNoVerdict ? row({
      tone: "mute",
      mark: "?",
      name: "Of those, recorded no verdict",
      detail: `${statement.sweepsWithNoVerdict}, so ${statement.sweepsWithNoVerdict === 1 ? "it does" : "they do"} not count as clean`,
    }) : null,
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
  ].filter(Boolean).join("\n");

  const doneRows = [
    row({
      tone: statement.accessRestored ? "ok" : "",
      mark: statement.accessRestored ? "✓" : "",
      name: "Access restored to paying customers",
      detail: String(statement.accessRestored),
    }),
    row({ name: "Access removed after cancellation", detail: String(statement.accessRemoved) }),
    row({ name: "Confirmed by reading it back", detail: String(statement.restoresVerified) }),
    row({
      tone: statement.restoresFailed ? "warn" : "",
      mark: statement.restoresFailed ? "!" : "",
      name: "Changes that did not confirm",
      detail: statement.restoresFailed ? `${statement.restoresFailed}, not counted as restored` : "0",
    }),
    statement.changesNotNeeded ? row({
      name: "Changes that were not needed",
      detail: `${statement.changesNotNeeded}, your app was already right`,
    }) : null,
  ].filter(Boolean).join("\n");

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

  /* Each reason names the number it belongs to: three bullets under three rows
     are otherwise impossible to match up. */
  const numberNotes = [
    ["Unpaid access exposure", statement.unpaidAccessExposureNote],
    ["Direct cost prevented", statement.directCostPreventedNote],
    ["Revenue recovered", statement.revenueRecoveredNote],
  ].map(([name, note]) => `<li>${escapeHtml(`${name}: ${note}`)}</li>`).join("\n");

  const actionRows = statement.actions.map((action) => {
    const tone = action.confirmed ? "ok" : action.notNeeded ? "mute" : "warn";
    const mark = action.confirmed ? "✓" : action.notNeeded ? "" : "!";
    return `<div class="row ${tone}"><span class="mark">${mark}</span><span class="name wide">${escapeHtml(action.line)}</span></div>`;
  }).join("\n");

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
  .nextBox { margin-top:34px; border:1px solid var(--line); border-radius:12px; padding:22px 24px;
    background:color-mix(in srgb, var(--ink) 2.5%, transparent); }
  .nextBox .nextLabel { font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink3); }
  .nextBox h3 { margin:6px 0 5px; font-size:16.5px; font-weight:600; letter-spacing:-.01em; }
  .nextBox p { margin:0; color:var(--ink2); font-size:13.5px; max-width:58ch; }
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

  <div class="nextBox">
    <div class="nextLabel">Do this next</div>
    <h3>${escapeHtml(statement.whatHappensNext)}</h3>
    <p>${escapeHtml(statement.whatHappensNextWhy)}</p>
  </div>
  </div>
  <footer>Akeso Statement · ${escapeHtml(statement.monthLabel)} · ${statement.sweeps - statement.sweepsCouldNotRun} finished sweeps · local run</footer>
</div></body></html>`;
}
