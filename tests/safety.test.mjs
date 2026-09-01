import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KILL_SWITCH_FILE,
  canaryGate,
  clearSuspension,
  detectFlapping,
  guardWrite,
  haltNow,
  isHalted,
  killSwitchPath,
  resumeHalt,
  suspendAccount,
  suspendedAccounts,
  writeBudget,
} from "../src/safety.mjs";
import { appendEntry, ledgerPath, readLedger } from "../src/ledger.mjs";

/* These are the brakes. Every test here is one way a bug in the rest of Akeso
   turns into a customer's paying users all losing access at once. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-safety-"));

/* The kill switch lives inside .akeso, which does not exist yet in a project
   that has never been checked. */
const makeAkesoDir = (root) => mkdir(path.dirname(killSwitchPath(root)), { recursive: true });

const restore = (account, direction, at, result = "applied") =>
  ({ kind: "restore", account, direction, result, at: new Date(at).toISOString() });

/* A removal that reached the queue. Everything Akeso is allowed to take away
   starts here, and nothing may be taken away that did not. */
const queuedRemoval = (account, id, at = new Date().toISOString()) =>
  ({ kind: "approval", id, state: "queued", account, queuedAt: at, readyAt: at, at });

/* The two ledger lines a person leaves behind when they approve one removal. */
const approvedRemoval = (account, id, at = new Date().toISOString()) => ([
  queuedRemoval(account, id, at),
  { kind: "approval", id, state: "approved", by: "jace", decidedAt: at, at },
]);

/* Doctrine: every message a human reads is a plain sentence that says what
   happens next. No em-dashes, no emoji, no jargon. */
function assertFounderReadable(sentence, label) {
  assert.equal(typeof sentence, "string", `${label} must be a sentence`);
  assert.ok(sentence.length > 40, `${label} must explain itself: "${sentence}"`);
  assert.match(sentence, /\.$/, `${label} must be a finished sentence: "${sentence}"`);
  assert.doesNotMatch(sentence, /[—–]/u, `${label} must use plain punctuation: "${sentence}"`);
  assert.doesNotMatch(sentence, /\p{Extended_Pictographic}/u, `${label} must have no emoji: "${sentence}"`);
}

/* ------------------------------------------------------------ kill switch */

test("a halted system refuses to give access back, not only to take it away", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Akeso was granting access to accounts that never paid.", by: "jace" });

  const grant = await guardWrite(root, { account: "a", direction: "grant" });
  const removal = await guardWrite(root, { account: "a", direction: "remove" });

  assert.equal(grant.allowed, false, "a kill switch that still grants is not a kill switch");
  assert.equal(removal.allowed, false);
  assert.match(grant.reasons[0], /including giving access back/);
});

test("the kill switch file alone halts, with nothing in the ledger at all", async () => {
  const root = await scratch();
  await makeAkesoDir(root);
  await writeFile(killSwitchPath(root), "Stopped by hand during the outage.\n");

  const halt = await isHalted(root);
  assert.equal(halt.halted, true, "a file placed by hand must stop a system whose history says nothing");
  assert.equal(halt.reason, "Stopped by hand during the outage.");
  assert.ok(halt.since, "the halt says when it started");
  assert.equal((await readLedger(root)).length, 0);
});

test("an empty kill switch file still halts, and says no reason was recorded", async () => {
  const root = await scratch();
  await makeAkesoDir(root);
  await writeFile(killSwitchPath(root), "");

  const halt = await isHalted(root);
  assert.equal(halt.halted, true);
  assert.match(halt.reason, /no reason was recorded/, "we never invent the reason somebody stopped it");
});

test("a halt recorded in the ledger still holds after the file is deleted by hand", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Removals looked wrong.", by: "jace" });
  await rm(killSwitchPath(root));

  const halt = await isHalted(root);
  assert.equal(halt.halted, true, "deleting the file is not the same as deciding to resume");
  assert.equal(halt.source, "ledger");
  assert.equal(halt.reason, "Removals looked wrong.");
});

test("halting writes both the brake and the receipt", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Testing the brake.", by: "jace" });

  assert.equal((await readFile(killSwitchPath(root), "utf8")).trim(), "Testing the brake.");
  const entry = (await readLedger(root)).at(-1);
  assert.equal(entry.kind, "halt");
  assert.equal(entry.state, "on");
  assert.equal(entry.by, "jace");
  assert.equal(KILL_SWITCH_FILE, ".akeso/HALT");
});

test("resuming clears both signals, and resuming twice does not throw", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Stopping.", by: "jace" });
  await resumeHalt(root, { by: "jace" });

  assert.equal((await isHalted(root)).halted, false);
  await resumeHalt(root, { by: "jace" }); /* the file is already gone */
  assert.equal((await isHalted(root)).halted, false);

  const halts = (await readLedger(root)).filter((entry) => entry.kind === "halt");
  assert.equal(halts.length, 3, "every halt and every resume is a receipt with a name on it");
  assert.equal(halts.at(-1).state, "off");
});

test("a kill switch file put back after a resume halts again", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "First stop.", by: "jace" });
  await resumeHalt(root, { by: "jace" });
  await writeFile(killSwitchPath(root), "Second stop, and the ledger says running.\n");

  const halt = await isHalted(root);
  assert.equal(halt.halted, true, "the two brakes are independent on purpose");
  assert.equal(halt.source, "file");
});

test("a system with nothing wrong with it allows the write", async () => {
  const root = await scratch();
  const grant = await guardWrite(root, { account: "a", direction: "grant", entries: [] });
  const removal = await guardWrite(root, {
    account: "a",
    direction: "remove",
    approvalId: "r-1",
    entries: approvedRemoval("a", "r-1"),
  });

  /* The positive control. Without this, every test above would still pass if
     guardWrite simply refused everything forever. */
  assert.deepEqual(grant, { allowed: true, reasons: [] });
  assert.deepEqual(removal, { allowed: true, reasons: [] }, "a removal a person approved must still be able to happen");
});

/* ------------------------------------------------- a human behind removals */

test("a removal nobody ever queued is refused, however it was asked for", async () => {
  const root = await scratch();
  const verdict = await guardWrite(root, { account: "a", direction: "remove", entries: [] });

  assert.equal(verdict.allowed, false, "taking paid access away is the one thing that always needs a person");
  assert.match(verdict.reasons[0], /no removal in the queue for that account/);
});

test("a removal in the queue for one account is not permission to touch another", async () => {
  const root = await scratch();
  /* This is how the approvals command calls the gate: it hands over the ledger
     the queued removal lives in and names the account, not the id, because it
     calls the gate before it writes down the approval. */
  const allowed = await guardWrite(root, { account: "a", direction: "remove", entries: [queuedRemoval("a", "r-1")] });
  assert.deepEqual(allowed, { allowed: true, reasons: [] }, "the approved-removal path has to keep working");

  const other = await guardWrite(root, { account: "b", direction: "remove", entries: [queuedRemoval("a", "r-1")] });
  assert.equal(other.allowed, false, "a queued removal for one account is not one for the account next to it");
});

test("a removal that nobody answered until it expired is not run later", async () => {
  const root = await scratch();
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const entries = [queuedRemoval("a", "r-1", old)];

  const verdict = await guardWrite(root, { account: "a", direction: "remove", entries });
  assert.equal(verdict.allowed, false, "a week-old question is not a yes");
  assert.match(verdict.reasons[0], /expired/);
});

test("a cancelled approval never becomes permission later", async () => {
  const root = await scratch();
  const at = new Date().toISOString();
  const entries = [
    { kind: "approval", id: "r-1", state: "queued", account: "a", queuedAt: at, readyAt: at, at },
    { kind: "approval", id: "r-1", state: "cancelled", by: "jace", decidedAt: at, at },
  ];

  const verdict = await guardWrite(root, { account: "a", direction: "remove", approvalId: "r-1", entries });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons[0], /cancellation is final/);
});

test("an approval given for one account does not take access from another", async () => {
  const root = await scratch();
  const verdict = await guardWrite(root, {
    account: "b",
    direction: "remove",
    approvalId: "r-1",
    entries: approvedRemoval("a", "r-1"),
  });

  assert.equal(verdict.allowed, false, "one approval covers one account");
  assert.match(verdict.reasons[0], /queued for account a, not for b/);
});

test("an approval id Akeso has never seen is not an approval", async () => {
  const root = await scratch();
  const verdict = await guardWrite(root, { account: "a", direction: "remove", approvalId: "made-up", entries: [] });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons[0], /under an approval it has no record of/);
});

/* -------------------------------------------------------------- flapping */

test("three grants in a row is Akeso retrying, not a fight with something else", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 3 * 3600000),
    restore("a", "grant", now - 2 * 3600000),
    restore("a", "grant", now - 3600000),
  ];
  assert.deepEqual(detectFlapping(entries, { now }), []);
});

test("one reversal is a customer who resubscribed, not a flap", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 3 * 3600000),
    restore("a", "grant", now - 2 * 3600000),
    restore("a", "remove", now - 3600000),
  ];
  assert.deepEqual(detectFlapping(entries, { now }), [], "it takes a there-and-back to prove a fight");
});

test("access flipped there and back is reported as flapping", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 5 * 3600000),
    restore("a", "remove", now - 4 * 3600000),
    restore("a", "grant", now - 3600000),
  ];
  const [flap] = detectFlapping(entries, { now });

  assert.equal(flap.account, "a");
  assert.equal(flap.flips, 3);
  assert.equal(flap.directionChanges, 2);
  assert.equal(flap.firstAt, new Date(now - 5 * 3600000).toISOString());
  assert.equal(flap.lastAt, new Date(now - 3600000).toISOString());
});

test("flapping counts only writes that actually landed", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 5 * 3600000),
    restore("a", "remove", now - 4 * 3600000, "failed"),
    restore("a", "grant", now - 3600000, "conflict"),
  ];
  assert.deepEqual(detectFlapping(entries, { now }), [], "an attempt that changed nothing is not a flip");
});

test("a raised threshold holds even when the reversals are there", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 5 * 3600000),
    restore("a", "remove", now - 4 * 3600000),
    restore("a", "grant", now - 3600000),
  ];
  /* At the defaults, three writes with two reversals is the smallest possible
     flap, so the count and the reversals move together. This pins the count on
     its own: a founder who raises the bar to four gets a bar of four. */
  assert.deepEqual(detectFlapping(entries, { now, threshold: 4 }), []);
  assert.equal(detectFlapping(entries, { now, threshold: 3 }).length, 1, "the threshold is the only difference");
});

test("flapping that stopped yesterday is not flapping today", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 40 * 3600000),
    restore("a", "remove", now - 39 * 3600000),
    restore("a", "grant", now - 38 * 3600000),
  ];
  assert.deepEqual(detectFlapping(entries, { now }), []);
  assert.equal(detectFlapping(entries, { now, windowHours: 48 }).length, 1, "the window is the only difference");
});

test("an entry with no readable time is never counted as proof of flapping", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 3 * 3600000),
    { kind: "restore", account: "a", direction: "remove", result: "applied" },
    restore("a", "grant", now - 3600000),
  ];
  assert.deepEqual(detectFlapping(entries, { now }), [], "a fight we cannot place in time is not one we accuse anyone of");
});

test("flapping is per account, and one noisy account does not implicate a quiet one", () => {
  const now = Date.now();
  const entries = [
    restore("noisy", "grant", now - 5 * 3600000),
    restore("noisy", "remove", now - 4 * 3600000),
    restore("noisy", "grant", now - 3600000),
    restore("quiet", "grant", now - 2 * 3600000),
  ];
  const flapping = detectFlapping(entries, { now });
  assert.equal(flapping.length, 1);
  assert.equal(flapping[0].account, "noisy");
});

test("a flapping account is refused further automatic changes in both directions", async () => {
  const root = await scratch();
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 5 * 3600000),
    restore("a", "remove", now - 4 * 3600000),
    restore("a", "grant", now - 3600000),
  ];

  const grant = await guardWrite(root, { account: "a", direction: "grant", entries, now });
  const removal = await guardWrite(root, { account: "a", direction: "remove", entries, now });
  const other = await guardWrite(root, { account: "b", direction: "grant", entries, now });

  assert.equal(grant.allowed, false);
  assert.equal(removal.allowed, false);
  assert.match(grant.reasons[0], /will not join that fight/);
  assert.equal(other.allowed, true, "one account in a fight does not freeze every other account");
});

/* ------------------------------------------------------------ suspension */

test("a suspension holds until a person clears it, and the clearance is named", async () => {
  const root = await scratch();
  await suspendAccount(root, { account: "a", reason: "Access flipped four times in an hour." });

  let held = suspendedAccounts(await readLedger(root));
  assert.equal(held.length, 1);
  assert.equal(held[0].account, "a");
  assert.match(held[0].reason, /flipped four times/);

  const blocked = await guardWrite(root, { account: "a", direction: "grant" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons[0], /on hold/);

  await clearSuspension(root, { account: "a", by: "jace" });
  held = suspendedAccounts(await readLedger(root));
  assert.deepEqual(held, [], "a person clearing it is the only thing that lifts a hold");
  assert.equal((await guardWrite(root, { account: "a", direction: "grant" })).allowed, true);
});

test("a suspension is never lifted by time passing", async () => {
  const entries = [{ kind: "suspend", state: "on", account: "a", reason: "Held.", at: new Date(Date.now() - 90 * 86400000).toISOString() }];
  const held = suspendedAccounts(entries);
  assert.equal(held.length, 1, "ninety days of silence is not a decision to resume");
  assert.ok(held[0].heldHours > 2000);
});

test("a suspension with no readable time reports no duration rather than a made-up one", () => {
  const held = suspendedAccounts([{ kind: "suspend", state: "on", account: "a", reason: "Held." }]);
  assert.equal(held[0].heldHours, null, "never invent a number Akeso cannot measure");
});

test("an unrecognised suspend state is not a clearance, and does not overwrite the hold either", () => {
  const since = new Date(Date.now() - 3 * 3600000).toISOString();
  const entries = [
    { kind: "suspend", state: "on", account: "a", reason: "Access flipped four times in an hour.", by: "akeso", at: since },
    { kind: "suspend", state: "cleared", account: "a", at: new Date().toISOString() },
  ];
  const held = suspendedAccounts(entries);

  assert.equal(held.length, 1, "a typo in a state field must never release an account");
  /* A state from a version of this file we do not know about is ignored, never
     read as a decision. Letting it stand in as a fresh hold would replace the
     reason a person wrote with a placeholder, and the reason is the whole point
     of the record. */
  assert.equal(held[0].reason, "Access flipped four times in an hour.");
  assert.equal(held[0].since, since);
  assert.equal(held[0].by, "akeso");
});

test("re-suspending after a clearance holds the account again", () => {
  const at = new Date().toISOString();
  const entries = [
    { kind: "suspend", state: "on", account: "a", reason: "First.", at },
    { kind: "suspend", state: "off", account: "a", by: "jace", at },
    { kind: "suspend", state: "on", account: "a", reason: "Happened again.", at },
  ];
  const held = suspendedAccounts(entries);
  assert.equal(held.length, 1);
  assert.match(held[0].reason, /Happened again/);
});

/* ---------------------------------------------------------- canary gate */

test("a release with no canary result at all is refused", () => {
  assert.equal(canaryGate({ releaseId: "1.4.0" }).allowed, false);
  assert.equal(canaryGate({ releaseId: "1.4.0", canaryResults: [] }).allowed, false);
  assert.equal(canaryGate({ releaseId: "1.4.0", canaryResults: null }).allowed, false);
  assert.match(canaryGate({ releaseId: "1.4.0", canaryResults: [] }).reason, /missing canary is not a pass/);
});

test("a release that does not say which release it is cannot be cleared", () => {
  const gate = canaryGate({ canaryResults: [{ releaseId: "1.4.0", result: "clean" }] });
  assert.equal(gate.allowed, false, "we cannot prove a release was tried if we do not know which one it is");
  assert.match(gate.reason, /did not say which version/, "refusing for the right reason, not by accident");

  /* Two unnamed things are not the same thing. Without the check above, an
     unnamed run and an unnamed canary result match each other and open the
     gate on a pair of blanks. */
  const blanks = canaryGate({ canaryResults: [{ clean: true }] });
  assert.equal(blanks.allowed, false);
});

test("another release passing its canary does not clear this one", () => {
  const gate = canaryGate({ releaseId: "1.5.0", canaryResults: [{ releaseId: "1.4.0", result: "clean" }] });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /does not clear this one/);
});

test("a canary that did not come back clean refuses the release", () => {
  const gate = canaryGate({
    releaseId: "1.4.0",
    canaryResults: [{ releaseId: "1.4.0", result: "clean" }, { releaseId: "1.4.0", result: "failed" }],
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /did not come back clean/);
});

test("a canary result that says nothing either way is not a pass", () => {
  const gate = canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0" }] });
  assert.equal(gate.allowed, false, "absence of evidence is never permission");
});

test("a clean canary on this release opens the gate", () => {
  const gate = canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }] });
  assert.equal(gate.allowed, true, "the gate must be able to open, or nothing else here is a real test");
  assert.match(gate.reason, /ran cleanly/);
});

test("a canary result that contradicts itself is not a pass", () => {
  const gate = canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: false, result: "clean" }] });
  assert.equal(gate.allowed, false, "a report that says both things cannot be read for the half that opens the gate");
});

test("a required number of canaries that is not a number refuses rather than opens", () => {
  for (const minimumClean of [Number.NaN, 0, -1, "two", null]) {
    const gate = canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }], minimumClean });
    assert.equal(gate.allowed, false, `a minimum of ${String(minimumClean)} is not a bar anything can clear`);
  }
});

test("one clean canary does not satisfy a requirement for two", () => {
  const gate = canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }], minimumClean: 2 });
  assert.equal(gate.allowed, false);
});

/* ---------------------------------------------------------- write budget */

test("the write budget counts every attempt, because a failed write may still have landed", () => {
  const now = Date.now();
  const entries = [
    restore("a", "grant", now - 60000),
    restore("b", "grant", now - 60000, "failed"),
    restore("c", "remove", now - 60000, "conflict"),
  ];
  const budget = writeBudget(entries, { now });
  assert.equal(budget.used.hour, 3);
  assert.equal(budget.used.day, 3);
  assert.equal(budget.exhausted, false);
  assert.equal(budget.reason, null, "a budget with room left has nothing to say");
});

test("the hourly ceiling stops writing and says so in plain English", () => {
  const now = Date.now();
  const entries = Array.from({ length: 20 }, (_, i) => restore(`a${i}`, "grant", now - (i + 1) * 60000));
  const budget = writeBudget(entries, { now });

  assert.equal(budget.used.hour, 20);
  assert.equal(budget.remaining.hour, 0);
  assert.equal(budget.exhausted, true);
  assert.match(budget.reason, /in the last hour/);
});

test("the daily ceiling catches what the hourly ceiling never sees", () => {
  const now = Date.now();
  const entries = Array.from({ length: 100 }, (_, i) => restore(`a${i}`, "grant", now - (i + 1) * 800000));
  const budget = writeBudget(entries, { now });

  assert.ok(budget.used.hour < 20, "spread out enough that no single hour is over the limit");
  assert.equal(budget.used.day, 100);
  assert.equal(budget.exhausted, true);
  assert.match(budget.reason, /in the last day/);
});

test("a restore with no readable time counts against the budget rather than buying a free write", () => {
  const budget = writeBudget([{ kind: "restore", account: "a", direction: "grant", result: "applied" }], { now: Date.now() });
  assert.equal(budget.used.hour, 1, "one corrupt line must never buy an unlimited number of writes");
  assert.equal(budget.undated, 1, "how much of the count was assumed is kept separate from the count");
});

test("a budget stopped by entries it could not date says that, instead of claiming it measured them", () => {
  const undatable = Array.from({ length: 3 }, () => ({ kind: "restore", account: "a", direction: "grant", result: "applied" }));
  const budget = writeBudget(undatable, { now: Date.now(), perHour: 3 });

  assert.equal(budget.exhausted, true);
  assert.match(budget.reason, /could not read a time on 3 of those entries/, "never report as measured what was assumed");
});

test("a restore stamped in the future does not hand out a fresh budget", () => {
  const now = Date.now();
  const budget = writeBudget([restore("a", "grant", now + 5 * 86400000)], { now });
  assert.equal(budget.used.hour, 1, "a skewed clock is not a licence to write");
});

test("what is left of the budget is never a negative number", () => {
  const now = Date.now();
  const entries = Array.from({ length: 30 }, (_, i) => restore(`a${i}`, "grant", now - 60000));
  const budget = writeBudget(entries, { now, perHour: 5, perDay: 10 });
  assert.deepEqual(budget.remaining, { hour: 0, day: 0 });
});

test("an exhausted budget refuses grants too, not only removals", async () => {
  const root = await scratch();
  const now = Date.now();
  const entries = [restore("x", "grant", now - 60000), restore("y", "grant", now - 120000)];
  const limits = { perHour: 2, perDay: 2 };

  const grant = await guardWrite(root, { account: "a", direction: "grant", entries, now, limits });
  assert.equal(grant.allowed, false);
  assert.match(grant.reasons[0], /stopped writing/);
});

/* ------------------------------------------------------------- the gate */

test("a history with lines Akeso cannot read refuses the write instead of throwing", async () => {
  const root = await scratch();
  const entries = [null, 5, "not an entry", { kind: "unreadable", raw: "{oops" }];

  const verdict = await guardWrite(root, { account: "a", direction: "grant", entries });
  assert.equal(verdict.allowed, false, "a line we cannot read could be the hold that should have stopped this");
  assert.match(verdict.reasons[0], /cannot read/);
});

test("an empty history is not a reason to refuse, or Akeso could never make its first write", async () => {
  const root = await scratch();
  assert.equal((await guardWrite(root, { account: "a", direction: "grant" })).allowed, true);
});

test("a write with no account named is refused, never guessed at", async () => {
  const root = await scratch();
  const verdict = await guardWrite(root, { direction: "grant", entries: [] });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons[0], /without being told whose access/);
});

test("a change Akeso does not recognise is refused rather than attempted", async () => {
  const root = await scratch();
  const verdict = await guardWrite(root, { account: "a", direction: "downgrade", entries: [] });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons[0], /only changes it makes/);
});

test("the gate reports every reason at once, not the first one it found", async () => {
  const root = await scratch();
  const now = Date.now();
  await haltNow(root, { reason: "Everything looked wrong.", by: "jace" });
  await suspendAccount(root, { account: "a", reason: "Access flipped repeatedly." });

  const entries = [
    ...(await readLedger(root)),
    restore("x", "grant", now - 60000),
    restore("y", "grant", now - 120000),
  ];
  const verdict = await guardWrite(root, { account: "a", direction: "grant", entries, now, limits: { perHour: 2, perDay: 2 } });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reasons.length, 3, "a founder who fixes one refusal and hits the next has been told half the truth twice");
});

test("the gate refuses everything malformed, and never throws doing it", async () => {
  const verdicts = await Promise.all([
    guardWrite("/akeso/no/such/directory/at/all", { account: "a", direction: "grant" }),
    guardWrite(undefined, { account: "a", direction: "grant", entries: [] }),
    guardWrite(await scratch(), {}),
    guardWrite(await scratch(), { account: "a", direction: "grant", entries: "not an array" }),
    guardWrite(await scratch(), { account: "a", direction: "grant", now: Number.NaN }),
    guardWrite(await scratch(), { account: "a", direction: "grant", now: "yesterday" }),
  ]);

  for (const verdict of verdicts) {
    assert.ok(Array.isArray(verdict.reasons));
    /* Shape alone would let this test pass against a gate that allowed all six.
       Every one of these is Akeso failing, and our own failure is never a
       licence to write. */
    assert.equal(verdict.allowed, false, `this should have been refused: ${verdict.reasons.join(" ")}`);
    assert.ok(verdict.reasons.length > 0, "a refusal always says why");
  }
});

/* --------------------------------------------- checks we could not make */

test("a clock Akeso cannot read is not an empty write budget", () => {
  const now = Date.now();
  const entries = Array.from({ length: 50 }, (_, i) => restore(`a${i}`, "grant", now - 60000));
  const budget = writeBudget(entries, { now: Number.NaN });

  assert.deepEqual(budget.used, { hour: null, day: null }, "unmeasured is reported as unmeasured, never as zero");
  assert.deepEqual(budget.remaining, { hour: null, day: null });
  assert.equal(budget.exhausted, true, "a broken clock must never hand out a fresh budget");
  assert.match(budget.reason, /could not read the clock/);
});

test("a broken clock refuses the write instead of allowing it", async () => {
  const root = await scratch();
  for (const now of [Number.NaN, "yesterday", null, Infinity]) {
    const verdict = await guardWrite(root, { account: "a", direction: "grant", entries: [], now });
    assert.equal(verdict.allowed, false, `a "${String(now)}" clock must not authorise a write`);
  }
});

test("a suspension held against an unreadable clock reports no duration, not a NaN", () => {
  const held = suspendedAccounts([{ kind: "suspend", state: "on", account: "a", reason: "Held.", at: new Date().toISOString() }], { now: Number.NaN });
  assert.equal(held.length, 1, "the hold itself does not depend on the clock");
  assert.equal(held[0].heldHours, null, "never invent a number Akeso cannot measure, and never leak a NaN as one");
});

test("a kill switch Akeso can see but cannot read counts as stopped", async () => {
  const root = await scratch();
  /* The file exists as a directory: readable path, unreadable contents. This is
     the shape of every permissions and corruption failure on that file. */
  await mkdir(killSwitchPath(root), { recursive: true });

  const halt = await isHalted(root);
  assert.equal(halt.halted, true, "a brake we cannot read is not a brake we may ignore");
  assert.equal(halt.source, "unreadable_file");

  const verdict = await guardWrite(root, { account: "a", direction: "grant", entries: [] });
  assert.equal(verdict.allowed, false);
});

test("a history file Akeso cannot open is not a history that says nothing", async (t) => {
  const root = await scratch();
  await haltNow(root, { reason: "Stopped while we work out what happened.", by: "jace" });
  await rm(killSwitchPath(root));            /* the file brake is gone, the recorded halt is not */
  await chmod(ledgerPath(root), 0o000);

  const staged = await readFile(ledgerPath(root), "utf8").then(() => false, () => true);
  /* Never claim a pass we did not measure: a user who can read any file cannot
     stage this failure, so the test says so instead of passing. */
  if (!staged) return t.skip("this user can read a file with no permissions, so the fault cannot be staged");

  const halt = await isHalted(root);
  assert.equal(halt.halted, true, "an unreadable history hides the halt inside it");
  assert.equal(halt.source, "unreadable_ledger");

  const verdict = await guardWrite(root, { account: "a", direction: "grant" });
  assert.equal(verdict.allowed, false, "reading nothing is not the same as there being nothing");
  await chmod(ledgerPath(root), 0o600);
});

test("a halt written into the history the caller handed us still stops the write", async () => {
  const root = await scratch();
  const entries = [{ kind: "halt", state: "on", reason: "Stopped by hand.", at: new Date().toISOString() }];

  const verdict = await guardWrite(root, { account: "a", direction: "grant", entries });
  assert.equal(verdict.allowed, false, "the history a write is judged against is the one that must stop it");
  assert.match(verdict.reasons[0], /including giving access back/);
});

test("a project folder that is not there refuses the write rather than reading an empty history", async () => {
  const verdict = await guardWrite("/akeso/no/such/directory/at/all", { account: "a", direction: "grant" });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reasons[0], /could not find the project folder/);
});

test("a history that is not a history is refused, never quietly swapped for the file on disk", async () => {
  const root = await scratch();
  await suspendAccount(root, { account: "a", reason: "Held." });

  for (const entries of ["not an array", { kind: "halt" }, 7]) {
    const verdict = await guardWrite(root, { account: "a", direction: "grant", entries });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reasons[0], /not a list of history entries/);
  }
});

test("detectFlapping says so rather than reporting no flapping it never measured", () => {
  assert.throws(() => detectFlapping([], { now: Number.NaN }), /readable `now`/);
});

/* ------------------------------------------------ confirming the brakes */

test("halting is only reported as done after the state is read back", async () => {
  const root = await scratch();
  const result = await haltNow(root, { reason: "Removals looked wrong.", by: "jace" });

  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true, "success is claimed only after a re-read");
  assert.equal(result.halted, true);
  assert.equal(result.entry.kind, "halt");
  assertFounderReadable(result.message, "the halt message");
});

test("a resume that cannot clear the brake says so instead of reporting success", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Stopping.", by: "jace" });
  await rm(killSwitchPath(root));
  /* A kill switch that cannot be removed: the brake is still on afterwards, and
     the only wrong answer here is "running again". */
  await mkdir(killSwitchPath(root), { recursive: true });

  const result = await resumeHalt(root, { by: "jace" });
  assert.equal(result.ok, false, "a resume that did not take is not a resume");
  assert.equal(result.halted, true);
  assert.equal((await isHalted(root)).halted, true);
  assertFounderReadable(result.message, "the failed resume message");
});

test("a halt that could not be written down anywhere is never reported as stopped", async () => {
  const root = await scratch();
  /* .akeso is a file, so neither the kill switch nor the ledger can be written.
     Akeso reads as stopped in this state only because its own folder is broken,
     and that stop disappears the moment somebody fixes the folder. */
  await writeFile(path.join(root, ".akeso"), "this is a file, not a folder\n");

  const result = await haltNow(root, { reason: "Stop everything now.", by: "jace" });

  assert.equal(result.ok, false, "a stop nobody could write down is not a stop");
  assert.equal(result.confirmed, false);
  assert.ok(result.couldNotWriteFile, "it says which brake failed");
  assert.ok(result.couldNotRecord);
  assert.match(result.message, /could not write the stop down anywhere/);
  /* The founder runs this while something is going wrong. A stack trace tells
     them nothing about whether Akeso stopped. */
  assertFounderReadable(result.message, "the failed halt message");
});

test("a resume that could not be written down is not a resume either", async () => {
  const root = await scratch();
  await writeFile(path.join(root, ".akeso"), "this is a file, not a folder\n");

  const result = await resumeHalt(root, { by: "jace" });
  assert.equal(result.ok, false);
  assert.ok(result.couldNotRecord);
  assertFounderReadable(result.message, "the failed resume message");
});

test("a resume that worked says what happens next", async () => {
  const root = await scratch();
  await haltNow(root, { reason: "Stopping.", by: "jace" });
  const result = await resumeHalt(root, { by: "jace" });

  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assertFounderReadable(result.message, "the resume message");
});

test("every refusal is a sentence a founder can act on", async () => {
  const root = await scratch();
  const now = Date.now();
  await haltNow(root, { reason: "Stopped while we work out what happened.", by: "jace" });
  await suspendAccount(root, { account: "a", reason: "Access flipped repeatedly." });

  const entries = [
    ...(await readLedger(root)),
    restore("x", "grant", now - 60000),
    restore("y", "grant", now - 120000),
  ];

  const sentences = [
    ...(await guardWrite(root, { account: "a", direction: "grant", entries, now, limits: { perHour: 2, perDay: 2 } })).reasons,
    ...(await guardWrite(root, { direction: "sideways", entries: [null] })).reasons,
    ...(await guardWrite(await scratch(), { account: "b", direction: "remove", entries: [] })).reasons,
    ...(await guardWrite(await scratch(), { account: "b", direction: "remove", approvalId: "r-1", entries: approvedRemoval("c", "r-1") })).reasons,
    ...(await guardWrite(await scratch(), { account: "b", direction: "grant", entries: [], now: Number.NaN })).reasons,
    ...(await guardWrite(await scratch(), { account: "b", direction: "grant", entries: "not an array" })).reasons,
    ...(await guardWrite("/akeso/no/such/directory/at/all", { account: "b", direction: "grant" })).reasons,
    canaryGate({ releaseId: "1.4.0", canaryResults: [] }).reason,
    canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }], minimumClean: Number.NaN }).reason,
    canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", result: "failed" }] }).reason,
    canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }] }).reason,
    writeBudget([restore("x", "grant", now)], { now, perHour: 1 }).reason,
  ];

  assert.ok(sentences.length >= 8);
  for (const sentence of sentences) assertFounderReadable(sentence, "a refusal reason");
});
