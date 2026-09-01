import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEntry, lastOfKind, ledgerPath, readLedger } from "./ledger.mjs";
import { foldApprovals } from "./approvals.mjs";

/* The blast-radius controls. These ship WITH the write path, never after it.
 *
 * Everything else in Akeso decides what SHOULD happen. This file is the last
 * thing between a bug in that decision and a customer's paying users all
 * losing access at once. It is small on purpose: a safety net nobody can read
 * is a safety net nobody trusts, and an untrusted one gets switched off.
 *
 * Five controls, each named after the failure it exists to prevent:
 *
 *   1. A kill switch. One file, one command, and Akeso stops writing. It stops
 *      giving access back too. A kill switch that only blocks removals is not
 *      a kill switch, because "Akeso is doing something strange, stop it" is
 *      the whole point and we do not get to decide which half was strange.
 *   2. Flap detection. An account flipped back and forth is Akeso fighting
 *      something else that also writes entitlements. Akeso must lose that
 *      fight loudly and once, not quietly forever.
 *   3. A canary gate. A release proves itself on a canary before it touches
 *      customers. No canary result is not a pass. Absence of evidence is never
 *      permission.
 *   4. A write budget. A global ceiling on how many accounts Akeso may change
 *      in an hour and in a day, across every account, so the worst case of any
 *      bug is bounded by a number a founder chose.
 *   5. A named human decision behind every removal. A wrong grant costs a few
 *      dollars. A wrong removal locks a paying customer out of the thing they
 *      are paying for, so the gate will not pass one without the id of the
 *      approval a person actually gave.
 *
 * The state lives in the ledger, folded at read time, so every halt, every
 * suspension and every clearance is a receipt with a name on it. The kill
 * switch is additionally a plain file, because the one moment you need it most
 * is the moment you do not trust the program to read its own history.
 *
 * One rule sits above all five: a check that could not be made is never a pass.
 * A clock we cannot read, a history file we cannot open, a kill switch we can
 * see but cannot read, a caller that handed us something that is not a history
 * at all: each of those is Akeso failing, and Akeso failing is never permission
 * to write to a customer's app.
 */

export const KILL_SWITCH_FILE = ".akeso/HALT";

export const killSwitchPath = (root) => path.join(root, KILL_SWITCH_FILE);

export const SAFETY_DEFAULTS = {
  flapWindowHours: 24,
  flapThreshold: 3,        /* writes in the window before flapping is even considered */
  minimumDirectionChanges: 2, /* a there-and-back. Two grants in a row is a retry */
  writesPerHour: 20,
  writesPerDay: 100,
  minimumCleanCanaries: 1,
};

const HOUR = 3600000;
const DAY = 86400000;

/* A ledger line can be anything on disk: an object, a bare `null`, a number, a
   line that never parsed. Everything downstream assumes an object, so the
   check happens once, here. */
const isRecord = (entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);

const isUnreadable = (entry) => !isRecord(entry) || entry.kind === "unreadable";

/* Milliseconds, or null when the entry cannot be placed in time at all. Null
   is a finding, not a zero: callers decide what an undatable entry means, and
   they decide it in the direction that is safe for them. */
function timeOf(entry) {
  const parsed = Date.parse(entry?.at ?? "");
  return Number.isNaN(parsed) ? null : parsed;
}

/* Every window in this file is measured from `now`. A `now` we cannot use makes
   all of those measurements guesses, and the safe reading of a guess is not
   "nothing has happened recently" but "we do not know". Returns null so callers
   have to say what they do about not knowing, instead of silently getting a
   budget of zero used writes out of a broken clock. */
const usableNow = (now) => {
  const ms = now instanceof Date ? now.getTime() : now;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
};

const CLOCK_FAULT = "Akeso could not read the clock it was given, so it cannot tell how recently anything happened. It has stopped rather than guess. Nothing was written. This is a fault inside Akeso, not something wrong with your app.";

const records = (entries) => (Array.isArray(entries) ? entries : []).filter(isRecord);

/* Reasons written by people get quoted inside our own sentences. A reason that
   ends mid-air makes the sentence after it read like part of the same thought. */
const asSentence = (text) => {
  const trimmed = String(text ?? "").trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const times = (count) => `${count} time${count === 1 ? "" : "s"}`;

/* readLedger turns every read failure into an empty history. That is the right
   default for a report and the wrong one for a brake: a history we cannot open
   is a history whose halt entry and whose holds we cannot see, and an empty
   list would read as "nobody stopped anything". So the file's readability is
   established separately, and a fault here becomes a refusal. */
async function ledgerFault(root) {
  try {
    await readFile(ledgerPath(root), "utf8");
    return null;
  } catch (error) {
    /* A project that has never been checked has no history file yet. That is a
       normal first run, not a fault. */
    if (error?.code === "ENOENT") return null;
    return error?.code || error?.message || String(error);
  }
}

/* ------------------------------------------------------------ kill switch */

/* Halted if EITHER signal says so. The file and the ledger are deliberately
   not kept in sync by this function: a file placed by hand during an incident
   must halt a system whose ledger says "running", and a halt recorded in the
   ledger must survive somebody deleting the file. Two independent brakes.
 *
 * A third outcome sits alongside those two: we could not tell. A kill switch
 * that is there but unreadable, or a history file that will not open, both mean
 * the brake might be on and we cannot see it. That is reported as halted, with
 * the reason saying exactly which part failed, because the alternative is to
 * treat our own blindness as permission to write to a customer's app. */
export async function isHalted(root) {
  const file = killSwitchPath(root);

  let contents = null;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    /* Absent is the only reading of this file that means "not halted". Every
       other failure means the brake may be there with our eyes shut. */
    if (error?.code !== "ENOENT") {
      return {
        halted: true,
        reason: `Akeso found ${KILL_SWITCH_FILE} but could not read it (${error?.code || error?.message}). It is treating that as a stop, because a brake it cannot read is not a brake it may ignore. Nothing was written. Fix that file, or delete it if you want Akeso running again.`,
        since: null,
        source: "unreadable_file",
      };
    }
  }

  if (contents !== null) {
    const stamped = await stat(file).catch(() => null);
    return {
      halted: true,
      reason: contents.trim() || `The file ${KILL_SWITCH_FILE} exists and nothing was written inside it, so no reason was recorded.`,
      since: stamped ? stamped.mtime.toISOString() : null,
      source: "file",
    };
  }

  const fault = await ledgerFault(root);
  if (fault) {
    return {
      halted: true,
      reason: `Akeso could not read its own history file .akeso/ledger.jsonl (${fault}), so it cannot tell whether somebody has stopped it. It is treating that as a stop. Nothing was written. Restore that file from a backup, or ask for help, before running with --apply again.`,
      since: null,
      source: "unreadable_ledger",
    };
  }

  const entries = await readLedger(root).catch(() => []);
  const last = lastOfKind(records(entries), "halt");
  if (last && last.state === "on") {
    return {
      halted: true,
      reason: last.reason || "A halt was recorded and no reason was written down with it.",
      since: last.at ?? null,
      source: "ledger",
    };
  }

  return { halted: false, reason: null, since: null, source: null };
}

/* Stop everything. The file is written BEFORE the ledger entry, because if
   only one of the two succeeds the system must end up halted, not recorded as
   halted while still writing.
 *
 * The state is read back before anything is called a success. This is the one
 * command in the product that must never be wrong about whether it worked. */
export async function haltNow(root, { reason, by } = {}) {
  const text = String(reason ?? "").trim() || "Halted by hand. No reason was given.";

  /* Neither write is allowed to throw. This is the command a founder runs while
     something is going wrong, and a stack trace in that moment tells them
     nothing about whether Akeso actually stopped. Both failures are caught and
     turned into a sentence that says which brake did not get set. */
  let couldNotWriteFile = null;
  try {
    await mkdir(path.dirname(killSwitchPath(root)), { recursive: true });
    await writeFile(killSwitchPath(root), `${text}\n`);
  } catch (error) {
    couldNotWriteFile = error?.code || error?.message || String(error);
  }

  let entry = null;
  let couldNotRecord = null;
  try {
    entry = await appendEntry(root, { kind: "halt", state: "on", reason: text, by: by || "unknown" });
  } catch (error) {
    couldNotRecord = error?.code || error?.message || String(error);
  }

  const after = await isHalted(root);
  /* Two things have to be true to call this done: Akeso reads itself as stopped
     now, and the stop survived into at least one of the two places it lives. A
     system that reads as stopped only because its own folder is broken is
     stopped by accident, and it starts writing again the moment somebody fixes
     the folder. That is not a halt and must never be reported as one. */
  const recorded = couldNotWriteFile === null || couldNotRecord === null;
  const ok = after.halted && recorded;

  return {
    ok,
    confirmed: ok,
    halted: after.halted,
    couldNotWriteFile,
    couldNotRecord,
    entry,
    message: ok
      ? `Akeso is stopped. It will not change anyone's access, including giving access back to people who are paying, until you start it again. The reason recorded is: ${asSentence(text)}`
      : recorded
        ? `Akeso wrote the stop down but could not read it back afterwards, so it is not treating itself as stopped. Nothing else has changed. Look at ${KILL_SWITCH_FILE} and .akeso/ledger.jsonl, and do not run with --apply until this reads as stopped.`
        : `Akeso could not write the stop down anywhere (${couldNotWriteFile} on ${KILL_SWITCH_FILE}, ${couldNotRecord} on .akeso/ledger.jsonl), so it is not treating itself as stopped. Nothing else has changed. Check that the .akeso folder in your project is a folder you can write to, then run this again.`,
  };
}

/* Start again. The ledger entry is written BEFORE the file is removed, for the
   mirror image of the reason above: if only one succeeds, the system stays
   halted. Turning a brake off is never the step that gets the benefit of the
   doubt, so this too re-reads the state and reports what it actually found. */
export async function resumeHalt(root, { by } = {}) {
  let entry = null;
  let couldNotRecord = null;
  try {
    entry = await appendEntry(root, { kind: "halt", state: "off", by: by || "unknown" });
  } catch (error) {
    /* Failing to record a resume leaves the system stopped, which is the safe
       direction, so this is reported rather than thrown. A founder reading a
       stack trace cannot tell whether Akeso is running. */
    couldNotRecord = error?.code || error?.message || String(error);
  }

  let couldNotRemove = null;
  try {
    /* force: removing a kill switch that was never there is a normal outcome of
       "resume", not an error a founder should ever see. Any other failure is
       reported rather than thrown, because the honest answer to it is "still
       stopped", which is a sentence, not a crash. */
    await rm(killSwitchPath(root), { force: true });
  } catch (error) {
    couldNotRemove = error?.code || error?.message || String(error);
  }

  const after = await isHalted(root);
  const ok = !after.halted && couldNotRecord === null;
  return {
    ok,
    confirmed: ok,
    halted: after.halted,
    couldNotRemove,
    couldNotRecord,
    entry,
    message: ok
      ? "Akeso is running again. It will give access back to paying customers who are locked out, and it will still wait for you to approve before it takes any access away."
      : after.halted
        /* True whether or not the resume was recorded, which is the point: the
           founder needs the state, not our bookkeeping. */
        ? `Akeso is still stopped. ${asSentence(after.reason)} Run resume again once that is dealt with.`
        : `Akeso is no longer stopped, but it could not write down who started it again (${couldNotRecord} on .akeso/ledger.jsonl), so there is no receipt for this. Check that the .akeso folder in your project is one you can write to, then stop and start Akeso again so the record is complete.`,
  };
}

/* -------------------------------------------------------------- flapping */

/* An account whose access Akeso keeps changing back and forth is an account
   where something else is changing it too: another job, a webhook handler, a
   human in a dashboard. Akeso cannot win that fight and must not try, because
   the customer experiences the fight as their access blinking on and off.
   Reported once, loudly, and then hands off.

   Only writes that actually landed count. Three failed attempts are Akeso
   retrying, and calling a retry a fight would report our own noise as their
   problem. */
export function detectFlapping(entries, {
  windowHours = SAFETY_DEFAULTS.flapWindowHours,
  threshold = SAFETY_DEFAULTS.flapThreshold,
  minimumDirectionChanges = SAFETY_DEFAULTS.minimumDirectionChanges,
  now = Date.now(),
} = {}) {
  /* Without a usable clock there is no window, and an empty list here would be
     read as "no account is flapping", which is a measurement we did not make.
     The caller is told plainly instead. guardWrite refuses on the clock before
     it ever reaches this line. */
  const at = usableNow(now);
  if (at === null) throw new TypeError("detectFlapping needs a readable `now` to measure its window from");

  const from = at - windowHours * HOUR;
  const byAccount = new Map();

  for (const entry of records(entries)) {
    if (entry.kind !== "restore") continue;
    if (entry.result !== "applied") continue;
    if (entry.direction !== "grant" && entry.direction !== "remove") continue;
    const stamp = timeOf(entry);
    /* An entry we cannot place in time cannot be shown to be inside the
       window, and a fight we cannot prove is not one we report. */
    if (stamp === null || stamp <= from) continue;
    const account = String(entry.account ?? "");
    if (!account) continue;
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push({ at: stamp, direction: entry.direction });
  }

  const flapping = [];
  for (const [account, writes] of byAccount) {
    writes.sort((a, b) => a.at - b.at);
    let directionChanges = 0;
    for (let i = 1; i < writes.length; i += 1) {
      if (writes[i].direction !== writes[i - 1].direction) directionChanges += 1;
    }
    /* Both tests must pass. Volume alone is retrying; one reversal alone is a
       customer who cancelled and resubscribed, which is ordinary life. */
    if (writes.length < threshold) continue;
    if (directionChanges < minimumDirectionChanges) continue;
    flapping.push({
      account,
      flips: writes.length,          /* writes that landed, inside the window */
      directionChanges,              /* how many of them reversed the one before */
      firstAt: new Date(writes[0].at).toISOString(),
      lastAt: new Date(writes.at(-1).at).toISOString(),
    });
  }

  return flapping.sort((a, b) => b.flips - a.flips || a.account.localeCompare(b.account));
}

/* ------------------------------------------------------------ suspension */

/* Folded from the ledger, newest decision per account wins. A suspension is
   never lifted by time passing: it takes a person, and the person's name is on
   the entry that lifted it. */
export function suspendedAccounts(entries, { now = Date.now() } = {}) {
  const asOf = usableNow(now);
  const held = new Map();

  for (const entry of records(entries)) {
    if (entry.kind !== "suspend") continue;
    const account = String(entry.account ?? "");
    if (!account) continue;
    if (entry.state === "off") { held.delete(account); continue; }
    /* Anything that is not an explicit "off" is not a clearance. A typo in a
       state field must never quietly release an account. */
    if (entry.state !== "on") continue;
    held.set(account, {
      account,
      reason: entry.reason || "No reason was recorded with the suspension.",
      since: entry.at ?? null,
      by: entry.by ?? null,
    });
  }

  return [...held.values()].map((row) => {
    const at = timeOf({ at: row.since });
    return {
      ...row,
      /* Unmeasurable stays null, whether it is the entry we cannot date or the
         clock we cannot read. An unreadable time does not get a made-up
         duration, and it never gets a NaN dressed up as a number either. */
      heldHours: at === null || asOf === null ? null : Math.max(0, Math.round((asOf - at) / HOUR)),
    };
  });
}

export const suspendAccount = (root, { account, reason, by } = {}) =>
  appendEntry(root, {
    kind: "suspend",
    state: "on",
    account: String(account ?? ""),
    reason: String(reason ?? "").trim() || "No reason was given.",
    by: by || "akeso",
  });

export const clearSuspension = (root, { account, by } = {}) =>
  appendEntry(root, { kind: "suspend", state: "off", account: String(account ?? ""), by: by || "unknown" });

/* ---------------------------------------------------------- canary gate */

/* A row counts as clean only if it says so and does not also say otherwise. A
   row carrying both claims is a canary whose report cannot be trusted at all,
   and the one thing we must not do with an untrustworthy report is read the
   half of it that opens the gate. */
const saysClean = (row) => row.clean === true || row.result === "clean";
const saysNotClean = (row) => row.clean === false || (typeof row.result === "string" && row.result !== "clean");
const isCleanResult = (row) => saysClean(row) && !saysNotClean(row);

/* A release does not touch customers until it has run cleanly somewhere that
   is not a customer. The whole value of this gate is what it does with
   MISSING evidence: nothing found means not allowed. A gate that opens when it
   cannot find the canary result is a gate that opens every time the canary
   fails to report, which is exactly when it matters. */
export function canaryGate({ releaseId, canaryResults, minimumClean = SAFETY_DEFAULTS.minimumCleanCanaries } = {}) {
  /* A bar we cannot read is not a bar. Left unchecked, a minimum of NaN passes
     every comparison and opens the gate on the strength of a broken setting. */
  if (!Number.isInteger(minimumClean) || minimumClean < 1) {
    return {
      allowed: false,
      /* The setting is quoted rather than dropped into the sentence as a bare
         word: a founder reading "require NaN clean canary runs" learns nothing,
         and "NaN" in quotes at least reads as a broken setting they can point
         at when they ask for help. */
      reason: `Akeso was told to require "${String(minimumClean)}" clean canary runs, which is not a whole number of runs it can check against. Nothing was written. This is a fault in Akeso's own settings, not something wrong with your app.`,
    };
  }

  if (!releaseId) {
    return {
      allowed: false,
      reason: "This run did not say which version of Akeso it is, so there is no way to tell whether that version was tried on a canary first. Nothing was written. This is a problem with the run, not with your app.",
    };
  }

  if (!Array.isArray(canaryResults) || canaryResults.length === 0) {
    return {
      allowed: false,
      reason: `No canary run was found for release ${releaseId}. A missing canary is not a pass. Run the canary first, then run this again.`,
    };
  }

  const mine = records(canaryResults).filter((row) => String(row.releaseId ?? "") === String(releaseId));
  if (mine.length === 0) {
    return {
      allowed: false,
      reason: `There are canary results here, but none of them are for release ${releaseId}. A different release passing does not clear this one. Run the canary on ${releaseId}, then run this again.`,
    };
  }

  const clean = mine.filter(isCleanResult);
  const notClean = mine.length - clean.length;
  if (notClean > 0) {
    return {
      allowed: false,
      reason: mine.length === 1
        ? `The canary run for release ${releaseId} did not come back clean. Nothing was written. Read the canary result before letting this release touch customers.`
        : `${notClean} of the ${mine.length} canary runs for release ${releaseId} did not come back clean. Nothing was written. Read the canary result before letting this release touch customers.`,
    };
  }

  if (clean.length < minimumClean) {
    return {
      allowed: false,
      reason: `Release ${releaseId} has ${clean.length} clean canary run so far and ${minimumClean} are required. Nothing was written. Run the canary again, then run this.`,
    };
  }

  return {
    allowed: true,
    reason: `Release ${releaseId} ran cleanly on ${clean.length} canary ${clean.length === 1 ? "account" : "accounts"} before touching anyone real.`,
  };
}

/* ---------------------------------------------------------- write budget */

/* The ceiling on everything, across every account. If Akeso is about to change
   more accounts in an hour than a founder would change by hand in a week,
   Akeso is wrong more often than it is right, and stopping is the correct
   behaviour even if some of those changes were good ones.
 *
 * Counts every restore entry, not only the ones that succeeded, because a
 * write that timed out may still have landed on the other side. Budget is
 * about what we may have DONE to their system, not about what worked. */
export function writeBudget(entries, {
  now = Date.now(),
  perHour = SAFETY_DEFAULTS.writesPerHour,
  perDay = SAFETY_DEFAULTS.writesPerDay,
} = {}) {
  /* No clock, no windows, no counts. Reporting zero writes used here would hand
     a broken clock an unlimited budget, which is the exact failure this whole
     file exists to stop. Unmeasured is reported as unmeasured, and unmeasured
     is not permission. */
  const asOf = usableNow(now);
  if (asOf === null) {
    return {
      used: { hour: null, day: null },
      remaining: { hour: null, day: null },
      undated: null,
      exhausted: true,
      reason: CLOCK_FAULT,
    };
  }

  const restores = records(entries).filter((entry) => entry.kind === "restore");
  const undated = restores.filter((entry) => timeOf(entry) === null).length;

  const countWithin = (windowMs) => restores.filter((entry) => {
    const at = timeOf(entry);
    /* An entry with no readable timestamp is counted as recent. The other
       choice is that one corrupt line buys an unlimited number of writes. */
    if (at === null) return true;
    /* Entries stamped in the future are counted too, so a machine with a
       skewed clock cannot hand itself a fresh budget. */
    return at > asOf - windowMs;
  }).length;

  const used = { hour: countWithin(HOUR), day: countWithin(DAY) };
  const remaining = { hour: Math.max(0, perHour - used.hour), day: Math.max(0, perDay - used.day) };
  const hourGone = used.hour >= perHour;
  const dayGone = used.day >= perDay;

  /* The count includes entries we could not date, so the sentence says so. A
     number presented as measured when part of it was assumed is the kind of
     small lie that makes a founder stop believing the big numbers too. */
  const undatedNote = undated === 0
    ? ""
    : ` Akeso could not read a time on ${undated} of those entries, so it counted them as recent rather than assume they had aged out.`;

  return {
    used,
    remaining,
    undated,
    exhausted: hourGone || dayGone,
    /* "Until the window moves" and not "until tomorrow": these are rolling
       windows, so writing resumes as the oldest changes age out, not at
       midnight. Telling a founder to wait for tomorrow would be a made-up
       deadline. */
    reason: hourGone
      ? `Akeso has changed access ${times(used.hour)} in the last hour, which is its limit of ${perHour} an hour.${undatedNote} It has stopped writing until enough of those changes are more than an hour old. If that many changes an hour is normal for your business, raise the limit. If it is not, this is the safety net catching something, and the queued list is the thing to read first.`
      : dayGone
        ? `Akeso has changed access ${times(used.day)} in the last day, which is its limit of ${perDay} a day.${undatedNote} It has stopped writing until enough of those changes are more than a day old. If that many changes a day is normal for your business, raise the limit. If it is not, this is the safety net catching something, and the queued list is the thing to read first.`
        : null,
  };
}

/* ------------------------------------------------------------ the gate */

/* Every write goes through here, grants included. Returns reasons rather than
   throwing, so the caller can log all of them at once: a founder who fixes one
   refusal and hits the next one has been told half the truth twice.
 *
 * It never throws. If this function cannot work out whether a write is safe,
 * the answer is no. Our own failure is never permission.
 *
 * Three faults end the check early and on their own, because every other rule
 * below them is measured against the thing that just failed: a clock we cannot
 * read, a history that is not a history, and a project directory that is not
 * there. Reporting a budget or a flap count measured against any of those would
 * be reporting a number we did not measure. */
export async function guardWrite(root, {
  account,
  direction,
  entries = null,
  approvalId = null,
  now = Date.now(),
  limits = {},
} = {}) {
  const reasons = [];

  try {
    const at = usableNow(now);
    if (at === null) return { allowed: false, reasons: [CLOCK_FAULT] };

    /* A caller that hands us something other than a list of entries has a bug.
       Quietly reading the file instead would answer a question nobody asked,
       against a history that is not the one the caller is acting on. */
    if (entries !== null && entries !== undefined && !Array.isArray(entries)) {
      return {
        allowed: false,
        reasons: [`Akeso was handed something that is not a list of history entries, so it cannot tell whether this change is safe. Nothing was written. This is a fault inside Akeso, not something wrong with your app.`],
      };
    }

    if (typeof root !== "string" || !root.trim()) {
      return {
        allowed: false,
        reasons: ["Akeso was not told which project folder to check its safety rules against, so it changed nothing. This is a fault inside Akeso, not something wrong with your app."],
      };
    }

    /* A folder that is not there is a folder whose history, halt and holds we
       are not reading. An empty history inside a real project is a first run
       and is fine; no project at all is not. */
    const rootIsThere = await stat(root).then((entry) => entry.isDirectory()).catch(() => false);
    if (!rootIsThere) {
      return {
        allowed: false,
        reasons: [`Akeso could not find the project folder ${root}, so it could not read the history that says whether it has been stopped or which accounts are on hold. Nothing was written. Point Akeso at the folder your project lives in and run it again.`],
      };
    }

    const ledger = Array.isArray(entries) ? entries : await readLedger(root);

    const halt = await isHalted(root);
    /* A halt recorded in the history the caller handed us counts as well. When
       a caller passes its own copy of the ledger, that copy is the history this
       write is being judged against, and a stop written into it must stop this
       write even if the file on disk has not caught up. */
    const handedHalt = lastOfKind(records(ledger), "halt");
    const haltedInHanded = handedHalt?.state === "on";
    if (halt.halted || haltedInHanded) {
      const why = halt.halted ? halt.reason : (handedHalt.reason || "A halt was recorded and no reason was written down with it.");
      reasons.push(`Akeso is stopped, so it is not changing anyone's access, including giving access back to people who are paying. The reason recorded is: ${asSentence(why)} Nothing was written. Start Akeso again when you want it running.`);
    }

    const named = String(account ?? "");
    if (!named) {
      reasons.push("Akeso was asked to change access without being told whose access it is, so nothing was written. This is a fault in Akeso, not something wrong with your app.");
    }
    if (direction !== "grant" && direction !== "remove") {
      reasons.push(`Akeso was asked for a change of kind "${String(direction)}", and the only changes it makes are giving access back and taking it away. Nothing was written. This is a fault in Akeso, not something wrong with your app.`);
    }

    /* A history with lines we cannot read might be hiding the halt or the
       suspension that would have stopped this write. Unreadable is not clean. */
    const unreadable = ledger.filter(isUnreadable).length;
    if (unreadable > 0) {
      reasons.push(`Akeso's own history file has ${unreadable} ${unreadable === 1 ? "line" : "lines"} it cannot read, and one of them could be the halt or the hold that should stop this change. Nothing was written. Restore .akeso/ledger.jsonl from a backup, or ask for help, before running with --apply again.`);
    }

    if (named) {
      const suspended = suspendedAccounts(ledger, { now: at }).find((row) => row.account === named);
      if (suspended) {
        reasons.push(`Account ${named} is on hold and Akeso will not change it automatically. The reason recorded is: ${asSentence(suspended.reason)} Nothing was written. Take the hold off that account when the cause is dealt with.`);
      }

      const flapping = detectFlapping(ledger, { ...limits, now: at }).find((row) => row.account === named);
      if (flapping && !suspended) {
        reasons.push(`Account ${named} has had its access changed ${times(flapping.flips)} since ${flapping.firstAt}, and ${flapping.directionChanges} of those changes undid the one before. Something other than Akeso is writing to this account, and Akeso will not join that fight. Nothing was written. Find the other thing that is writing, then put this account back in play.`);
      }
    }

    /* Doctrine, and the reason this gate exists at all: a grant costs a few
       dollars if it is wrong, a removal locks a paying customer out of what
       they paid for. So a removal needs the id of an approval a person
       actually gave, for this account, and nothing else will do. No id, an id
       nobody approved, or an id approved for somebody else all mean the same
       thing here, which is no. */
    if (direction === "remove" && named) {
      reasons.push(...removalRefusals({ ledger, account: named, approvalId, now: at }));
    }

    const budget = writeBudget(ledger, { ...limits, now: at });
    if (budget.exhausted) reasons.push(budget.reason);

    return { allowed: reasons.length === 0, reasons };
  } catch (error) {
    return {
      allowed: false,
      reasons: [`Akeso could not check its own safety rules, so it changed nothing. The fault was: ${error?.message || String(error)}. This is a problem inside Akeso, not a verdict about your app. Nothing was written.`],
    };
  }
}

/* Doctrine, in one function: removals are always queued for a human. So the
   only removals this gate lets past are the ones that reached the queue and
   were not answered "no" there.
 *
 * What it checks is deliberately what it can actually see. The approvals file
 * owns the decision itself: it refuses to approve a row before its cancel
 * window ends and it writes down who said yes. It also calls this gate BEFORE
 * it records that yes, which is correct, so demanding an approved entry here
 * would refuse the one path a human is standing in. What this gate adds is the
 * case that file cannot cover: a caller that decided to remove access without
 * ever putting the question to anybody, and a caller acting on a removal a
 * person already cancelled or left to expire. */
const LIVE_APPROVAL_STATES = new Set(["queued", "ready", "approved"]);

const answeredAlready = (row, account) => {
  const what = row.state === "cancelled"
    ? "was cancelled by a person, and a cancellation is final"
    : row.state === "expired"
      ? "was queued more than a week ago and nobody answered it, so it expired"
      : `is recorded as ${row.state}, which is not something Akeso can act on`;
  return `The queued removal for ${account} ${what}. Nothing was written. Run a fresh sweep if that account should still lose access, and approve it there.`;
};

function removalRefusals({ ledger, account, approvalId, now }) {
  const rows = foldApprovals(ledger, { now });
  const id = String(approvalId ?? "").trim();

  if (id) {
    const row = rows.get(id);
    if (!row) {
      return [`Akeso was asked to take access away from ${account} under an approval it has no record of. Nothing was written. Nothing gets taken away until it has been queued and a person has approved it.`];
    }
    /* Whose removal it is comes before what state it is in: an id belonging to
       somebody else is the more precise fault, and describing another
       customer's row would send the founder to answer the wrong question. */
    if (String(row.account ?? "") !== account) {
      return [`The removal named here was queued for account ${String(row.account ?? "nobody in particular")}, not for ${account}. One approval covers one account. Nothing was written. Approve the removal for ${account} in the queue if that is what you meant.`];
    }
    if (!LIVE_APPROVAL_STATES.has(row.state)) return [answeredAlready(row, account)];
    return [];
  }

  /* No id named. The same question, asked of the account: is there a removal in
     the queue for this person that nobody has said no to? */
  const forAccount = [...rows.values()].filter((row) => String(row.account ?? "") === account);
  if (forAccount.some((row) => LIVE_APPROVAL_STATES.has(row.state))) return [];
  if (forAccount.length > 0) return [answeredAlready(forAccount.at(-1), account)];

  return [`Akeso was asked to take access away from ${account}, and there is no removal in the queue for that account. Access is only ever taken away after it has been queued and a person has approved it, so nothing was written. Run a sweep to queue it, then approve it.`];
}
