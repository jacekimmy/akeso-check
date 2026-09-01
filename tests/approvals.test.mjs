import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DELAY_MINUTES,
  EXPIRY_DAYS,
  approvalState,
  approve,
  cancel,
  describeApproval,
  foldApprovals,
  pendingApprovals,
  queueRemoval,
} from "../src/approvals.mjs";
import { appendEntry, readLedger, verifyLedger } from "../src/ledger.mjs";

/* Every test here is a rule standing between a paying customer and the moment
   they cannot get into the thing they paid for. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-approvals-"));
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

const queued = (over = {}) => ({
  kind: "approval",
  id: "id-1",
  state: "queued",
  account: "acct-1",
  reason: "Stripe says canceled, the app still grants access",
  priceMonthly: null,
  queuedAt: new Date(0).toISOString(),
  readyAt: new Date(30 * MINUTE).toISOString(),
  ...over,
});

test("queuing a removal records an intention, and takes nothing away", async () => {
  const root = await scratch();
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const entry = await queueRemoval(root, { account: "acct-1", reason: "Stripe says canceled", priceMonthly: 29, now });

  assert.equal(entry.kind, "approval");
  assert.equal(entry.state, "queued", "queuing is not removing");
  assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, "each queued removal gets its own id to approve or cancel");
  assert.equal(entry.queuedAt, new Date(now).toISOString());
  assert.equal(entry.readyAt, new Date(now + DEFAULT_DELAY_MINUTES * MINUTE).toISOString());

  const ledger = await readLedger(root);
  assert.equal(ledger.length, 1, "queuing writes one line and nothing else");
  assert.equal(verifyLedger(ledger).intact, true);
});

test("the cancel window is thirty minutes unless the caller sets it", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const wide = await queueRemoval(root, { account: "acct-1", delayMinutes: 60, now });
  assert.equal(wide.readyAt, new Date(now + 60 * MINUTE).toISOString());
  assert.equal(DEFAULT_DELAY_MINUTES, 30, "the default window matches the one the monitor promises the founder");
});

test("a queued removal that is not ready yet is not actionable", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  await queueRemoval(root, { account: "acct-1", now });
  const ledger = await readLedger(root);

  const early = pendingApprovals(ledger, { now: now + 5 * MINUTE });
  assert.equal(early.length, 1, "it is still on the list, so the founder can see and cancel it");
  assert.equal(early[0].ready, false);
  assert.equal(approvalState(ledger, early[0].id, { now: now + 5 * MINUTE }), "queued");

  const late = pendingApprovals(ledger, { now: now + 31 * MINUTE });
  assert.equal(late[0].ready, true);
  assert.equal(approvalState(ledger, late[0].id, { now: now + 31 * MINUTE }), "ready");
});

test("approving inside the cancel window is refused, but cancelling never is", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });

  const early = await approve(root, id, { by: "founder", now: now + MINUTE });
  assert.equal(early.ok, false);
  assert.equal(early.state, "queued");
  assert.match(early.message, /cancel window/);
  assert.equal((await readLedger(root)).length, 1, "a refused approval writes nothing");

  const stopped = await cancel(root, id, { by: "founder", now: now + MINUTE });
  assert.equal(stopped.ok, true, "stopping a removal is always allowed, at any point in the window");
  assert.equal(approvalState(await readLedger(root), id, { now: now + MINUTE }), "cancelled");
});

test("a cancellation is final: a later approve must not flip it back", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  await cancel(root, id, { by: "founder", reason: "they resubscribed", now: now + MINUTE });

  const later = await approve(root, id, { by: "someone-else", now: now + 90 * MINUTE });
  assert.equal(later.ok, false);
  assert.equal(later.state, "cancelled");
  assert.equal(approvalState(await readLedger(root), id, { now: now + 90 * MINUTE }), "cancelled");
});

test("a cancelled row stays cancelled even when an approved entry is appended directly", () => {
  /* The fold, not the command, is what has to be right: the ledger is a file
     and anything could append to it. */
  const entries = [
    queued(),
    { kind: "approval", id: "id-1", state: "cancelled", by: "founder" },
    { kind: "approval", id: "id-1", state: "approved", by: "a later line" },
  ];
  assert.equal(approvalState(entries, "id-1", { now: 60 * MINUTE }), "cancelled");
  assert.deepEqual(pendingApprovals(entries, { now: 60 * MINUTE }), []);
});

test("an approval is final too: a later cancel must not undo it", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  const said = await approve(root, id, { by: "founder", now: now + 31 * MINUTE });
  assert.equal(said.ok, true);
  assert.equal(said.confirmed, true, "success is only claimed after reading the ledger back");

  const undo = await cancel(root, id, { by: "founder", now: now + 32 * MINUTE });
  assert.equal(undo.ok, false);
  assert.equal(undo.state, "approved");
  assert.match(undo.message, /grants are instant and safe/, "the refusal names the action that actually helps");
  assert.equal(approvalState(await readLedger(root), id, { now: now + 32 * MINUTE }), "approved");
});

test("re-approving is a no-op, not a second approval", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  await approve(root, id, { by: "founder", now: now + 31 * MINUTE });
  const again = await approve(root, id, { by: "founder", now: now + 32 * MINUTE });

  assert.equal(again.ok, true);
  assert.equal(again.alreadyDone, true);
  assert.equal(again.entry, null);
  const approvals = (await readLedger(root)).filter((entry) => entry.kind === "approval" && entry.state === "approved");
  assert.equal(approvals.length, 1, "two taps on the same button leave one approval behind");
});

test("re-cancelling is a no-op too", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  await cancel(root, id, { by: "founder", now: now + MINUTE });
  const again = await cancel(root, id, { by: "founder", now: now + 2 * MINUTE });

  assert.equal(again.ok, true);
  assert.equal(again.entry, null);
  assert.equal((await readLedger(root)).filter((entry) => entry.state === "cancelled").length, 1);
});

test("an id nobody queued is unknown, never approved", async () => {
  const root = await scratch();
  assert.equal(approvalState([], "nothing-like-this"), "unknown");
  assert.equal(approvalState(await readLedger(root), "nothing-like-this"), "unknown");

  const attempt = await approve(root, "nothing-like-this", { by: "founder" });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.state, "unknown");
  assert.equal((await readLedger(root)).length, 0, "an unknown id writes nothing");
});

test("a bare approved entry for an id that was never queued authorises nothing", () => {
  const entries = [{ kind: "approval", id: "never-queued", state: "approved", by: "a stray line" }];
  assert.equal(approvalState(entries, "never-queued"), "unknown");
  assert.deepEqual(pendingApprovals(entries), []);
});

test("an entry with a missing or malformed id is ignored, not thrown on", () => {
  const entries = [
    { kind: "approval", state: "queued", account: "no-id" },
    { kind: "approval", id: 42, state: "queued", account: "number-id" },
    { kind: "approval", id: "   ", state: "queued", account: "blank-id" },
    { kind: "approval", id: null, state: "approved" },
    null,
    { kind: "unreadable", raw: "{ broken" },
    queued({ id: "good", account: "acct-good" }),
  ];

  const pending = pendingApprovals(entries, { now: 60 * MINUTE });
  assert.equal(pending.length, 1, "one bad line must never make the whole queue unreadable");
  assert.equal(pending[0].account, "acct-good");
  assert.equal(approvalState(entries, "good", { now: 60 * MINUTE }), "ready");
});

test("a state this file does not recognise is ignored rather than guessed at", () => {
  const entries = [queued(), { kind: "approval", id: "id-1", state: "probably-fine" }];
  assert.equal(approvalState(entries, "id-1", { now: 60 * MINUTE }), "ready", "an unknown word never decides a removal");
});

test("a queued removal nobody answered expires after seven days", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  const ledger = await readLedger(root);

  assert.equal(approvalState(ledger, id, { now: now + 6 * DAY }), "ready");
  assert.equal(approvalState(ledger, id, { now: now + EXPIRY_DAYS * DAY }), "expired");
  assert.deepEqual(pendingApprovals(ledger, { now: now + 8 * DAY }), [], "an expired removal is not a question anymore");

  const late = await approve(root, id, { by: "founder", now: now + 8 * DAY });
  assert.equal(late.ok, false);
  assert.equal(late.state, "expired");
  assert.equal((await readLedger(root)).length, 1, "an approval a human forgot must not execute weeks later");
});

test("expiry is derived, never written", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  const ledger = await readLedger(root);

  assert.equal(approvalState(ledger, id, { now: now + 8 * DAY }), "expired");
  assert.equal(ledger.length, 1, "reading the queue writes nothing");
  assert.equal(ledger[0].state, "queued", "the history still says what actually happened");
});

test("an expired removal can still be cancelled, which is the safe direction", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  const stopped = await cancel(root, id, { by: "founder", now: now + 8 * DAY });

  assert.equal(stopped.ok, true);
  assert.equal(approvalState(await readLedger(root), id, { now: now + 8 * DAY }), "cancelled");
});

test("pendingApprovals never includes approved, cancelled or expired rows", () => {
  const now = 10 * DAY;
  const entries = [
    queued({ id: "approved-one", account: "a", queuedAt: new Date(now - 60 * MINUTE).toISOString(), readyAt: new Date(now - 30 * MINUTE).toISOString() }),
    { kind: "approval", id: "approved-one", state: "approved", by: "founder" },
    queued({ id: "cancelled-one", account: "b", queuedAt: new Date(now - 60 * MINUTE).toISOString(), readyAt: new Date(now - 30 * MINUTE).toISOString() }),
    { kind: "approval", id: "cancelled-one", state: "cancelled", by: "founder" },
    queued({ id: "expired-one", account: "c", queuedAt: new Date(now - 9 * DAY).toISOString(), readyAt: new Date(now - 9 * DAY + 30 * MINUTE).toISOString() }),
    queued({ id: "waiting-one", account: "d", queuedAt: new Date(now - 60 * MINUTE).toISOString(), readyAt: new Date(now - 30 * MINUTE).toISOString() }),
  ];

  const pending = pendingApprovals(entries, { now });
  assert.deepEqual(pending.map((row) => row.id), ["waiting-one"]);
  assert.equal(approvalState(entries, "expired-one", { now }), "expired");
});

test("pending removals are listed oldest first, so the longest wait is answered first", () => {
  const now = 5 * DAY;
  const entries = [
    queued({ id: "older", account: "a", queuedAt: new Date(now - 3 * DAY).toISOString(), readyAt: new Date(now - 3 * DAY).toISOString() }),
    queued({ id: "newer", account: "b", queuedAt: new Date(now - MINUTE).toISOString(), readyAt: new Date(now + 29 * MINUTE).toISOString() }),
  ];
  assert.deepEqual(pendingApprovals(entries, { now }).map((row) => row.id), ["older", "newer"]);
});

test("a readyAt that cannot be read is never treated as ready", () => {
  const entries = [queued({ readyAt: "soon" })];
  const row = pendingApprovals(entries, { now: 6 * DAY })[0];
  assert.equal(row.ready, false, "what cannot be proven is not a pass, least of all for a removal");
  assert.equal(approvalState(entries, "id-1", { now: 60 * MINUTE }), "queued");
  assert.equal(approvalState(entries, "id-1", { now: 6 * DAY }), "queued", "no readable window means the window never passed");
});

test("a second queued entry for the same id does not restart the cancel window", () => {
  const entries = [
    queued({ readyAt: new Date(30 * MINUTE).toISOString() }),
    queued({ readyAt: new Date(10 * DAY).toISOString(), account: "hijacked" }),
  ];
  const row = pendingApprovals(entries, { now: 45 * MINUTE })[0];
  assert.equal(row.account, "acct-1", "the first queuing is the record");
  assert.equal(row.ready, true);
});

test("queuing without an account is refused rather than written", async () => {
  const root = await scratch();
  await assert.rejects(() => queueRemoval(root, { reason: "no idea who" }), /must name the account/);
  assert.equal((await readLedger(root)).length, 0, "a removal that names nobody is not a row anyone could answer");
});

test("what was queued travels with the approval, so a stale removal can be caught later", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  await queueRemoval(root, {
    account: "acct-1",
    reason: "Stripe says canceled, the app still grants access",
    priceMonthly: 29,
    expectedState: { billingEntitled: true },
    ruleVersion: "1",
    now,
  });

  const row = pendingApprovals(await readLedger(root), { now: now + 31 * MINUTE })[0];
  assert.deepEqual(row.expectedState, { billingEntitled: true }, "the executor re-reads and compares before it touches anything");
  assert.equal(row.priceMonthly, 29);
  assert.equal(foldApprovals(await readLedger(root), { now }).get(row.id).ruleVersion, "1", "a finding means nothing without the rule that produced it");
});

test("no price is invented when Stripe never gave one", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  await queueRemoval(root, { account: "acct-1", priceMonthly: "twenty-nine dollars", now });
  const row = pendingApprovals(await readLedger(root), { now: now + 31 * MINUTE })[0];

  assert.equal(row.priceMonthly, null);
  assert.ok(!describeApproval(row, { now: now + 31 * MINUTE }).includes("$"), "a number Akeso does not have is never printed");
});

test("who cancelled and why is kept, so the decision can be read back", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  await cancel(root, id, { by: "jace", reason: "they emailed, it was a card retry", now: now + MINUTE });

  const row = foldApprovals(await readLedger(root), { now: now + MINUTE }).get(id);
  assert.equal(row.by, "jace");
  assert.equal(row.cancelReason, "they emailed, it was a card retry");
  assert.equal(row.state, "cancelled");
});

test("every line a founder reads is plain, and says what happens next", () => {
  const now = 10 * DAY;
  const base = { id: "id-1", account: "acct-1", reason: "Stripe says canceled, the app still grants access", priceMonthly: 29, readyAt: new Date(now + 18 * MINUTE).toISOString() };
  const lines = [
    describeApproval({ ...base, state: "queued", ready: false }, { now }),
    describeApproval({ ...base, state: "ready", ready: true }, { now }),
    describeApproval({ ...base, state: "approved" }, { now }),
    describeApproval({ ...base, state: "cancelled" }, { now }),
    describeApproval({ ...base, state: "expired" }, { now }),
    describeApproval(null),
  ];

  for (const line of lines) {
    assert.ok(!line.includes("\n"), "one line, so it can sit in a list");
    assert.doesNotMatch(line, /[—–]/, "plain punctuation only");
    assert.doesNotMatch(line, /\p{Extended_Pictographic}/u, "no emoji");
    assert.match(line, /(removed|remove|removes|removal|confirm|access)/, "each line says what happens to access");
    assert.match(line.trim(), /\.$/);
  }

  assert.match(lines[0], /cannot be approved for another 18 minutes/, "the wait is stated in minutes a human can read");
  assert.match(lines[0], /nothing is removed until you approve it/);
  assert.match(lines[1], /Approve it to take that access away, or cancel it/);
  assert.match(lines[1], /\$29\.00 a month at list price/);
  assert.match(lines[4], new RegExp(`more than ${EXPIRY_DAYS} days ago`));
});

test("one minute left reads as one minute, not zero and not minus one", () => {
  const now = 10 * DAY;
  const line = describeApproval({ id: "id-1", account: "acct-1", state: "queued", ready: false, readyAt: new Date(now + 20000).toISOString() }, { now });
  assert.match(line, /another 1 minute,/);
});

test("the whole flow leaves one unbroken, append-only history", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  const first = await queueRemoval(root, { account: "acct-1", priceMonthly: 29, now });
  const second = await queueRemoval(root, { account: "acct-2", priceMonthly: 9, now });
  await cancel(root, first.id, { by: "jace", reason: "card retry", now: now + MINUTE });
  await approve(root, second.id, { by: "jace", now: now + 31 * MINUTE });
  await approve(root, first.id, { by: "jace", now: now + 32 * MINUTE }); /* refused, writes nothing */

  const ledger = await readLedger(root);
  assert.equal(ledger.length, 4);
  assert.equal(verifyLedger(ledger).intact, true);
  assert.deepEqual(ledger.map((entry) => entry.state), ["queued", "queued", "cancelled", "approved"]);
  assert.equal(approvalState(ledger, first.id, { now: now + 32 * MINUTE }), "cancelled");
  assert.equal(approvalState(ledger, second.id, { now: now + 32 * MINUTE }), "approved");
  assert.deepEqual(pendingApprovals(ledger, { now: now + 32 * MINUTE }), [], "both questions were answered");
});

test("approvals ignore every other kind of ledger entry", async () => {
  const root = await scratch();
  const now = 1000 * MINUTE;
  await appendEntry(root, { kind: "check", grade: "F", findings: [] });
  const { id } = await queueRemoval(root, { account: "acct-1", now });
  await appendEntry(root, { kind: "sweep", comparison: { clean: false } });
  await appendEntry(root, { kind: "restore", account: "acct-1", direction: "grant", result: "applied" });

  const ledger = await readLedger(root);
  assert.equal(pendingApprovals(ledger, { now: now + 31 * MINUTE }).length, 1);
  assert.equal(approvalState(ledger, id, { now: now + 31 * MINUTE }), "ready");
});
