import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CADENCE, coverageGaps, describeSchedule, dueWork, nextRunAt, runLoop, scheduleState } from "../src/schedule.mjs";
import { appendEntry, readLedger, sweepEntry } from "../src/ledger.mjs";

/* The schedule decides whether Akeso is watching or only looks like it is.
   Every test here is a rule that stands between a broken monitor and a founder
   who believes they are covered. */

const MINUTE = 60000;
const HOUR = 3600000;
const NOW = Date.parse("2026-08-31T12:00:00.000Z");

const at = (ms) => new Date(ms).toISOString();
const sweep = (ms, extra = {}) => ({ kind: "sweep", at: at(ms), comparison: { clean: true }, ...extra });
const deepSweep = (ms) => sweep(ms, { deep: true });
const unrunSweep = (ms, why = "your app answered 502") => ({ kind: "sweep", at: at(ms), couldNotRun: why, comparison: null });
const deploy = (ms, ref = "abc1234") => ({ kind: "deploy", at: at(ms), ref });
const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-schedule-"));

/* ------------------------------------------------------------- what is due */

test("a monitor that has never looked is due immediately, not treated as quiet", () => {
  const due = dueWork([], { now: NOW });
  assert.equal(due.full, true);
  assert.equal(due.deep, true);
  assert.equal(due.reasons.find((reason) => reason.work === "full").code, "never_swept");
});

test("a check that could not run does not satisfy the cadence", () => {
  const due = dueWork([unrunSweep(NOW - MINUTE)], { now: NOW });
  assert.equal(due.full, true, "a failed sweep a minute ago must never buy an hour of silence");
  const reason = due.reasons.find((r) => r.work === "full");
  assert.equal(reason.code, "no_sweep_has_completed");
  assert.match(reason.detail, /none of them finished/);
});

test("failures after a completed check do not erase the check that finished", () => {
  const entries = [sweep(NOW - 30 * MINUTE), unrunSweep(NOW - 2 * MINUTE), unrunSweep(NOW - MINUTE)];
  assert.equal(dueWork(entries, { now: NOW }).full, false, "the finished sweep still covers this hour");
  assert.equal(scheduleState(entries, { now: NOW }).failedSinceLastSuccess, 2, "the failures are still counted and reported");
});

test("a completed check inside the hour leaves nothing due", () => {
  const due = dueWork([sweep(NOW - 30 * MINUTE), deepSweep(NOW - 2 * HOUR)], { now: NOW });
  assert.equal(due.full, false);
  assert.equal(due.deep, false);
  assert.deepEqual(due.reasons, [], "nothing due means nothing to explain");
});

test("a check stamped in the future can never satisfy the cadence", () => {
  const entries = [sweep(NOW + HOUR), deepSweep(NOW + HOUR)];
  assert.equal(dueWork(entries, { now: NOW }).full, true, "one bad clock must not buy hours of false quiet");
  assert.equal(scheduleState(entries, { now: NOW }).ignoredTimestamps, 2);
});

test("a sweep entry that recorded no comparison is not counted as a finished check", () => {
  /* The pass has to be earned. An entry that cannot show what it compared is
     not proof that anything was compared. */
  const due = dueWork([{ kind: "sweep", at: at(NOW - MINUTE), comparison: null }], { now: NOW });
  assert.equal(due.full, true);
});

test("the daily deep check runs on its own clock", () => {
  const due = dueWork([sweep(NOW - 10 * MINUTE), deepSweep(NOW - 25 * HOUR)], { now: NOW });
  assert.equal(due.full, false, "the hourly cadence is satisfied");
  assert.equal(due.deep, true);
  assert.equal(due.reasons.find((r) => r.work === "deep").code, "deep_cadence_due");
});

test("a deep check also counts as the hourly check, because it is one plus more", () => {
  const due = dueWork([deepSweep(NOW - 10 * MINUTE)], { now: NOW });
  assert.equal(due.full, false, "a project that only runs deep sweeps must not look like it never sweeps");
  assert.equal(due.deep, false);
});

test("a deploy makes a check due again, once the app has had time to settle", () => {
  const settled = dueWork([sweep(NOW - 5 * MINUTE), deploy(NOW - 5 * MINUTE + 1000)], { now: NOW });
  assert.equal(settled.full, true);
  assert.equal(settled.reasons.find((r) => r.code === "after_deploy").work, "full");

  const stillStarting = dueWork([sweep(NOW - 5 * MINUTE), deploy(NOW - 10 * 1000)], { now: NOW });
  assert.equal(stillStarting.full, false, "blaming their app for our timing during a restart is our fault, not theirs");
});

test("a deploy already followed by a finished check does not ask for another", () => {
  const due = dueWork([deploy(NOW - 2 * HOUR), sweep(NOW - 5 * MINUTE)], { now: NOW });
  assert.equal(due.full, false);
});

test("a caller's own cadence is honoured, not the default", () => {
  const cadence = { fullSweepMinutes: 5, deepSweepHours: 1, afterDeployDelaySeconds: 10 };
  const entries = [deepSweep(NOW - 6 * MINUTE)];
  assert.equal(dueWork(entries, { now: NOW, cadence }).full, true);
  assert.equal(dueWork(entries, { now: NOW }).full, false, "the same ledger is not due under the hourly default");
});

test("the clock may be given as a Date, a number, or an ISO string", () => {
  const entries = [sweep(NOW - 30 * MINUTE)];
  for (const now of [NOW, new Date(NOW), at(NOW)]) {
    assert.equal(dueWork(entries, { now }).full, false);
  }
  assert.throws(() => dueWork(entries, { now: "not a time" }), /must be a Date/);
});

/* -------------------------------------------------------------- next run */

test("the next run is now when a check is already due", () => {
  assert.equal(nextRunAt([], { now: NOW }), at(NOW));
  assert.equal(nextRunAt([unrunSweep(NOW - MINUTE)], { now: NOW }), at(NOW), "a failed check does not push the next one an hour out");
});

test("the next run is one cadence after the last finished check", () => {
  assert.equal(nextRunAt([sweep(NOW - 20 * MINUTE)], { now: NOW }), at(NOW + 40 * MINUTE));
});

test("the next run is the deploy re-check when that comes first", () => {
  const entries = [sweep(NOW - 50 * MINUTE), deploy(NOW - 10 * 1000)];
  assert.equal(nextRunAt(entries, { now: NOW }), at(NOW - 10 * 1000 + CADENCE.afterDeployDelaySeconds * 1000));
});

/* ---------------------------------------------------------- coverage gaps */

test("regular checks leave no coverage gaps", () => {
  const entries = [5, 4, 3, 2, 1, 0].map((hours) => sweep(NOW - hours * HOUR));
  assert.deepEqual(coverageGaps(entries, { now: NOW }), []);
});

test("a stretch with no finished check is reported as the gap it was", () => {
  const entries = [sweep(NOW - 10 * HOUR), sweep(NOW - 9 * HOUR), sweep(NOW - 2 * HOUR), sweep(NOW - HOUR)];
  const gaps = coverageGaps(entries, { now: NOW });

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].hours, 6, "seven dark hours minus the one hour that was not yet overdue");
  assert.equal(gaps[0].from, at(NOW - 8 * HOUR));
  assert.equal(gaps[0].to, at(NOW - 2 * HOUR));
});

test("checks that could not run leave exactly the same gap as no checks at all", () => {
  const failing = [8, 7, 6, 5, 4, 3].map((hours) => unrunSweep(NOW - hours * HOUR));
  const entries = [sweep(NOW - 10 * HOUR), sweep(NOW - 9 * HOUR), ...failing, sweep(NOW - 2 * HOUR), sweep(NOW - HOUR)];
  const gaps = coverageGaps(entries, { now: NOW });

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].hours, 6, "six attempts that could not run are still six dark hours");
});

test("a gap that is still open runs up to now", () => {
  const gaps = coverageGaps([sweep(NOW - 5 * HOUR), sweep(NOW - 4 * HOUR)], { now: NOW });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].to, at(NOW));
  assert.equal(gaps[0].hours, 3);
});

test("a small wobble in when the loop wakes is not reported as a gap", () => {
  const entries = [0, 1, 2, 3].map((n) => sweep(NOW - (3 - n) * HOUR + n * 90 * 1000));
  assert.deepEqual(coverageGaps(entries, { now: NOW }), [], "a statement full of non-gaps is one nobody reads");
});

test("coverage is only claimed from the first attempt, never before Akeso was watching", () => {
  const entries = [sweep(NOW - 20 * MINUTE)];
  assert.deepEqual(coverageGaps(entries, { now: NOW, sinceDays: 30 }), [], "the 30 days before install are not Akeso's to report on");
});

test("a project that never attempted a check reports no gaps, and the words say why", () => {
  assert.deepEqual(coverageGaps([], { now: NOW }), [], "nothing measured is not the same as fully covered");
  const said = describeSchedule(scheduleState([], { now: NOW })).join(" ");
  assert.match(said, /has not checked your customers yet/);
  assert.match(said, /Nothing is being watched/);
});

test("the gap window is clamped to the days asked for", () => {
  const gaps = coverageGaps([sweep(NOW - 60 * 24 * HOUR), sweep(NOW)], { now: NOW, sinceDays: 30 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, at(NOW - 30 * 24 * HOUR), "the report covers the period it says it covers");
  assert.equal(gaps[0].hours, 720);
});

/* ------------------------------------------------------------- the loop */

test("the loop survives a tick that throws and keeps its rhythm", async () => {
  let ticks = 0;
  const seen = [];
  const result = await runLoop({
    tick: () => { ticks += 1; if (ticks === 2) throw new Error("Stripe answered 429"); },
    shouldStop: () => ticks >= 4,
    intervalMs: HOUR,
    sleepImpl: async () => {},
    now: () => NOW,
    onError: (error, context) => seen.push({ message: error.message, ...context }),
  });

  assert.equal(result.ticks, 4, "one bad night must not end the monitoring");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tick, 2, "the failure is reported with the tick it happened on");
  assert.match(result.errors[0].message, /429/);
});

test("a failing tick is reported even when nobody wired a handler", async () => {
  const said = [];
  const realError = console.error;
  console.error = (line) => said.push(line);
  try {
    let ticks = 0;
    await runLoop({
      tick: () => { ticks += 1; throw new Error("the app is not running"); },
      shouldStop: () => ticks >= 1,
      sleepImpl: async () => {},
      now: () => NOW,
    });
  } finally {
    console.error = realError;
  }
  assert.equal(said.length, 1, "swallowed silently is the one thing a failure may never be");
  assert.match(said[0], /still running and will try again/);
});

test("the loop stops promptly when it is told to, without sleeping first", async () => {
  let ticks = 0;
  let sleeps = 0;
  const result = await runLoop({
    tick: () => { ticks += 1; },
    shouldStop: () => ticks >= 3,
    sleepImpl: async () => { sleeps += 1; },
    now: () => NOW,
  });

  assert.equal(result.ticks, 3);
  assert.equal(sleeps, 2, "a stopped loop must not hold the process open for one more interval");
  assert.equal(result.stoppedBecause, "asked_to_stop");
});

test("a loop told to stop before it starts never ticks at all", async () => {
  let ticks = 0;
  const result = await runLoop({ tick: () => { ticks += 1; }, shouldStop: () => true, sleepImpl: async () => {}, now: () => NOW });
  assert.equal(ticks, 0);
  assert.equal(result.ticks, 0);
});

test("a loop whose sleep fails stops loudly instead of spinning", async () => {
  const errors = [];
  let ticks = 0;
  const result = await runLoop({
    tick: () => { ticks += 1; },
    shouldStop: () => false,
    sleepImpl: async () => { throw new Error("timers are gone"); },
    now: () => NOW,
    onError: (error) => errors.push(error.message),
  });

  assert.equal(result.ticks, 1, "spinning flat out would hammer both Stripe and the app");
  assert.equal(result.stoppedBecause, "sleep_failed");
  assert.deepEqual(errors, ["timers are gone"]);
});

test("a loop that cannot hear the stop signal stops rather than running forever", async () => {
  let ticks = 0;
  const result = await runLoop({
    tick: () => { ticks += 1; },
    shouldStop: () => { throw new Error("the stop flag file is unreadable"); },
    sleepImpl: async () => {},
    now: () => NOW,
    onError: () => {},
  });

  assert.equal(ticks, 0);
  assert.equal(result.stoppedBecause, "stop_check_failed");
});

test("the loop needs something to run and says so", async () => {
  await assert.rejects(() => runLoop({ shouldStop: () => true }), /needs a tick function/);
});

/* --------------------------------------------------------------- words */

test("the words say when Akeso last looked, when it looks next, and what is overdue", () => {
  const state = scheduleState([sweep(NOW - 20 * MINUTE), deepSweep(NOW - 20 * MINUTE)], { now: NOW });
  const said = describeSchedule(state).join(" ");

  assert.match(said, /last checked your customers 20 minutes ago/);
  assert.match(said, /next check is due in about 40 minutes/);
  assert.match(said, /No gaps in the last 30 days/);
});

test("the words admit when nothing has finished, and blame the run rather than the app", () => {
  const said = describeSchedule(scheduleState([unrunSweep(NOW - MINUTE), unrunSweep(NOW - 2 * MINUTE)], { now: NOW })).join(" ");
  assert.match(said, /tried to check 2 times and none of them finished/);
  assert.match(said, /not a verdict about your app/);
  assert.match(said, /due now/);
});

test("the words name the dark hours instead of averaging them away", () => {
  const entries = [sweep(NOW - 10 * HOUR), sweep(NOW - 9 * HOUR), sweep(NOW - 2 * HOUR), sweep(NOW - HOUR)];
  const said = describeSchedule(scheduleState(entries, { now: NOW })).join(" ");
  assert.match(said, /1 period in the last 30 days had no finished check, 6 hours in total/);
  assert.match(said, /6 hours from 2026-08-31 04:00 UTC/);
});

test("a late check is called late, in hours a person understands", () => {
  const said = describeSchedule(scheduleState([sweep(NOW - 4 * HOUR), deepSweep(NOW - 4 * HOUR)], { now: NOW })).join(" ");
  assert.match(said, /due now, and it is about 3 hours later than it should have been/);
});

test("a deploy is given as the reason the check came early", () => {
  const said = describeSchedule(scheduleState([sweep(NOW - 5 * MINUTE), deepSweep(NOW - HOUR), deploy(NOW - 2 * MINUTE)], { now: NOW })).join(" ");
  assert.match(said, /due now, because your app was deployed/);
});

test("describeSchedule takes a ledger directly, so a caller cannot wire it in the wrong order", () => {
  const entries = [sweep(NOW - 20 * MINUTE)];
  assert.deepEqual(
    describeSchedule({ entries, now: NOW }),
    describeSchedule(scheduleState(entries, { now: NOW })),
  );
});

test("every sentence a founder reads is plain English with nothing leaking through it", () => {
  const cases = [
    [],
    [unrunSweep(NOW - MINUTE)],
    [sweep(NOW - 20 * MINUTE), deepSweep(NOW - 20 * MINUTE)],
    [sweep(NOW - 10 * HOUR), sweep(NOW - HOUR), unrunSweep(NOW - MINUTE), deploy(NOW - 30 * MINUTE)],
    [sweep(NOW + HOUR)],
  ];
  for (const entries of cases) {
    for (const line of describeSchedule(scheduleState(entries, { now: NOW }))) {
      assert.doesNotMatch(line, /\p{Extended_Pictographic}/u, `no emoji: ${line}`);
      assert.doesNotMatch(line, /[—–]/, `no dashes standing in for punctuation: ${line}`);
      assert.doesNotMatch(line, /couldNotRun|undefined|NaN|Invalid Date|null/, `no internals leaking: ${line}`);
    }
  }
});

test("every reason for doing work explains itself to a human", () => {
  const due = dueWork([sweep(NOW - 3 * HOUR), deploy(NOW - 2 * HOUR)], { now: NOW });
  assert.ok(due.reasons.length >= 2);
  for (const reason of due.reasons) {
    assert.ok(["full", "deep"].includes(reason.work));
    assert.ok(reason.code, "a reason a caller cannot switch on is not a reason");
    assert.match(reason.detail, /^[A-Z].*\.$/, `plain sentence, not a code: ${reason.detail}`);
  }
});

/* -------------------------------------------------------- the real ledger */

test("a real sweep written to the ledger satisfies the cadence, and stops satisfying it on time", async () => {
  const root = await scratch();
  await appendEntry(root, sweepEntry({ comparison: { clean: true, counts: {} }, drift: {}, alerts: [] }));
  const entries = await readLedger(root);
  const writtenAt = Date.parse(entries.at(-1).at);

  assert.equal(dueWork(entries, { now: writtenAt + MINUTE }).full, false);
  assert.equal(dueWork(entries, { now: writtenAt + 61 * MINUTE }).full, true);
  assert.equal(nextRunAt(entries, { now: writtenAt + MINUTE }), at(writtenAt + 60 * MINUTE));
});

test("a real failed sweep written to the ledger never counts as coverage", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", couldNotRun: "Stripe answered 401", comparison: null, drift: null, alerts: [] });
  const entries = await readLedger(root);

  assert.equal(dueWork(entries, { now: Date.now() }).full, true);
  assert.equal(scheduleState(entries, { now: Date.now() }).completed, 0);
});
