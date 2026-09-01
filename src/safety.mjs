import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEntry, lastOfKind, readLedger } from "./ledger.mjs";

/* The blast-radius controls. These ship WITH the write path, never after it.
 *
 * Everything else in Akeso decides what SHOULD happen. This file is the last
 * thing between a bug in that decision and a customer's paying users all
 * losing access at once. It is small on purpose: a safety net nobody can read
 * is a safety net nobody trusts, and an untrusted one gets switched off.
 *
 * Four controls, each named after the failure it exists to prevent:
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
 *
 * The state lives in the ledger, folded at read time, so every halt, every
 * suspension and every clearance is a receipt with a name on it. The kill
 * switch is additionally a plain file, because the one moment you need it most
 * is the moment you do not trust the program to read its own history.
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

const records = (entries) => (Array.isArray(entries) ? entries : []).filter(isRecord);

/* Reasons written by people get quoted inside our own sentences. A reason that
   ends mid-air makes the sentence after it read like part of the same thought. */
const asSentence = (text) => {
  const trimmed = String(text ?? "").trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

const times = (count) => `${count} time${count === 1 ? "" : "s"}`;

/* ------------------------------------------------------------ kill switch */

/* Halted if EITHER signal says so. The file and the ledger are deliberately
   not kept in sync by this function: a file placed by hand during an incident
   must halt a system whose ledger says "running", and a halt recorded in the
   ledger must survive somebody deleting the file. Two independent brakes. */
export async function isHalted(root) {
  const file = killSwitchPath(root);
  const contents = await readFile(file, "utf8").catch(() => null);
  if (contents !== null) {
    const stamped = await stat(file).catch(() => null);
    return {
      halted: true,
      reason: contents.trim() || `The file ${KILL_SWITCH_FILE} exists and nothing was written inside it, so no reason was recorded.`,
      since: stamped ? stamped.mtime.toISOString() : null,
      source: "file",
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
   halted while still writing. */
export async function haltNow(root, { reason, by } = {}) {
  const text = String(reason ?? "").trim() || "Halted by hand. No reason was given.";
  await mkdir(path.dirname(killSwitchPath(root)), { recursive: true });
  await writeFile(killSwitchPath(root), `${text}\n`);
  return appendEntry(root, { kind: "halt", state: "on", reason: text, by: by || "unknown" });
}

/* Start again. The ledger entry is written BEFORE the file is removed, for the
   mirror image of the reason above: if only one succeeds, the system stays
   halted. Turning a brake off is never the step that gets the benefit of the
   doubt. */
export async function resumeHalt(root, { by } = {}) {
  const record = await appendEntry(root, { kind: "halt", state: "off", by: by || "unknown" });
  /* force: removing a kill switch that was never there is a normal outcome of
     "resume", not an error a founder should ever see. */
  await rm(killSwitchPath(root), { force: true });
  return record;
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
  const from = now - windowHours * HOUR;
  const byAccount = new Map();

  for (const entry of records(entries)) {
    if (entry.kind !== "restore") continue;
    if (entry.result !== "applied") continue;
    if (entry.direction !== "grant" && entry.direction !== "remove") continue;
    const at = timeOf(entry);
    /* An entry we cannot place in time cannot be shown to be inside the
       window, and a fight we cannot prove is not one we report. */
    if (at === null || at <= from) continue;
    const account = String(entry.account ?? "");
    if (!account) continue;
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push({ at, direction: entry.direction });
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
      /* Unmeasurable stays null. An entry with no readable timestamp does not
         get a made-up duration. */
      heldHours: at === null ? null : Math.max(0, Math.round((now - at) / HOUR)),
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

const isCleanResult = (row) => row.clean === true || row.result === "clean";

/* A release does not touch customers until it has run cleanly somewhere that
   is not a customer. The whole value of this gate is what it does with
   MISSING evidence: nothing found means not allowed. A gate that opens when it
   cannot find the canary result is a gate that opens every time the canary
   fails to report, which is exactly when it matters. */
export function canaryGate({ releaseId, canaryResults, minimumClean = SAFETY_DEFAULTS.minimumCleanCanaries } = {}) {
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
      reason: `${notClean} of the ${mine.length} canary runs for release ${releaseId} did not come back clean. Nothing was written. Read the canary result before letting this release touch customers.`,
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
  const restores = records(entries).filter((entry) => entry.kind === "restore");

  const countWithin = (windowMs) => restores.filter((entry) => {
    const at = timeOf(entry);
    /* An entry with no readable timestamp is counted as recent. The other
       choice is that one corrupt line buys an unlimited number of writes. */
    if (at === null) return true;
    /* Entries stamped in the future are counted too, so a machine with a
       skewed clock cannot hand itself a fresh budget. */
    return at > now - windowMs;
  }).length;

  const used = { hour: countWithin(HOUR), day: countWithin(DAY) };
  const remaining = { hour: Math.max(0, perHour - used.hour), day: Math.max(0, perDay - used.day) };
  const hourGone = used.hour >= perHour;
  const dayGone = used.day >= perDay;

  return {
    used,
    remaining,
    exhausted: hourGone || dayGone,
    reason: hourGone
      ? `Akeso has already changed access ${times(used.hour)} in the last hour, which is its limit of ${perHour} an hour. It has stopped writing until the hour rolls forward. If that many changes an hour is normal for your business, raise the limit. If it is not, this is the safety net catching something, and the queued list is the thing to read first.`
      : dayGone
        ? `Akeso has already changed access ${times(used.day)} in the last day, which is its limit of ${perDay} a day. It has stopped writing until tomorrow. If that many changes a day is normal for your business, raise the limit. If it is not, this is the safety net catching something, and the queued list is the thing to read first.`
        : null,
  };
}

/* ------------------------------------------------------------ the gate */

/* Every write goes through here, grants included. Returns reasons rather than
   throwing, so the caller can log all of them at once: a founder who fixes one
   refusal and hits the next one has been told half the truth twice.
 *
 * It never throws. If this function cannot work out whether a write is safe,
 * the answer is no. Our own failure is never permission. */
export async function guardWrite(root, { account, direction, entries = null, now = Date.now(), limits = {} } = {}) {
  const reasons = [];

  try {
    const ledger = Array.isArray(entries) ? entries : await readLedger(root);

    const halt = await isHalted(root);
    if (halt.halted) {
      reasons.push(`Akeso is halted, so it is not changing anyone's access, including giving access back to people who are paying. The reason recorded is: ${asSentence(halt.reason)} Nothing was written. Clear the halt when you want it running again.`);
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
    const unreadable = (Array.isArray(ledger) ? ledger : []).filter(isUnreadable).length;
    if (unreadable > 0) {
      reasons.push(`Akeso's own history file has ${unreadable} ${unreadable === 1 ? "line" : "lines"} it cannot read, and one of them could be the halt or the hold that should stop this change. Nothing was written. Restore .akeso/ledger.jsonl from a backup, or ask for help, before running with --apply again.`);
    }

    if (named) {
      const suspended = suspendedAccounts(ledger, { now }).find((row) => row.account === named);
      if (suspended) {
        reasons.push(`Account ${named} is on hold and Akeso will not change it automatically. The reason recorded is: ${asSentence(suspended.reason)} Nothing was written. Take the hold off that account when the cause is dealt with.`);
      }

      const flapping = detectFlapping(ledger, { now, ...limits }).find((row) => row.account === named);
      if (flapping && !suspended) {
        reasons.push(`Account ${named} has had its access changed ${times(flapping.flips)} since ${flapping.firstAt}, and ${flapping.directionChanges} of those changes undid the one before. Something other than Akeso is writing to this account, and Akeso will not join that fight. Nothing was written. Find the other thing that is writing, then put this account back in play.`);
      }
    }

    const budget = writeBudget(ledger, { now, ...limits });
    if (budget.exhausted) reasons.push(budget.reason);

    return { allowed: reasons.length === 0, reasons };
  } catch (error) {
    return {
      allowed: false,
      reasons: [`Akeso could not check its own safety rules, so it changed nothing. The fault was: ${error?.message || String(error)}. This is a problem inside Akeso, not a verdict about your app. Nothing was written.`],
    };
  }
}
