import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { appendEntry, readLedger } from "../src/ledger.mjs";

/* These are the brakes. Every test here is one way a bug in the rest of Akeso
   turns into a customer's paying users all losing access at once. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-safety-"));

/* The kill switch lives inside .akeso, which does not exist yet in a project
   that has never been checked. */
const makeAkesoDir = (root) => mkdir(path.dirname(killSwitchPath(root)), { recursive: true });

const restore = (account, direction, at, result = "applied") =>
  ({ kind: "restore", account, direction, result, at: new Date(at).toISOString() });

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
  const removal = await guardWrite(root, { account: "a", direction: "remove", entries: [] });

  /* The positive control. Without this, every test above would still pass if
     guardWrite simply refused everything forever. */
  assert.deepEqual(grant, { allowed: true, reasons: [] });
  assert.equal(removal.allowed, true);
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

test("an unrecognised suspend state is not a clearance", () => {
  const entries = [
    { kind: "suspend", state: "on", account: "a", reason: "Held.", at: new Date().toISOString() },
    { kind: "suspend", state: "cleared", account: "a", at: new Date().toISOString() },
  ];
  assert.equal(suspendedAccounts(entries).length, 1, "a typo in a state field must never release an account");
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

test("the gate never throws, whatever it is handed", async () => {
  const verdicts = await Promise.all([
    guardWrite("/akeso/no/such/directory/at/all", { account: "a", direction: "grant" }),
    guardWrite(undefined, { account: "a", direction: "grant", entries: [] }),
    guardWrite(await scratch(), {}),
    guardWrite(await scratch(), { account: "a", direction: "grant", entries: "not an array" }),
    guardWrite(await scratch(), { account: "a", direction: "grant", now: Number.NaN }),
  ]);

  for (const verdict of verdicts) {
    assert.equal(typeof verdict.allowed, "boolean");
    assert.ok(Array.isArray(verdict.reasons));
    /* Our own failure is never a licence to write. */
    if (!verdict.allowed) assert.ok(verdict.reasons.length > 0, "a refusal always says why");
  }
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
    canaryGate({ releaseId: "1.4.0", canaryResults: [] }).reason,
    canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", result: "failed" }] }).reason,
    canaryGate({ releaseId: "1.4.0", canaryResults: [{ releaseId: "1.4.0", clean: true }] }).reason,
    writeBudget([restore("x", "grant", now)], { now, perHour: 1 }).reason,
  ];

  assert.ok(sentences.length >= 8);
  for (const sentence of sentences) assertFounderReadable(sentence, "a refusal reason");
});
