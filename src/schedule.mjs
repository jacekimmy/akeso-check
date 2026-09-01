import { setTimeout as sleep } from "node:timers/promises";

/* WHEN Akeso looks. Nothing else lives here.
 *
 * A one-off sweep answers "is access correct right now". Monitoring answers
 * "has access been correct every hour since you installed this", and the only
 * difference between the two is cadence plus an honest record of when the
 * cadence was missed.
 *
 * Four rhythms, each with a different job:
 *   - event driven, on the Stripe events that change entitlement (owned by the
 *     webhook side, not by this file)
 *   - a full sweep every hour, the backstop for events that never arrived
 *   - a deep sweep every day, for missed, duplicated and out of order events
 *   - a re-check after every deploy, because new code is the most common
 *     reason correct access starts drifting
 *
 * The rule that shapes every function below: a sweep that COULD NOT RUN did
 * not run. It does not satisfy the cadence, it does not close a coverage gap,
 * and it is never counted as a quiet hour. A broken monitor that looks like a
 * quiet monitor is the exact failure this whole product exists to argue
 * against, so the pass has to be earned by a completed sweep and nothing else.
 *
 * State is folded out of the append-only ledger at read time. This module
 * never mutates anything and never talks to the network, so every rule in it
 * is testable with a plain array and a fixed clock.
 */

export const CADENCE = {
  fullSweepMinutes: 60,
  deepSweepHours: 24,
  afterDeployDelaySeconds: 60,
};

/* Sweeps started an hour apart never land exactly an hour apart: the sweep
   itself takes time and the loop wakes a little late. Without this grace the
   monthly statement would report a gap of a few seconds every single hour, and
   a statement full of non-gaps is a statement nobody reads. */
const GAP_GRACE_MINUTES = 5;

const MINUTE = 60000;
const HOUR = 3600000;

/* ------------------------------------------------------------ the clock */

function msOf(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/* An unreadable clock is a programmer error at the edge, and guessing a time
   here would silently move every deadline in the product. */
function requireMs(value, label) {
  const ms = msOf(value);
  if (ms === null) throw new TypeError(`schedule: ${label} must be a Date, a millisecond number, or an ISO string`);
  return ms;
}

function requirePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`schedule: ${label} must be a finite number greater than zero`);
  }
  return value;
}

function requireAtLeastZero(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`schedule: ${label} must be a finite number of zero or more`);
  }
  return value;
}

const iso = (ms) => new Date(ms).toISOString();

/* One place where a cadence is read and checked.
 *
 * An unreadable cadence used to sail straight through as NaN, and a NaN
 * deadline is never overdue: dueWork answered "nothing is due" and nextRunAt
 * crashed on the date it tried to build. False quiet caused by our own bad
 * configuration is the one answer this product may never give, so a cadence
 * that cannot be read is refused here instead of being guessed at. */
function cadenceOf(cadence) {
  const fullSweepMinutes = requirePositive(cadence?.fullSweepMinutes ?? CADENCE.fullSweepMinutes, "cadence.fullSweepMinutes");
  const deepSweepHours = requirePositive(cadence?.deepSweepHours ?? CADENCE.deepSweepHours, "cadence.deepSweepHours");
  const afterDeployDelaySeconds = requireAtLeastZero(cadence?.afterDeployDelaySeconds ?? CADENCE.afterDeployDelaySeconds, "cadence.afterDeployDelaySeconds");
  return {
    fullSweepMinutes,
    deepSweepHours,
    afterDeployDelaySeconds,
    fullMs: fullSweepMinutes * MINUTE,
    deepMs: deepSweepHours * HOUR,
    deployMs: afterDeployDelaySeconds * 1000,
  };
}

/* A ledger line of literal `null` parses to a null entry, and a row that is not
   an object cannot be read as a sweep or a deploy. Those rows are counted as
   untrusted rather than skipped in silence, and never as coverage. */
function rowsOf(entries) {
  if (entries === null || entries === undefined) return { rows: [], unusable: 0 };
  if (!Array.isArray(entries)) throw new TypeError("schedule: entries must be an array of ledger entries");
  const rows = entries.filter((row) => row && typeof row === "object");
  return { rows, unusable: entries.length - rows.length };
}

/* ---------------------------------------------------------- the folding */

/* A sweep counts as coverage only when it says it finished AND it recorded
   what it compared. runSweep writes couldNotRun with a null comparison when it
   fails, so this is the same contract read from the other end. The failure
   direction is deliberate: an entry we cannot read as a completed sweep makes
   Akeso sweep again, which is read-only and cheap, rather than making a broken
   hour look covered. */
export const isSweepAttempt = (entry) => entry?.kind === "sweep";
const completedSweep = (entry) => isSweepAttempt(entry) && !entry.couldNotRun && entry.comparison !== null && entry.comparison !== undefined;
/* A deep sweep is a full sweep plus the harder questions, so it is written as
   a sweep entry carrying deep: true. Giving it a separate kind would make a
   project that only ran deep sweeps look like it never swept at all. */
const deepSweep = (entry) => completedSweep(entry) && entry.deep === true;

/* Everything the schedule needs, folded out of the ledger in one pass.
   Timestamps after `now` are ignored rather than trusted: a sweep stamped in
   the future cannot prove it ran, and letting it satisfy the cadence would
   mean one bad clock buys hours of false quiet. */
function fold(entries, nowMs) {
  const { rows, unusable } = rowsOf(entries);
  const successTimes = [];
  let attempts = 0;
  let failed = 0;
  let ignored = unusable;
  let firstAttemptAt = null;
  let lastAttemptAt = null;
  let lastAttemptCouldNotRun = null;
  let lastDeepAt = null;
  let lastDeployAt = null;
  let lastDeployRef = null;

  for (const entry of rows) {
    /* The newest deploy is found by its timestamp, not by its position in the
       file. Taking the last deploy line meant a single deploy stamped in the
       future, or stamped with something unreadable, silently cancelled the
       re-check a real deploy had already earned, and cancelled it without
       saying so. */
    if (entry.kind === "deploy") {
      const at = msOf(entry.at);
      if (at === null || at > nowMs) { ignored += 1; continue; }
      if (lastDeployAt === null || at > lastDeployAt) { lastDeployAt = at; lastDeployRef = entry.ref ?? null; }
      continue;
    }
    if (!isSweepAttempt(entry)) continue;
    const at = msOf(entry.at);
    if (at === null || at > nowMs) { ignored += 1; continue; }

    const finished = completedSweep(entry);
    attempts += 1;
    if (firstAttemptAt === null || at < firstAttemptAt) firstAttemptAt = at;
    if (lastAttemptAt === null || at > lastAttemptAt) {
      lastAttemptAt = at;
      lastAttemptCouldNotRun = !finished;
    } else if (at === lastAttemptAt && !finished) {
      /* Two attempts sharing the newest instant must not give two different
         answers depending on which line was written first. If either of them
         did not finish, that is the fact worth surfacing. */
      lastAttemptCouldNotRun = true;
    }
    if (!finished) { failed += 1; continue; }
    successTimes.push(at);
    if (deepSweep(entry) && (lastDeepAt === null || at > lastDeepAt)) lastDeepAt = at;
  }

  successTimes.sort((a, b) => a - b);
  const lastFullAt = successTimes.at(-1) ?? null;

  return {
    nowMs,
    attempts,
    completed: successTimes.length,
    failed,
    ignored,
    firstAttemptAt,
    lastAttemptAt,
    lastAttemptCouldNotRun,
    lastFullAt,
    lastDeepAt,
    successTimes,
    /* Only attempts since the last completed sweep matter to a reader: they are
       the ones standing between them and current information. An attempt that
       recorded no comparison counts here too, because it left the reader just
       as uninformed as one that openly could not run. */
    failedSinceLastSuccess: rows.filter((entry) => {
      if (!isSweepAttempt(entry) || completedSweep(entry)) return false;
      const at = msOf(entry.at);
      return at !== null && at <= nowMs && (lastFullAt === null || at > lastFullAt);
    }).length,
    lastDeployAt,
    lastDeployRef,
  };
}

/* The window coverage is actually measured over: never earlier than the first
   attempt, because Akeso cannot report on time it was not watching. */
function gapAnchor(folded, nowMs, sinceDays) {
  if (folded.firstAttemptAt === null) return null;
  return Math.max(nowMs - sinceDays * 24 * HOUR, folded.firstAttemptAt);
}

/* A deploy is re-checked after a short settling delay rather than instantly,
   because the first seconds of a deploy are the seconds most likely to answer
   with a half-started app, and blaming their app for our timing is the fault
   we refuse to commit. */
const deployRecheckPending = (folded) => folded.lastDeployAt !== null && (folded.lastFullAt === null || folded.lastDeployAt > folded.lastFullAt);

/* ------------------------------------------------------------- what is due */

export function dueWork(entries = [], { now = Date.now(), cadence = CADENCE } = {}) {
  const nowMs = requireMs(now, "now");
  const rhythm = cadenceOf(cadence);
  const folded = fold(entries, nowMs);
  const reasons = [];
  let full = false;
  let deep = false;

  if (folded.lastFullAt === null) {
    full = true;
    reasons.push(folded.attempts
      ? {
        work: "full",
        code: "no_sweep_has_completed",
        detail: `Akeso has tried to check ${countWord(folded.attempts, "time")} and none of them finished. Nothing is being watched until one does.`,
      }
      : {
        work: "full",
        code: "never_swept",
        detail: "Akeso has not checked your customers yet, so there is nothing to be quiet about.",
      });
  } else {
    const age = nowMs - folded.lastFullAt;
    if (age >= rhythm.fullMs) {
      full = true;
      reasons.push({
        work: "full",
        code: "cadence_due",
        overdueMinutes: Math.round((age - rhythm.fullMs) / MINUTE),
        detail: `The last completed check was ${ago(age)}, and Akeso checks every ${rhythm.fullSweepMinutes} minutes.`,
      });
    }
  }

  if (deployRecheckPending(folded) && nowMs >= folded.lastDeployAt + rhythm.deployMs) {
    full = true;
    reasons.push({
      work: "full",
      code: "after_deploy",
      detail: `Your app was deployed ${ago(nowMs - folded.lastDeployAt)} and no check has finished since. New code is the most common reason access starts drifting.`,
    });
  }

  if (folded.lastDeepAt === null) {
    deep = true;
    reasons.push({
      work: "deep",
      code: "never_deep_swept",
      detail: "The daily deep check, which looks for missed, repeated and out of order Stripe events, has never finished.",
    });
  } else {
    const age = nowMs - folded.lastDeepAt;
    if (age >= rhythm.deepMs) {
      deep = true;
      reasons.push({
        work: "deep",
        code: "deep_cadence_due",
        overdueMinutes: Math.round((age - rhythm.deepMs) / MINUTE),
        detail: `The last deep check was ${ago(age)}, and Akeso runs one every ${rhythm.deepSweepHours} hours.`,
      });
    }
  }

  return { full, deep, reasons };
}

/* When the next full sweep is due. Already due reads as now, never as a time
   in the past, because a caller printing a past time would look broken. */
export function nextRunAt(entries = [], { now = Date.now(), cadence = CADENCE } = {}) {
  const nowMs = requireMs(now, "now");
  const rhythm = cadenceOf(cadence);
  if (dueWork(entries, { now: nowMs, cadence }).full) return iso(nowMs);

  const folded = fold(entries, nowMs);
  const candidates = [];
  if (folded.lastFullAt !== null) candidates.push(folded.lastFullAt + rhythm.fullMs);
  if (deployRecheckPending(folded)) candidates.push(folded.lastDeployAt + rhythm.deployMs);
  /* Nothing due and nothing to schedule from cannot happen, but a fallback of
     "now" is the honest one: it never claims coverage we cannot show. */
  return iso(candidates.length ? Math.min(...candidates) : nowMs);
}

/* ------------------------------------------------------------- the gaps */

/* The periods where no completed sweep happened when one was due. This is what
   keeps the monthly statement honest: a month with four dark hours in it is a
   month with four dark hours in it, and hiding them would make every other
   number in the statement worth nothing.
 *
 * An empty array from a project that never swept means "nothing measured",
 * NOT "fully covered". Coverage is measured from the first sweep attempt,
 * because before that Akeso was not watching and claiming a gap for time it
 * was never asked to cover would be its own kind of invented number. Callers
 * showing this to a human must say which of the two they are looking at;
 * describeSchedule does. */
export function coverageGaps(entries = [], { now = Date.now(), cadence = CADENCE, sinceDays = 30 } = {}) {
  const nowMs = requireMs(now, "now");
  const stride = cadenceOf(cadence).fullMs;
  /* A window that cannot be read would silently become "no gaps found", which
     reads to a founder as a clean month. Refused rather than guessed. */
  requirePositive(sinceDays, "sinceDays");
  const folded = fold(entries, nowMs);
  const anchor = gapAnchor(folded, nowMs, sinceDays);
  if (anchor === null) return [];

  const grace = GAP_GRACE_MINUTES * MINUTE;
  const before = folded.successTimes.filter((at) => at < anchor).at(-1) ?? null;
  const inside = folded.successTimes.filter((at) => at >= anchor);

  const gaps = [];
  /* cursor is the moment coverage ran out: one cadence after the last
     completed sweep, or the anchor when there is no earlier sweep to lean on. */
  let cursor = before === null ? anchor : before + stride;
  for (const at of [...inside, nowMs]) {
    const from = Math.max(cursor, anchor);
    if (at - from > grace) {
      gaps.push({ from: iso(from), to: iso(at), hours: Math.round((at - from) / 360000) / 10 });
    }
    cursor = Math.max(cursor, at + stride);
  }
  return gaps;
}

/* ------------------------------------------------------------- the loop */

/* The cadence, actually running. Every moving part is injected so the tests
   drive it with a counter instead of a clock: a scheduler proven only by
   waiting is a scheduler nobody re-proves after a change.
 *
 * One tick failing is normal life: a deploy restarts the app, Stripe rate
 * limits, a laptop sleeps. The loop records it and keeps its rhythm, because a
 * monitor that dies silently on one bad night is worse than no monitor at all
 * (no monitor at least does not make anyone feel covered). */
export async function runLoop({
  tick,
  shouldStop = () => false,
  intervalMs = CADENCE.fullSweepMinutes * MINUTE,
  sleepImpl = sleep,
  now = Date.now,
  onError = null,
} = {}) {
  if (typeof tick !== "function") throw new TypeError("schedule: runLoop needs a tick function to call");
  /* An interval of zero, or a NaN from a mis-parsed command line flag, makes
     setTimeout return almost immediately, and the loop that was meant to run
     hourly hammers Stripe and the founder's app instead. Pacing ourselves by
     luck is exactly what the sleep guard below refuses, so refuse it here. */
  requirePositive(intervalMs, "intervalMs");
  const clock = typeof now === "function" ? now : () => requireMs(now, "now");

  const errors = [];
  let ticks = 0;
  let stoppedBecause = "asked_to_stop";
  const startedAt = iso(requireMs(clock(), "now"));

  /* Once monitoring has started, a clock that stops answering must not throw
     away the run. The time is left null and said to be unknown, never filled
     in with a plausible one. */
  const nowIso = () => {
    try {
      return iso(requireMs(clock(), "now"));
    } catch {
      return null;
    }
  };

  const record = (phase, error) => {
    const message = error?.message || String(error);
    const at = nowIso();
    errors.push({ tick: ticks, at, phase, message });
    /* Reported, never swallowed. With no handler wired the founder still sees
       it, and the line says the loop is continuing so a single failure does
       not read as the monitor being dead. */
    try {
      if (onError) onError(error, { tick: ticks, at, phase });
      else console.error(`A scheduled check did not finish: ${message}. Akeso is still running and will try again at the next interval.`);
    } catch (reportingError) {
      /* onError is where the alerting gets wired, and alerting breaks. A
         throw from it used to escape the loop and end the monitoring, which
         made the reporting of a bad night more dangerous than the bad night. */
      errors.push({ tick: ticks, at, phase: "report", message: reportingError?.message || String(reportingError) });
      try {
        console.error(`A scheduled check did not finish: ${message}. Reporting that failure also failed. Akeso is still running and will try again at the next interval.`);
      } catch { /* Nowhere left to say it. Keep monitoring; the run record still carries both errors. */ }
    }
  };

  const stopRequested = () => {
    try {
      return Boolean(shouldStop());
    } catch (error) {
      /* We no longer know whether we were asked to stop. Stopping is the safe
         reading: a loop that cannot hear "stop" is a loop nobody can turn off. */
      record("stop_check", error);
      stoppedBecause = "stop_check_failed";
      return true;
    }
  };

  while (!stopRequested()) {
    ticks += 1;
    try {
      await tick({ tick: ticks, at: nowIso() });
    } catch (error) {
      record("tick", error);
    }

    if (stopRequested()) break;

    try {
      await sleepImpl(intervalMs);
    } catch (error) {
      /* Without a working sleep the loop would spin flat out and hammer both
         Stripe and the app. Stopping loudly beats pacing ourselves by luck. */
      record("sleep", error);
      stoppedBecause = "sleep_failed";
      break;
    }
  }

  return { ticks, errors, stoppedBecause, startedAt, endedAt: nowIso() };
}

/* ------------------------------------------------------------- the words */

/* Everything a human needs to know about the cadence, in one object, so the
   command layer prints and never recomputes. */
export function scheduleState(entries = [], { now = Date.now(), cadence = CADENCE, sinceDays = 30 } = {}) {
  const nowMs = requireMs(now, "now");
  const rhythm = cadenceOf(cadence);
  requirePositive(sinceDays, "sinceDays");
  const folded = fold(entries, nowMs);
  const due = dueWork(entries, { now: nowMs, cadence });
  const next = nextRunAt(entries, { now: nowMs, cadence });
  const overdue = folded.lastFullAt === null ? null : Math.max(0, nowMs - folded.lastFullAt - rhythm.fullMs);
  const windowFrom = gapAnchor(folded, nowMs, sinceDays);

  return {
    now: iso(nowMs),
    cadence,
    sinceDays,
    /* The period the gaps below were actually measured over. Without it a
       caller cannot tell a genuinely clean month from a project installed
       twenty minutes ago, and would print the same sentence for both. */
    gapWindowFrom: windowFrom === null ? null : iso(windowFrom),
    attempts: folded.attempts,
    completed: folded.completed,
    failed: folded.failed,
    failedSinceLastSuccess: folded.failedSinceLastSuccess,
    ignoredTimestamps: folded.ignored,
    firstAttemptAt: folded.firstAttemptAt === null ? null : iso(folded.firstAttemptAt),
    lastSweepAt: folded.lastFullAt === null ? null : iso(folded.lastFullAt),
    lastDeepSweepAt: folded.lastDeepAt === null ? null : iso(folded.lastDeepAt),
    lastDeployAt: folded.lastDeployAt === null ? null : iso(folded.lastDeployAt),
    lastAttemptCouldNotRun: folded.lastAttemptCouldNotRun,
    due,
    nextRunAt: next,
    overdueMinutes: overdue === null ? null : Math.round(overdue / MINUTE),
    gaps: coverageGaps(entries, { now: nowMs, cadence, sinceDays }),
  };
}

/* Plain English for a founder who will read this in a terminal at 8am and
   wants three facts: when Akeso last looked, when it looks next, and whether
   anything is wrong with the looking itself. Returns lines, like
   describePolicy, so the caller owns the indenting. */
export function describeSchedule(state) {
  /* Accepting a raw ledger too, because a caller that has entries and a clock
     should not have to know which function to call first. */
  if (Array.isArray(state)) state = scheduleState(state);
  else if (state && Array.isArray(state.entries)) state = scheduleState(state.entries, state);
  if (!state || !state.now) return ["Akeso has no schedule information for this project yet."];

  const nowMs = msOf(state.now) ?? Date.now();
  const lines = [];

  /* Entries Akeso threw away are said out loud on every path. They used to be
     mentioned only in the middle path, so a ledger holding nothing but a
     future stamped sweep read as a clean "nothing has run yet" and the
     discarded evidence was never mentioned at all. */
  const untrusted = () => {
    if (!state.ignoredTimestamps) return [];
    const many = state.ignoredTimestamps > 1;
    return [`${countWord(state.ignoredTimestamps, "entry", "entries")} in the history ${many ? "carry times" : "carries a time"} Akeso cannot trust, so ${many ? "they were" : "it was"} not counted. Akeso checks again rather than treat that time as covered.`];
  };

  if (!state.attempts) {
    lines.push("Akeso has not checked your customers yet.");
    lines.push("Nothing is being watched until the first check runs. Start the monitor and it begins immediately.");
    return [...lines, ...untrusted()];
  }

  if (!state.completed) {
    lines.push(`Akeso has tried to check ${countWord(state.attempts, "time")} and none of them finished.`);
    lines.push("That is a problem with Akeso's own run, not a verdict about your app. Nothing here is being watched until one check finishes.");
    lines.push("The next attempt is due now.");
    return [...lines, ...untrusted()];
  }

  lines.push(`Akeso last checked your customers ${ago(nowMs - msOf(state.lastSweepAt))}, at ${clockText(state.lastSweepAt)}.`);

  if (state.due?.full) {
    const deployed = state.due.reasons.some((reason) => reason.code === "after_deploy");
    const late = lateBy(state.overdueMinutes * MINUTE);
    if (deployed) lines.push("A check is due now, because your app was deployed since the last one finished.");
    else if (late) lines.push(`A check is due now, and it is ${late} later than it should have been. Something is stopping the checks from finishing.`);
    else lines.push("A check is due now, and Akeso runs it next.");
  } else {
    lines.push(`The next check is due ${inWords(msOf(state.nextRunAt) - nowMs)}, at ${clockText(state.nextRunAt)}.`);
  }

  if (state.lastDeepSweepAt === null) {
    lines.push("The daily deep check, which looks for missed, repeated and out of order Stripe events, has not finished yet. It runs with the next deep pass.");
  } else if (state.due?.deep) {
    lines.push(`The daily deep check last finished ${ago(nowMs - msOf(state.lastDeepSweepAt))} and is due now.`);
  } else {
    lines.push(`The daily deep check last finished ${ago(nowMs - msOf(state.lastDeepSweepAt))}.`);
  }

  if (state.failedSinceLastSuccess) {
    lines.push(`${countWord(state.failedSinceLastSuccess, "check")} since then did not finish, so the newest information you have is from the last one that did. Akeso keeps trying at the usual interval.`);
  }
  lines.push(...untrusted());

  /* The window the gaps were measured over, in the reader's words.
   *
   * "No gaps in the last 30 days" used to be printed for a project installed
   * twenty minutes ago, which is a claim about 29 days Akeso never watched.
   * The sentence now only ever covers the time actually measured. */
  const windowFrom = msOf(state.gapWindowFrom ?? state.firstAttemptAt);
  const wholePeriod = windowFrom === null || windowFrom <= nowMs - state.sinceDays * 24 * HOUR + MINUTE;
  const windowPhrase = wholePeriod ? `in the last ${state.sinceDays} days` : `since Akeso started watching at ${clockText(windowFrom)}`;

  const gaps = state.gaps || [];
  if (!gaps.length) {
    lines.push(`No gaps ${windowPhrase}: a check finished every time one was due.`);
  } else {
    /* Summed from the real start and end of each period. Adding up the rounded
       hours instead drifted by a fraction per gap, and a total that does not
       match its own list is the kind of small wrongness that costs a reader
       their trust in every other number on the page. */
    const totalMs = gaps.reduce((sum, gap) => sum + Math.max(0, (msOf(gap.to) ?? 0) - (msOf(gap.from) ?? 0)), 0);
    lines.push(`${countWord(gaps.length, "period")} ${windowPhrase} had no finished check, ${Math.round(totalMs / 360000) / 10} hours in total.`);
    for (const gap of gaps.slice(0, 3)) lines.push(`  ${gap.hours} hours from ${clockText(gap.from)}.`);
    if (gaps.length > 3) lines.push(`  and ${gaps.length - 3} more.`);
    lines.push("Those hours are not covered by anything Akeso can tell you about, and the statement says so rather than averaging them away.");
  }
  if (!wholePeriod) {
    lines.push(`Akeso cannot speak for the ${state.sinceDays} days before that, because it was not watching yet.`);
  }

  return lines;
}

/* ------------------------------------------------------------- wording */

function countWord(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 90 * 1000) return "just now";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} minutes ago`;
  if (ms < 36 * HOUR) return `${hours(ms)} ago`;
  return `${Math.round(ms / (24 * HOUR))} days ago`;
}

/* "about 1 hours" is the kind of seam that tells a reader a machine wrote the
   sentence, and a founder who stops trusting the sentences stops reading. */
function hours(ms) {
  const count = Math.round(ms / HOUR);
  return count === 1 ? "about an hour" : `about ${count} hours`;
}

/* How late, or null when the lateness is inside the normal wobble of a loop
   and saying it out loud would be alarming about nothing. */
function lateBy(ms) {
  if (!Number.isFinite(ms) || ms < GAP_GRACE_MINUTES * MINUTE) return null;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} minutes`;
  if (ms < 36 * HOUR) return hours(ms);
  return `${Math.round(ms / (24 * HOUR))} days`;
}

function inWords(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  if (ms < MINUTE) return "in under a minute";
  if (ms < HOUR) return `in about ${Math.round(ms / MINUTE)} minutes`;
  if (ms < 36 * HOUR) return `in ${hours(ms)}`;
  return `in about ${Math.round(ms / (24 * HOUR))} days`;
}

/* UTC, spelled out. A bare timestamp with no zone is the kind of small
   ambiguity that turns into "your report is wrong" an hour later. */
const clockText = (value) => {
  const ms = msOf(value);
  return ms === null ? "an unknown time" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
