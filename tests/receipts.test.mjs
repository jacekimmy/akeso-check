import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionReceipt, monthlyStatement, renderStatementHtml, renderStatementText } from "../src/receipts.mjs";
import { appendEntry, readLedger, restoreEntry } from "../src/ledger.mjs";

/* The statement is the thing a founder reads before deciding whether Akeso was
   worth paying for. Every test here protects it against the one failure that
   would make it worthless: saying something that was not measured. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-receipts-"));

const sweep = (at, { exposure = 0, clean = true } = {}) =>
  ({ kind: "sweep", at, comparison: { monthlyExposure: exposure, clean, counts: {} }, drift: {}, alerts: [] });

const failedSweep = (at, reason = "Stripe answered 401") =>
  ({ kind: "sweep", at, couldNotRun: reason, comparison: null, drift: null, alerts: [] });

const restore = (at, fields) =>
  ({ kind: "restore", at, account: "a1", direction: "grant", result: "applied", verified: true, before: false, after: true, ...fields });

/* What monitor.mjs actually writes when a sweep finds a disagreement: the
   comparison is not clean, and the removals it found are queued for a human. */
const driftSweep = (at, { exposure = 90, removalsQueued = 1, grants = 0 } = {}) =>
  ({ kind: "sweep", at, comparison: { monthlyExposure: exposure, clean: false, counts: {} },
    drift: { grants, removalsQueued, removalsHeld: 0, reportOnly: 0 }, alerts: [] });

const MAY = { month: "2026-05", now: "2026-06-02T00:00:00.000Z" };

/* ------------------------------------------------------- did not run vs clean */

test("a month with no sweeps says Akeso did not run and is never called clean", () => {
  const statement = monthlyStatement([], MAY);

  assert.equal(statement.didNotRun, true);
  assert.equal(statement.sweeps, 0);
  assert.equal(statement.sweepsClean, 0);
  assert.match(statement.headline, /did not run/);
  assert.ok(statement.notes.some((note) => /not a clean month/.test(note)), "the statement must refuse to be read as a clean month");

  const text = renderStatementText(statement);
  assert.match(text, /Akeso did not run/);
  assert.ok(!/found nothing wrong/.test(text), "silence from a monitor that never ran is not good news");
  assert.ok(!/everything matched\s*: 0/.test(text), "zero matched sweeps must not read as a measurement");
});

test("a month with no sweeps reports no exposure figure at all, not zero", () => {
  const statement = monthlyStatement([], MAY);

  assert.equal(statement.unpaidAccessExposure, null, "zero exposure would claim a reading that never happened");
  assert.match(statement.unpaidAccessExposureNote, /Not measured/);
  assert.match(renderStatementText(statement), /Unpaid access exposure\s+: not measured/);
});

test("a month where every sweep failed is not a clean month either", () => {
  const statement = monthlyStatement([failedSweep("2026-05-04T09:00:00.000Z"), failedSweep("2026-05-05T09:00:00.000Z")], MAY);

  assert.equal(statement.didNotRun, false, "it did try");
  assert.equal(statement.nothingMeasured, true);
  assert.equal(statement.sweepsClean, 0);
  assert.equal(statement.unpaidAccessExposure, null);
  assert.match(statement.headline, /could not complete a sweep/);
  assert.ok(statement.notes.some((note) => /not a verdict about your app/.test(note)), "our failure is never their failure");
});

test("a sweep that measured zero exposure is a measurement and is reported as zero", () => {
  const statement = monthlyStatement([sweep("2026-05-04T09:00:00.000Z", { exposure: 0, clean: true })], MAY);

  assert.equal(statement.unpaidAccessExposure, 0, "a real reading of zero is not the same as no reading");
  assert.equal(statement.sweepsClean, 1);
  assert.match(statement.unpaidAccessExposureNote, /1 sweep that measured it/);
});

/* ------------------------------------------------- a mismatch is never silence */

test("a month whose sweeps found a mismatch is never described as nothing wrong", () => {
  /* The failure this whole file exists to prevent: a month of sweeps that
     found a canceled customer still being let in, on a page that says the
     month was clean. Every day covered, so nothing else can raise the alarm. */
  const entries = Array.from({ length: 30 }, (_, day) =>
    driftSweep(`2026-04-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`));
  const statement = monthlyStatement(entries, { month: "2026-04", now: "2026-05-01T00:00:00.000Z" });

  assert.equal(statement.sweepsWithDrift, 30);
  assert.equal(statement.sweepsClean, 0);
  assert.ok(!/nothing wrong/.test(statement.headline), "sweeps that found a mismatch are not a quiet month");
  assert.ok(!/agreed with Stripe/.test(statement.subheadline));
  assert.ok(statement.notes.some((note) => /did not agree with Stripe/.test(note)));

  for (const rendered of [renderStatementText(statement), renderStatementHtml(statement)]) {
    assert.ok(!/found nothing wrong/.test(rendered), "the finding must survive into what the founder actually reads");
    assert.match(rendered, /mismatch/);
  }
});

test("access waiting to be removed is never left off the statement", () => {
  /* Doctrine: a removal only happens when a person says yes. A statement that
     does not mention the ones waiting is a statement that lets them sit. */
  const statement = monthlyStatement([driftSweep("2026-05-04T09:00:00.000Z", { removalsQueued: 2 })], MAY);

  assert.equal(statement.removalsWaitingAtLastSweep, 2);
  assert.match(statement.whatHappensNext, /waiting for you/);
  assert.ok(statement.notes.some((note) => /never takes paid access away on its own/.test(note)));
  assert.ok(!/Nothing needs you/.test(renderStatementText(statement)), "two people are waiting on a decision");
});

test("a mismatch the sweep itself fixed is not described as still open", () => {
  /* A sweep records what it found BEFORE it restores anything, so the sweep
     that found a locked-out customer and put them back a second later must
     not leave the page saying the problem is outstanding. */
  const statement = monthlyStatement([
    driftSweep("2026-05-04T09:00:00.000Z", { grants: 1, removalsQueued: 0 }),
    restore("2026-05-04T09:00:01.000Z", { account: "s5", verified: true }),
  ], { month: "2026-05", now: "2026-05-04T23:00:00.000Z" });

  assert.equal(statement.accessRestored, 1);
  assert.ok(!/still found/.test(statement.subheadline), "it was put right one second later");
  assert.match(statement.subheadline, /changed 1 of them afterwards/);
  assert.match(statement.subheadline, /Nothing has been measured since/, "the fix is not a new reading");
  assert.match(statement.whatHappensNext, /Run one more sweep/);
});

test("a mismatch that was gone by the last sweep is reported as both, not erased", () => {
  const statement = monthlyStatement([
    driftSweep("2026-05-01T09:00:00.000Z"),
    sweep("2026-05-02T09:00:00.000Z", { clean: true }),
  ], { month: "2026-05", now: "2026-05-02T23:00:00.000Z" });

  assert.equal(statement.openMismatch, false, "the newest reading is the current state");
  assert.equal(statement.sweepsWithDrift, 1);
  assert.ok(!/agreed with Stripe on every day/.test(statement.subheadline), "one day of the month plainly did not");
  assert.ok(statement.notes.some((note) => /did not agree with Stripe/.test(note)));
});

test("a finished sweep that recorded no verdict is never counted as a clean day", () => {
  /* Neither clean nor drift is knowable from an entry that never said. The
     one thing that must not happen is it being filed as clean. */
  const statement = monthlyStatement(
    [{ kind: "sweep", at: "2026-05-04T09:00:00.000Z", comparison: { monthlyExposure: 5, counts: {} } }],
    { month: "2026-05", now: "2026-05-04T23:00:00.000Z" },
  );

  assert.equal(statement.sweepsClean, 0);
  assert.equal(statement.sweepsWithDrift, 0);
  assert.equal(statement.sweepsWithNoVerdict, 1);
  assert.ok(!/nothing wrong/.test(statement.headline));
  assert.ok(!statement.notes.some((note) => /Every completed sweep found every account matching/.test(note)));
});

/* ------------------------------------------------------------ the three numbers */

test("revenue recovered and direct cost prevented are never numbers, only reasons", () => {
  const statement = monthlyStatement([sweep("2026-05-04T09:00:00.000Z", { exposure: 87 })], MAY);

  assert.equal(statement.revenueRecovered, null, "money Akeso cannot see is never a number, and never zero");
  assert.equal(statement.directCostPrevented, null);
  assert.match(statement.revenueRecoveredNote, /does not see your payouts/);
  assert.match(statement.directCostPreventedNote, /does not see your hosting or support costs/);
});

test("the three numbers are shown apart and never summed into one figure", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z", { exposure: 60, clean: false }),
    sweep("2026-05-05T09:00:00.000Z", { exposure: 90, clean: false }),
  ], MAY);

  assert.equal(statement.unpaidAccessExposure, 75, "exposure is averaged across the sweeps that measured it");

  const text = renderStatementText(statement);
  assert.match(text, /Unpaid access exposure/);
  assert.match(text, /Direct cost prevented/);
  assert.match(text, /Revenue recovered/);
  assert.ok(!/total/i.test(text), "a total of these three would overstate all three");
  assert.match(text, /never added together/);

  const html = renderStatementHtml(statement);
  assert.match(html, /never added together/);
  assert.ok(!/total/i.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), "no combined figure on the page either");
});

test("exposure is described as list price at stake, never as money recovered", () => {
  const statement = monthlyStatement([sweep("2026-05-04T09:00:00.000Z", { exposure: 42, clean: false })], MAY);
  assert.match(statement.unpaidAccessExposureNote, /not money you will get back/);
});

/* ----------------------------------------------------------- restores counted */

test("a restore that was applied but never read back counts as failed, not as restored", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "confirmed-one", verified: true }),
    restore("2026-05-04T09:02:00.000Z", { account: "unverified-one", verified: false }),
  ], MAY);

  assert.equal(statement.accessRestored, 1, "success is only claimed after the account is read back");
  assert.equal(statement.restoresVerified, 1);
  assert.equal(statement.restoresFailed, 1);
  assert.equal(statement.failures[0].account, "unverified-one");
  assert.match(statement.failures[0].why, /could not read it back/);
  assert.ok(statement.notes.some((note) => /not counted as restored/.test(note)));
});

test("a removal is counted apart from a restore and only when it was confirmed", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "gone", direction: "remove", before: true, after: false }),
    restore("2026-05-04T09:02:00.000Z", { account: "half-gone", direction: "remove", result: "failed", verified: false }),
  ], MAY);

  assert.equal(statement.accessRemoved, 1);
  assert.equal(statement.accessRestored, 0, "a removal is never counted as a restore");
  assert.equal(statement.restoresFailed, 1);
});

test("a change that was not needed is neither a restore nor a failure", () => {
  /* Your app already had the account the way Akeso was about to set it, and
     said so when read back. Counting that as a failed change would send the
     founder chasing an account where nothing was ever wrong. */
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "already-fine", result: "no_op", verified: true, before: true }),
  ], MAY);

  assert.equal(statement.restoresFailed, 0, "nothing failed here");
  assert.equal(statement.accessRestored, 0, "and nothing was restored either");
  assert.equal(statement.changesNotNeeded, 1);
  assert.ok(!/did not confirm/.test(statement.whatHappensNext));
  assert.match(statement.actions[0].line, /Nothing needed changing/);
});

test("Akeso failing to reach the app is never reported as the app answering", () => {
  /* could_not_reach covers paths where nothing was sent at all. Saying "the
     app answered could_not_reach" blames the customer for our own failure. */
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "unreachable", result: "could_not_reach", verified: false }),
  ], MAY);

  const line = statement.actions[0].line;
  assert.ok(!/app answered/.test(line), "nothing was necessarily sent, so the app answered nothing");
  assert.match(line, /could not reach your app/);
  assert.match(line, /not a finding about your app/);
  assert.match(statement.failures[0].why, /problem with the run/);
});

test("the outcome codes Akeso records never reach the founder raw", () => {
  for (const code of ["no_op", "conflict", "unsupported", "could_not_reach", "failed"]) {
    const statement = monthlyStatement([
      sweep("2026-05-04T09:00:00.000Z"),
      restore("2026-05-04T09:01:00.000Z", { account: "a1", result: code, verified: false }),
    ], MAY);
    const rendered = `${statement.failures[0].why} ${renderStatementText(statement)} ${renderStatementHtml(statement)}`;

    assert.ok(!/[a-z]+_[a-z]+/.test(rendered), `the outcome "${code}" reached the page as a code instead of a sentence`);
    assert.ok(statement.failures[0].why.split(" ").length > 4, `"${code}" must be explained, not restated`);
  }
});

/* --------------------------------------------------------------- coverage */

test("days with no sweep is honest about gaps in the middle of a month", () => {
  const statement = monthlyStatement(
    [sweep("2026-04-01T09:00:00.000Z"), sweep("2026-04-02T09:00:00.000Z"), sweep("2026-04-09T09:00:00.000Z")],
    { month: "2026-04", now: "2026-04-10T12:00:00.000Z" },
  );

  assert.equal(statement.coverage.daysInWindow, 10, "only the days that have happened are counted");
  assert.equal(statement.coverage.daysMeasured, 3);
  assert.equal(statement.coverage.daysWithNoSweep, 7);
  assert.ok(statement.notes.some((note) => /would not appear here/.test(note)), "a gap must say what it hides");
  assert.match(statement.whatHappensNext, /schedule/);
});

test("a day whose only sweep failed is not counted as a day that was checked", () => {
  const statement = monthlyStatement(
    [sweep("2026-04-01T09:00:00.000Z"), failedSweep("2026-04-02T09:00:00.000Z")],
    { month: "2026-04", now: "2026-04-02T23:00:00.000Z" },
  );

  assert.equal(statement.coverage.daysMeasured, 1, "a dead Stripe key must never look like coverage");
  assert.equal(statement.coverage.daysWithNoSweep, 1);
  assert.equal(statement.sweepsCouldNotRun, 1);
});

test("a fully covered month says so, and only then", () => {
  const entries = Array.from({ length: 30 }, (_, day) =>
    sweep(`2026-04-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`));
  const statement = monthlyStatement(entries, { month: "2026-04", now: "2026-05-01T00:00:00.000Z" });

  assert.equal(statement.coverage.daysWithNoSweep, 0);
  assert.match(statement.headline, /checked every day of April 2026/);
  assert.equal(statement.coverage.firstSweepAt, "2026-04-01T09:00:00.000Z");
  assert.equal(statement.coverage.lastSweepAt, "2026-04-30T09:00:00.000Z");
});

test("a month with gaps never claims every day was checked", () => {
  /* The other half of the rule above: the full-coverage sentence must be
     unavailable to a month that was not fully covered. */
  const statement = monthlyStatement(
    [sweep("2026-04-01T09:00:00.000Z"), sweep("2026-04-02T09:00:00.000Z")],
    { month: "2026-04", now: "2026-04-10T12:00:00.000Z" },
  );

  assert.ok(!/every day/.test(statement.headline), "eight of ten days were never looked at");
  assert.ok(!/every day that was checked/.test(statement.subheadline) || /On the days it ran/.test(statement.subheadline));
  assert.match(statement.subheadline, /On the days it ran/);
});

test("sweeps dated after the statement was made are never counted as coverage", () => {
  /* A clock that jumped backwards once filled a three day window with three
     future-dated sweeps and produced "checked every day of May". */
  const statement = monthlyStatement([
    sweep("2026-05-10T09:00:00.000Z"), sweep("2026-05-11T09:00:00.000Z"), sweep("2026-05-12T09:00:00.000Z"),
  ], { month: "2026-05", now: "2026-05-03T00:00:00.000Z" });

  assert.equal(statement.coverage.daysMeasured, 0, "a day that has not happened cannot have been checked");
  assert.equal(statement.coverage.daysAheadOfClock, 3);
  assert.ok(!/every day/.test(statement.headline));
  assert.ok(statement.notes.some((note) => /clock on this machine/.test(note)), "a clock that disagrees must be said out loud");
});

test("the first and last sweep come from the times on the entries, not their order in the file", () => {
  const statement = monthlyStatement(
    [sweep("2026-05-20T09:00:00.000Z"), sweep("2026-05-02T09:00:00.000Z")],
    MAY,
  );

  assert.equal(statement.coverage.firstSweepAt, "2026-05-02T09:00:00.000Z");
  assert.equal(statement.coverage.lastSweepAt, "2026-05-20T09:00:00.000Z");
});

test("a month that has not started yet claims no missed days", () => {
  const statement = monthlyStatement([], { month: "2026-12", now: "2026-05-01T00:00:00.000Z" });

  assert.equal(statement.coverage.daysInWindow, 0);
  assert.equal(statement.coverage.daysWithNoSweep, 0, "days that have not happened are not gaps");
  assert.equal(statement.didNotRun, true);
});

test("entries from other months are never counted in this month", () => {
  const statement = monthlyStatement([
    sweep("2026-04-30T23:59:59.000Z", { exposure: 500, clean: false }),
    sweep("2026-05-01T00:00:01.000Z", { exposure: 10, clean: false }),
    sweep("2026-06-01T00:00:01.000Z", { exposure: 900, clean: false }),
    restore("2026-04-30T23:00:00.000Z", { account: "april" }),
  ], MAY);

  assert.equal(statement.sweeps, 1);
  assert.equal(statement.unpaidAccessExposure, 10);
  assert.equal(statement.accessRestored, 0);
  assert.equal(statement.actions.length, 0);
});

/* ------------------------------------------------------------- action lines */

test("the action line for a confirmed restore reads as the receipt it is", () => {
  const line = actionReceipt({
    kind: "restore",
    account: "8213",
    plan: "Pro",
    direction: "grant",
    stripeStatus: "active",
    stripeSince: "2026-08-02T00:00:00.000Z",
    result: "applied",
    verified: true,
    before: false,
    after: true,
    at: "2026-08-05T14:02:11.000Z",
    verifiedAt: "2026-08-05T14:02:44.000Z",
  });

  assert.equal(line, "Restored Pro for account 8213. Stripe said active since Aug 2, the app said no access. Fixed 14:02, confirmed 14:02 UTC.");
});

test("the action line never states a fact the entry does not contain", () => {
  const line = actionReceipt({
    kind: "restore",
    account: "8213",
    direction: "grant",
    result: "applied",
    verified: true,
    before: null,
    at: "2026-08-05T14:02:11.000Z",
  });

  assert.ok(!/Stripe said/.test(line), "an entry with no Stripe status must not claim one");
  assert.ok(!/Pro/.test(line), "an entry with no plan name must not invent one");
  assert.ok(!/the app said/.test(line), "an entry that did not record the before state must not describe it");
  assert.match(line, /Restored access for account 8213\./);
  assert.match(line, /read back to confirm/, "the re-read happened and the entry says so");
});

test("a confirmed change never prints a confirmation time the entry does not record", () => {
  /* restoreEntry writes no verifiedAt, so falling back to the change time
     would put an invented clock on almost every real line. That the account
     was read back is recorded; the moment it was read back is not. */
  const line = actionReceipt({
    kind: "restore", account: "8213", direction: "grant", result: "applied", verified: true,
    before: false, at: "2026-08-05T14:02:11.000Z",
  });

  assert.ok(!/confirmed 14:02/.test(line), "the entry holds no verification time, so no clock may be printed for it");
  assert.match(line, /Fixed 14:02 UTC/, "the time of the change itself is recorded and may be shown");
  assert.match(line, /read back to confirm it held/);
});

test("an unconfirmed change is never described as fixed", () => {
  const line = actionReceipt({
    kind: "restore", account: "8213", direction: "grant", result: "applied", verified: false,
    before: false, at: "2026-08-05T14:02:11.000Z",
  });

  assert.match(line, /^Tried to restore/);
  assert.ok(!/Fixed/.test(line));
  assert.match(line, /does not count as a restore/);
  assert.match(line, /Check this account yourself/, "every line a human reads says what happens next");
});

test("a failed change never claims that nothing changed", () => {
  const line = actionReceipt({
    kind: "restore", account: "8213", direction: "grant", result: "failed",
    reason: "the app's restore endpoint timed out", verified: false, at: "2026-08-05T14:02:11.000Z",
  });

  assert.ok(!/[Nn]othing changed/.test(line), "a call that timed out proves nothing about what the app now holds");
  assert.match(line, /not confirmed/);
  assert.match(line, /timed out/);
});

test("an action line reads as sentences whatever the entry happens to hold", () => {
  /* The first clause of the evidence depends on which fields exist, so it
     cannot be written assuming Stripe's status is always there. */
  const line = actionReceipt({
    kind: "restore", account: "9471", direction: "grant", result: "applied", verified: false,
    before: false, at: "2026-05-04T14:09:00.000Z",
  });

  assert.match(line, /\. The app said no access\./, "a clause that starts a sentence starts with a capital");
  assert.ok(!/\. the app/.test(line));
});

test("a statement with an unconfirmed change never claims every change was read back", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "held", verified: true }),
    restore("2026-05-04T09:02:00.000Z", { account: "unsure", verified: false }),
  ], MAY);

  assert.match(statement.headline, /restored access for 1 paying customer/);
  assert.ok(!/Each change below was read back/.test(statement.subheadline), "one unconfirmed change makes that sentence false");
  assert.match(statement.subheadline, /did not confirm/);
});

test("an account with no recorded id is said to have none, never guessed at", () => {
  const line = actionReceipt({ kind: "restore", direction: "grant", result: "applied", verified: true, at: "2026-08-05T14:02:11.000Z" });
  assert.match(line, /an account with no id recorded/);
});

test("an entry that is not an access change is not described as one", () => {
  assert.match(actionReceipt({ kind: "sweep", at: "2026-05-04T09:00:00.000Z" }), /not an access change/);
  assert.match(actionReceipt(null), /not an access change/);
});

/* --------------------------------------------------------------- the page */

test("account identifiers are escaped on the page; they are data, not markup", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    restore("2026-05-04T09:01:00.000Z", { account: "<script>alert(1)</script>" }),
  ], MAY);
  const html = renderStatementHtml(statement);

  assert.ok(!html.includes("<script>alert(1)</script>"), "an account id must never become a tag");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("the page carries the same shell as the Check report, not a new look", () => {
  const html = renderStatementHtml(monthlyStatement([sweep("2026-05-04T09:00:00.000Z")], MAY));

  for (const marker of ['class="wrap"', 'class="shell"', 'class="brand"', 'class="wordmark"', 'class="rows"', 'class="row',
    'class="nextBox"', 'class="nextLabel"', '--ink3:#878e9b', "prefers-color-scheme: dark"]) {
    assert.ok(html.includes(marker), `the statement must reuse the report's ${marker}`);
  }
  assert.match(html, /<title>Akeso Statement · May 2026<\/title>/);
  assert.match(html, /file on your computer/, "the local-only promise is part of the page");
});

test("the terminal and the page never disagree about what was measured", () => {
  /* Two renderings of one statement, and only one of them used to say "of
     those, everything matched: 0" for a month in which nothing was measured
     at all. Zero clean sweeps is a reading; no reading is not. */
  const statement = monthlyStatement(
    [failedSweep("2026-05-04T09:00:00.000Z"), failedSweep("2026-05-05T09:00:00.000Z")],
    MAY,
  );

  const text = renderStatementText(statement);
  assert.match(text, /everything matched\s+: not measured/);
  assert.ok(!/everything matched\s+: 0/.test(text));
  assert.match(renderStatementHtml(statement), /Of those, everything matched<\/span><span class="detail">not measured/);
});

test("the page and the terminal never use emoji or em-dashes", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z", { exposure: 12, clean: false }),
    failedSweep("2026-05-05T09:00:00.000Z"),
    /* One confirmed and one not, so both marks the page can draw are drawn. */
    restore("2026-05-04T09:01:00.000Z", { account: "a1", verified: true }),
    restore("2026-05-04T09:03:00.000Z", { account: "a2", verified: false }),
  ], MAY);

  for (const rendered of [renderStatementText(statement), renderStatementHtml(statement)]) {
    assert.ok(!/\p{Extended_Pictographic}/u.test(rendered), "no emoji anywhere a founder reads");
    assert.ok(!rendered.includes("—"), "no em-dashes");
    assert.ok(!rendered.includes("–"), "no en-dashes either");
  }
});

test("every rendering says what happens next, whatever the month held", () => {
  const months = [
    [],
    [failedSweep("2026-05-05T09:00:00.000Z")],
    [sweep("2026-05-04T09:00:00.000Z")],
    [sweep("2026-05-04T09:00:00.000Z"), restore("2026-05-04T09:01:00.000Z", { verified: false })],
  ];
  for (const entries of months) {
    const statement = monthlyStatement(entries, MAY);
    assert.ok(statement.whatHappensNext.length > 0, "a statement with no next step is a statement nobody can act on");
    assert.ok(statement.whatHappensNextWhy.length > 0);
    /* Checked by content, not by heading, so the page and the terminal can
       never end up telling a founder two different things to do. */
    assert.ok(renderStatementText(statement).includes(statement.whatHappensNext));
    assert.ok(renderStatementText(statement).includes(statement.whatHappensNextWhy));
    assert.ok(renderStatementHtml(statement).includes(statement.whatHappensNext));
    assert.ok(renderStatementHtml(statement).includes(statement.whatHappensNextWhy));
  }
});

test("the statement says tamper-evident and never tamper-proof", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", comparison: { monthlyExposure: 0, clean: true } });
  const ledger = await readLedger(root);
  const statement = monthlyStatement(ledger, { month: ledger[0].at.slice(0, 7) });

  const text = renderStatementText(statement);
  assert.match(text, /Tamper-evident/);
  assert.ok(!/tamper-proof/i.test(text));
  assert.ok(!/tamper-proof/i.test(renderStatementHtml(statement)));
});

/* --------------------------------------------------------------- history */

test("the chain is only called unbroken when the whole history was handed over", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", comparison: { monthlyExposure: 0, clean: true } });
  await appendEntry(root, restoreEntry({ account: "a", direction: "grant", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k" }));
  const ledger = await readLedger(root);
  const month = ledger[0].at.slice(0, 7);

  const whole = monthlyStatement(ledger, { month });
  assert.equal(whole.history.checked, true);
  assert.equal(whole.history.intact, true);
  assert.equal(whole.accessRestored, 1);

  const part = monthlyStatement(ledger.slice(1), { month });
  assert.equal(part.history.checked, false, "a slice of history cannot prove itself");
  assert.match(part.history.reason, /part of the history/);
  assert.match(renderStatementText(part), /Not checked/);
});

test("a rewritten entry makes the statement say its own numbers are unproven", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", comparison: { monthlyExposure: 10, clean: false } });
  await appendEntry(root, restoreEntry({ account: "a", direction: "grant", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k" }));
  const ledger = await readLedger(root);
  ledger[1].account = "someone-else";

  const statement = monthlyStatement(ledger, { month: ledger[0].at.slice(0, 7) });
  assert.equal(statement.history.checked, true);
  assert.equal(statement.history.intact, false);
  assert.match(renderStatementText(statement), /Broken at entry/);
  assert.match(renderStatementText(statement), /unproven/);
});

test("entries that carry no chain are reported as not checked, never as broken", () => {
  /* A false tamper alarm would be worse than no answer at all: it tells the
     founder their own records were edited when nothing of the kind happened. */
  const statement = monthlyStatement([sweep("2026-05-04T09:00:00.000Z")], MAY);

  assert.equal(statement.history.checked, false);
  assert.equal(statement.history.intact, undefined);
  assert.match(statement.history.reason, /do not carry the ledger's chain/);
  assert.ok(!/Broken/.test(renderStatementText(statement)));
});

test("a ledger line that is not a record at all is reported, never thrown", () => {
  /* A line holding a bare null parses fine and is not a record. Reading .kind
     off it used to end the whole statement with a TypeError, which hides the
     month behind a stack trace. */
  const statement = monthlyStatement([null, sweep("2026-05-04T09:00:00.000Z")], MAY);

  assert.equal(statement.history.checked, false);
  assert.match(statement.history.reason, /not a record/);
  assert.equal(statement.sweeps, 1, "the readable entries are still counted");
  assert.ok(statement.notes.some((note) => /no timestamp/.test(note)));
});

test("an empty history is reported as nothing to check, never as intact", () => {
  const statement = monthlyStatement([], MAY);
  assert.equal(statement.history.checked, false);
  assert.match(statement.history.reason, /no history to check/);
});

test("entries that could not be read are declared, not silently dropped", () => {
  const statement = monthlyStatement([
    sweep("2026-05-04T09:00:00.000Z"),
    { kind: "unreadable", raw: "{broken" },
    { kind: "sweep", comparison: { monthlyExposure: 0, clean: true } },
  ], MAY);

  assert.ok(statement.notes.some((note) => /could not be read/.test(note)));
  assert.ok(statement.notes.some((note) => /no timestamp/.test(note)), "an entry with no date is not quietly counted");
  assert.equal(statement.sweeps, 1, "only entries that can be placed in the month are counted");
});

/* ------------------------------------------------------------- arguments */

test("a month string that is not a month is refused, never reported as a quiet month", () => {
  assert.throws(() => monthlyStatement([], { month: "August" }), /month must look like/);
  assert.throws(() => monthlyStatement([], { month: "2026-13" }), /month must look like/);
  assert.throws(() => monthlyStatement([], { month: "2026-05-04" }), /month must look like/);
  assert.throws(() => monthlyStatement([], { now: "not a date" }), /real date/);
});

test("a month with changes but no sweep says both, and is still not a clean month", () => {
  /* An approved removal writes a restore with no sweep beside it. The page
     used to say "Akeso did not run" over a list of changes it had made. */
  const statement = monthlyStatement([restore("2026-05-04T09:01:00.000Z", { account: "approved" })], MAY);

  assert.equal(statement.didNotRun, true);
  assert.equal(statement.accessRestored, 1);
  assert.match(statement.headline, /did not run/);
  assert.match(statement.subheadline, /happened without one/, "the changes must not be contradicted by the headline");
  assert.ok(statement.notes.some((note) => /even though no sweep ran/.test(note)));
  assert.equal(statement.unpaidAccessExposure, null, "changes are not a measurement of the month");
});

test("the month defaults to the month now is in", () => {
  const statement = monthlyStatement([sweep("2026-05-04T09:00:00.000Z")], { now: "2026-05-20T00:00:00.000Z" });
  assert.equal(statement.month, "2026-05");
  assert.equal(statement.monthLabel, "May 2026");
  assert.equal(statement.sweeps, 1);
});
