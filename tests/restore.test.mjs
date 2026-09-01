import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOLERANCE_SECONDS,
  describeOutcome,
  planRestore,
  restoreEntitlement,
  restoreLedgerEntry,
  restoreVia,
  signRequest,
  verifyRequest,
} from "../src/restore.mjs";

/* This is the module that changes a real customer's access. Every test here is
   a rule standing between it and somebody's incident, so each name is the rule,
   not the function. Nothing in this file touches the network. */

const SECRET = "whsec_akeso_restore_2f8c1d9e4b6a7c05";

/* A stand-in for the customer's app. Records what it was asked and answers with
   whatever the test needs it to answer. */
function fakeApp(answer, { status = 200, raw = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (raw === null ? JSON.stringify(typeof answer === "function" ? answer(init) : answer) : raw),
    };
  };
  return { fetchImpl, calls };
}

const ask = (extra = {}) => ({
  endpoint: "https://app.example.com/api/akeso-restore",
  secret: SECRET,
  account: "acct_42",
  target: true,
  expectedState: false,
  reasonCode: "monitor:paying-but-locked-out",
  idempotencyKey: "akeso-grant-abc123",
  ...extra,
});

/* ------------------------------------------------------------ dry runs */

test("a dry run that comes back applied is reported as a failure, loudly", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ dryRun: true, fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed", "a dry run can never be an applied restore");
  assert.equal(outcome.verified, false);
  assert.match(outcome.reason, /preview must change nothing/);
  assert.equal(outcome.outcomeKnown, false, "the app may really have changed it, so the state is unknown");
  assert.match(describeOutcome(outcome), /DRY RUN PROBLEM/);
});

test("a dry run that claims applied is caught even when it reports no state to contradict it", async () => {
  /* The same rule as above, with nothing else able to catch it: no before, no
     after, so only the dry-run rule itself stands between this answer and a
     ledger entry saying access was restored. */
  const app = fakeApp({ result: "applied", verified: true });
  const outcome = await restoreEntitlement(ask({ dryRun: true, fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.verified, false);
  assert.match(outcome.reason, /ignoring the request to only preview/, "only the dry-run rule itself can produce this");
  assert.match(outcome.reason, /may really have been changed/);
});

test("a dry run whose before and after disagree is a change during a dry run", async () => {
  const app = fakeApp({ result: "no_op", before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ dryRun: true, fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.outcomeKnown, false);
  assert.match(outcome.reason, /one state before and a different one after/, "the before/after rule is the one that must catch this");
  assert.match(outcome.reason, /preview must change nothing/);
});

test("a dry run tells the app it is a dry run and previews without claiming a change", async () => {
  const app = fakeApp({ result: "no_op", before: { billingEntitled: false } });
  const outcome = await restoreEntitlement(ask({ dryRun: true, fetchImpl: app.fetchImpl }));

  assert.equal(JSON.parse(app.calls[0].init.body).dryRun, true, "the app cannot honour a dry run it was not told about");
  assert.equal(outcome.result, "no_op");
  assert.equal(outcome.verified, false, "nothing was written, so nothing is confirmed");
  assert.equal(outcome.wouldChange, true);
  assert.match(describeOutcome(outcome), /nothing was changed/);
  assert.match(describeOutcome(outcome), /a real run would ask your app to set it to access/);
});

test("a dry run preview that contradicts the state the app itself reported is not shown as a preview", async () => {
  /* The app says a real run would change nothing, while reporting the account
     in the state Akeso is asking it to leave. Believing the verdict over the
     state prints "already at access" to a founder about an account that has
     none, and that is the sentence somebody approves a real run on. */
  const app = fakeApp({ result: "no_op", wouldChange: false, before: { billingEntitled: false } });
  const outcome = await restoreEntitlement(ask({ dryRun: true, fetchImpl: app.fetchImpl }));
  const line = describeOutcome(outcome);

  assert.ok(!/already has this account at access/.test(line), `a preview claimed the opposite of the reported state: ${line}`);
  assert.match(line, /cannot both be true/);
  assert.match(line, /cannot say what a real run would do/);
});

/* -------------------------------------------------------- our own faults */

test("a timeout is could_not_reach and says the outcome is unknown", async () => {
  /* Watchdog: without it, a regression that drops the deadline hangs this file
     forever instead of failing it, and a test that hangs gets deleted rather
     than fixed. */
  const hung = Symbol("never answered");
  const outcome = await Promise.race([
    restoreEntitlement(ask({
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}), /* an app that never answers */
    })),
    new Promise((resolve) => setTimeout(() => resolve(hung), 3000).unref()),
  ]);
  assert.notEqual(outcome, hung, "restoreEntitlement must enforce its own deadline, not wait forever");

  assert.equal(outcome.result, "could_not_reach", "our timeout is never a verdict about their app");
  assert.equal(outcome.outcomeKnown, false);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reason, /outcome is unknown/i);
  assert.match(describeOutcome(outcome), /may or may not have happened/);
});

test("an app that answers and then never sends the answer hits the same deadline", async () => {
  /* The dangerous half of a timeout. A deadline that stops once the status line
     arrives is not a deadline: the app can answer in a millisecond and take
     forever to send the body, which is what a dying container does. The sweep
     would wait for it forever, and a sweep that never finishes is a monitor
     that stopped monitoring without saying so. */
  const hung = Symbol("never answered");
  const outcome = await Promise.race([
    restoreEntitlement(ask({
      timeoutMs: 20,
      fetchImpl: async () => ({ status: 200, text: () => new Promise(() => {}) }),
    })),
    new Promise((resolve) => setTimeout(() => resolve(hung), 3000).unref()),
  ]);
  assert.notEqual(outcome, hung, "the deadline must cover reading the answer, not only getting one");

  assert.equal(outcome.result, "could_not_reach", "a stalled body is our failure, never a verdict on their app");
  assert.equal(outcome.outcomeKnown, false);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reason, /outcome is unknown/i);
});

test("a dead server is our failure, never the app's", async () => {
  const outcome = await restoreEntitlement(ask({
    fetchImpl: async () => { throw new Error("ECONNREFUSED 127.0.0.1:3000"); },
  }));

  assert.equal(outcome.result, "could_not_reach");
  assert.equal(outcome.outcomeKnown, false);
  assert.match(outcome.reason, /ECONNREFUSED/);
});

test("a non-JSON answer is could_not_reach, not a failure attributed to the app", async () => {
  const app = fakeApp(null, { status: 502, raw: "<html>Bad Gateway</html>" });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "could_not_reach");
  assert.equal(outcome.httpStatus, 502);
  assert.equal(outcome.outcomeKnown, false);
  assert.match(outcome.reason, /outcome is unknown/i);
});

test("an answer that does not say what it did leaves the outcome unknown", async () => {
  const app = fakeApp({ ok: true, message: "sure thing" });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "could_not_reach", "an unrecognised answer is not a pass and not a verdict");
  assert.equal(outcome.outcomeKnown, false);
});

test("nothing sent means nothing changed, and that is stated separately from unknown", async () => {
  for (const [missing, patch] of [
    ["endpoint", { endpoint: null }],
    ["secret", { secret: null }],
    ["idempotency key", { idempotencyKey: null }],
  ]) {
    const outcome = await restoreEntitlement(ask({ ...patch, fetchImpl: async () => { throw new Error("must not be called"); } }));
    assert.equal(outcome.result, "could_not_reach", `a missing ${missing} must not reach the app`);
    assert.equal(outcome.outcomeKnown, true, `a missing ${missing} means nothing was sent, which we know`);
    assert.match(outcome.reason, /Nothing was sent/);
  }
});

test("Akeso will not guess which way to move an account", async () => {
  const outcome = await restoreEntitlement(ask({ target: undefined, direction: undefined, fetchImpl: async () => { throw new Error("must not be called"); } }));
  assert.equal(outcome.result, "could_not_reach");
  assert.match(outcome.reason, /will not guess/);
});

/* ------------------------------------------- not taking the app's word */

test("an app reporting applied without verified:true is not accepted as applied", async () => {
  const app = fakeApp({ result: "applied", verified: false, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed", "Akeso does not take the app's word for success");
  assert.equal(outcome.verified, false);
  assert.match(outcome.reason, /did not confirm it by reading the account back/);
});

test("an app reporting after different from the target is not accepted as applied", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: false } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed");
  assert.equal(outcome.afterEntitled, false);
  assert.match(outcome.reason, /did not land the way it was asked for/);
});

test("an applied with no state reported at all is not provable, so it is not a pass", async () => {
  const app = fakeApp({ result: "applied", verified: true });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "failed");
  assert.match(outcome.reason, /nothing to check the claim against/);
});

test("a confirmed applied is accepted, and only then", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "applied");
  assert.equal(outcome.verified, true);
  assert.equal(outcome.beforeEntitled, false);
  assert.equal(outcome.afterEntitled, true);
  assert.match(describeOutcome(outcome), /confirmed by reading the account back/);
});

test("a no_op is accepted only when the account really reads as the target", async () => {
  const agrees = fakeApp({ result: "no_op", verified: true, before: { billingEntitled: true } });
  const good = await restoreEntitlement(ask({ fetchImpl: agrees.fetchImpl }));
  assert.equal(good.result, "no_op");
  assert.equal(good.verified, true);

  const contradicts = fakeApp({ result: "no_op", verified: true, before: { billingEntitled: false } });
  const bad = await restoreEntitlement(ask({ fetchImpl: contradicts.fetchImpl }));
  assert.equal(bad.result, "failed", "nothing needed changing and the account is wrong cannot both be true");
  assert.equal(bad.outcomeKnown, false);
});

test("nothing needed changing is only confirmed when the app says it read the account back", async () => {
  /* The same bar as an applied restore. "Nothing needed changing" is still a
     claim about how the account reads right now, and an app can send it from a
     row it cached minutes ago. Without this, the receipt tells a founder it was
     confirmed by reading the account when nobody read anything. */
  const app = fakeApp({ result: "no_op", before: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "no_op");
  assert.equal(outcome.verified, false, "the app never said it re-read, so this is not confirmed");
  assert.match(outcome.reason, /did not confirm that by reading the account back/);
  assert.ok(!/Confirmed by reading/i.test(describeOutcome(outcome)), "a receipt must not claim a read nobody reported");
  assert.match(describeOutcome(outcome), /Read the account yourself/);
});

test("a no_op with no state reported is never marked confirmed", async () => {
  const app = fakeApp({ result: "no_op" });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "no_op");
  assert.equal(outcome.verified, false, "unprovable is never a pass");
  assert.match(describeOutcome(outcome), /not confirmed/);
});

test("a refusal by the app is passed through and never counted as a change", async () => {
  for (const [claimed, expected] of [["conflict", "conflict"], ["unsupported", "unsupported"], ["failed", "failed"]]) {
    const app = fakeApp({ result: claimed, reason: "a human set this account's access on purpose", before: { billingEntitled: true } });
    const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));
    assert.equal(outcome.result, expected);
    assert.equal(outcome.verified, false, `${claimed} is not a change`);
    assert.ok(describeOutcome(outcome).length > 0);
  }
});

test("an answer about a different account is not an answer about this one", async () => {
  /* A cache, a load balancer or an off-by-one in their handler can hand back
     somebody else's response. Believing it would write "confirmed" against
     acct_42 on the strength of acct_99's state. */
  const app = fakeApp({ result: "applied", verified: true, account: "acct_99", before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "could_not_reach", "an answer about someone else proves nothing about this account");
  assert.equal(outcome.outcomeKnown, false);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.afterEntitled, null, "the other account's state must not be recorded against this one");
  assert.match(outcome.reason, /acct_99/);

  /* An app that echoes the account it was asked about is still believed. */
  const echoes = fakeApp({ result: "applied", verified: true, account: "acct_42", before: { billingEntitled: false }, after: { billingEntitled: true } });
  assert.equal((await restoreEntitlement(ask({ fetchImpl: echoes.fetchImpl }))).result, "applied");
});

test("an app that answers properly on a non-2xx status is still believed", async () => {
  const app = fakeApp({ result: "conflict", reason: "state changed since it was read", before: { billingEntitled: true } }, { status: 409 });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "conflict", "a status code is not a substitute for the app's own answer");
  assert.equal(outcome.httpStatus, 409);
});

/* -------------------------------------------- removals wait for a person */

test("a removal is never sent without a person having approved it", async () => {
  /* The rule the whole product is built around. A wrong grant costs a few
     dollars; a wrong removal locks a paying customer out of what they paid for.
     This is the last place that rule can be enforced, because past here the
     change is in their database. */
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: true }, after: { billingEntitled: false } });
  const outcome = await restoreEntitlement(ask({ target: false, expectedState: true, fetchImpl: app.fetchImpl }));

  assert.equal(app.calls.length, 0, "nothing may reach the app until a human has approved it");
  assert.equal(outcome.result, "could_not_reach");
  assert.equal(outcome.outcomeKnown, true, "we did not send it, so we know nothing changed");
  assert.match(outcome.reason, /does not take access away without a person approving it/);
  assert.match(describeOutcome(outcome), /nothing was changed/i);
});

test("a dry run of a removal is not a way around the approval", async () => {
  /* The one thing a dry run cannot rely on is the app honouring dryRun, which
     is the failure this module already treats as its loudest alarm. So a
     removal is a removal, dry or not. */
  const app = fakeApp({ result: "no_op", verified: true, before: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ target: false, dryRun: true, fetchImpl: app.fetchImpl }));

  assert.equal(app.calls.length, 0, "an app that ignores dryRun would remove access with no human anywhere");
  assert.match(outcome.reason, /person approving it/);
});

test("an approved removal travels with the approval and the approval is written down", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: true }, after: { billingEntitled: false } });
  const outcome = await restoreEntitlement(ask({
    target: false, expectedState: true, approvalId: "5f0d1c8e-approval", fetchImpl: app.fetchImpl,
  }));

  assert.equal(JSON.parse(app.calls[0].init.body).approvalId, "5f0d1c8e-approval", "the app is told which approval it is acting on");
  assert.equal(outcome.result, "applied");
  assert.equal(restoreLedgerEntry(outcome).approvalId, "5f0d1c8e-approval", "the only durable evidence a person said yes");
});

test("a grant needs no approval, because a grant is the safe direction", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const outcome = await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  assert.equal(outcome.result, "applied", "a paying customer locked out must never wait on paperwork");
  assert.equal(restoreLedgerEntry(outcome).approvalId, null);
});

test("the sweep adapter cannot be used to remove access without an approval either", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: true }, after: { billingEntitled: false } });
  const restore = restoreVia({ endpoint: "https://app.example.com/akeso-restore", secret: SECRET, fetchImpl: app.fetchImpl });

  const refused = await restore("acct_42", false, { expected: true, reasonCode: "monitor:canceled-but-entitled", idempotencyKey: "akeso-remove-1" });
  assert.equal(app.calls.length, 0);
  assert.match(refused.reason, /person approving it/);

  const allowed = await restore("acct_42", false, { expected: true, reasonCode: "monitor:canceled-but-entitled", idempotencyKey: "akeso-remove-1", approvalId: "abc" });
  assert.equal(allowed.result, "applied", "with a human named, the same removal goes through");
});

/* ------------------------------------------------------------- signing */

test("a request Akeso sends verifies against the body Akeso actually sent", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  const { init } = app.calls[0];
  const check = verifyRequest(init.body, init.headers["akeso-signature"], SECRET);
  assert.equal(check.valid, true, check.reason);
});

test("a tampered signature fails verification", () => {
  const body = JSON.stringify({ account: "acct_42", target: true });
  const header = signRequest(body, SECRET);
  const tampered = header.replace(/v1=(.)/, (_all, first) => `v1=${first === "0" ? "1" : "0"}`);

  assert.equal(verifyRequest(body, tampered, SECRET).valid, false);
  assert.match(verifyRequest(body, tampered, SECRET).reason, /does not match/);
});

test("a body changed after signing fails verification", () => {
  const body = JSON.stringify({ account: "acct_42", target: true });
  const header = signRequest(body, SECRET);
  const swapped = JSON.stringify({ account: "acct_99", target: true });

  assert.equal(verifyRequest(swapped, header, SECRET).valid, false);
});

test("a genuinely signed request that is too old is refused as a replay", () => {
  const body = JSON.stringify({ account: "acct_42" });
  const now = Date.now();
  const stale = signRequest(body, SECRET, Math.floor(now / 1000) - (DEFAULT_TOLERANCE_SECONDS + 60));

  const result = verifyRequest(body, stale, SECRET, { now });
  assert.equal(result.valid, false, "a real signature does not make an old request safe to apply twice");
  assert.match(result.reason, /replay/);
});

test("a timestamp far in the future is refused as well", () => {
  const body = JSON.stringify({ account: "acct_42" });
  const now = Date.now();
  const ahead = signRequest(body, SECRET, Math.floor(now / 1000) + (DEFAULT_TOLERANCE_SECONDS + 60));

  assert.equal(verifyRequest(body, ahead, SECRET, { now }).valid, false);
});

test("a fresh, correctly signed request passes", () => {
  const body = JSON.stringify({ account: "acct_42" });
  const now = Date.now();
  const header = signRequest(body, SECRET, Math.floor(now / 1000) - 5);

  const result = verifyRequest(body, header, SECRET, { now });
  assert.equal(result.valid, true);
  assert.match(result.reason, /inside the replay window/);
});

test("a missing or malformed signature is refused, never crashed on", () => {
  const body = JSON.stringify({ account: "acct_42" });
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    [undefined, /no signature was sent/],
    [null, /no signature was sent/],
    ["", /no signature was sent/],
    ["   ", /no signature was sent/],
    ["not-a-signature", /form Akeso sends/],
    ["t=,v1=", /form Akeso sends/],
    ["v1=abc", /form Akeso sends/, "a signature with no timestamp cannot be checked for replay"],
    [`t=${now}`, /form Akeso sends/, "a timestamp with no signature proves nothing"],
    ["t=notanumber,v1=abc", /readable timestamp/],
    /* a wrong-length signature: this is the one that makes timingSafeEqual throw */
    [`t=${now},v1=abc`, /does not match/],
  ];
  for (const [header, expected, why] of bad) {
    const result = verifyRequest(body, header, SECRET);
    assert.equal(result.valid, false, `${JSON.stringify(header)} must not verify`);
    assert.match(result.reason, expected, why || `the refusal must say why: ${JSON.stringify(header)}`);
  }
});

test("a body that was parsed before it was checked is refused, and says so", () => {
  /* The endpoint we generate lives in someone else's web framework, where the
     easy mistake is to check the parsed body instead of the raw text. Coerced,
     every object signs as the same bytes, and the refusal would blame the
     signature instead of naming the mistake. */
  const parsed = { account: "acct_42" };
  const result = verifyRequest(parsed, signRequest(JSON.stringify(parsed), SECRET), SECRET);

  assert.equal(result.valid, false);
  assert.match(result.reason, /raw text/);
  assert.equal(verifyRequest({ account: "acct_99" }, signRequest("[object Object]", SECRET), SECRET).valid, false,
    "two different bodies must never collapse into the same signed bytes");
});

test("a signature is never accepted without a secret on the checking side", () => {
  const body = JSON.stringify({ account: "acct_42" });
  const result = verifyRequest(body, signRequest(body, SECRET), "");
  assert.equal(result.valid, false, "no secret configured must never mean everything verifies");
});

/* -------------------------------------------------------- the secret */

test("the secret never appears in any output, including a thrown error message", async () => {
  const outcomes = [];

  outcomes.push(await restoreEntitlement(ask({
    /* the worst realistic case: an error message that quotes the whole request */
    fetchImpl: async () => { throw new Error(`connect failed using secret ${SECRET}`); },
  })));
  outcomes.push(await restoreEntitlement(ask({
    fetchImpl: fakeApp({ result: "unsupported", reason: `refused, secret was ${SECRET}` }).fetchImpl,
  })));
  outcomes.push(await restoreEntitlement(ask({ endpoint: null })));

  for (const outcome of outcomes) {
    assert.ok(!JSON.stringify(outcome).includes(SECRET), `the secret leaked into an outcome: ${outcome.reason}`);
    assert.ok(!describeOutcome(outcome).includes(SECRET), "the secret leaked into a receipt line");
    assert.ok(!JSON.stringify(restoreLedgerEntry(outcome)).includes(SECRET), "the secret leaked into the ledger entry");
  }
});

test("the secret is never put on the wire, only a signature derived from it", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  await restoreEntitlement(ask({ fetchImpl: app.fetchImpl }));

  const sent = JSON.stringify(app.calls[0]);
  assert.ok(!sent.includes(SECRET), "the secret must never leave this machine");
  assert.ok(app.calls[0].init.headers["akeso-signature"].startsWith("t="));
  /* Carried in the header as well as the body: the header is what an HTTP layer
     in front of their handler can dedupe on before the body is even read. */
  assert.equal(app.calls[0].init.headers["idempotency-key"], "akeso-grant-abc123");
});

/* ------------------------------------------------------------ planning */

test("the same decision retried in the same window reuses one idempotency key", () => {
  const first = planRestore({ account: "a", direction: "grant", expectedState: false, ruleVersion: "1", windowKey: "2026-08-31" });
  const again = planRestore({ account: "a", direction: "grant", expectedState: false, ruleVersion: "1", windowKey: "2026-08-31" });
  assert.equal(first.idempotencyKey, again.idempotencyKey, "a retry must not become a second write");
});

test("a genuinely new decision gets a new idempotency key", () => {
  const base = { account: "a", direction: "grant", ruleVersion: "1", windowKey: "2026-08-31" };
  const key = (patch) => planRestore({ ...base, ...patch }).idempotencyKey;

  assert.notEqual(key({}), key({ windowKey: "2026-09-01" }), "a new window is a new decision");
  assert.notEqual(key({}), key({ account: "b" }), "a different account is a different decision");
  assert.notEqual(key({}), key({ direction: "remove" }), "the other direction is never the same key");
  assert.notEqual(key({}), key({ ruleVersion: "2" }), "a decision under a new rule is a new decision");
});

test("a plan says exactly what is being asked for, and refuses to guess the rest", () => {
  const plan = planRestore({ account: "acct_42", direction: "remove", expectedState: true, ruleVersion: "1", windowKey: "sweep-7", reasonCode: "monitor:canceled-but-entitled" });

  assert.equal(plan.target, false, "remove means the account must end with no access");
  assert.equal(plan.expected, true, "the expectation is what turns a lost race into a conflict");
  assert.equal(plan.dryRun, false);
  assert.equal(plan.reasonCode, "monitor:canceled-but-entitled");

  assert.throws(() => planRestore({ account: "a", direction: "sideways", windowKey: "w" }), /grant.*remove/);
  assert.throws(() => planRestore({ account: "a", direction: "grant" }), /windowKey/);
  assert.throws(() => planRestore({ direction: "grant", windowKey: "w" }), /account/);
});

test("a plan can be sent as it stands", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const plan = planRestore({ account: "acct_42", direction: "grant", expectedState: false, windowKey: "sweep-7" });
  const outcome = await restoreEntitlement({ endpoint: "https://app.example.com/akeso-restore", secret: SECRET, fetchImpl: app.fetchImpl, ...plan });

  assert.equal(outcome.result, "applied");
  const sent = JSON.parse(app.calls[0].init.body);
  assert.equal(sent.idempotencyKey, plan.idempotencyKey);
  assert.equal(sent.expected, false, "the expectation must survive the trip or the compare-and-set is not one");
});

/* ------------------------------------------------------------ receipts */

test("no receipt line claims a confirmation that did not happen", async () => {
  const unconfirmed = [
    await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "applied", verified: false, after: { billingEntitled: true } }).fetchImpl })),
    await restoreEntitlement(ask({ fetchImpl: async () => { throw new Error("gone"); } })),
    await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "no_op" }).fetchImpl })),
  ];

  for (const outcome of unconfirmed) {
    const line = describeOutcome(outcome);
    assert.ok(!/confirmed by reading/i.test(line), `a receipt claimed confirmation it did not have: ${line}`);
    assert.ok(!/^\s*$/.test(line));
  }
});

test("every receipt line is plain English and says what happens next", async () => {
  const lines = [
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "conflict", before: { billingEntitled: true } }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "unsupported", reason: "account carries an administrative block" }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: async () => { throw new Error("timeout") } }))),
    describeOutcome(await restoreEntitlement(ask({ dryRun: true, fetchImpl: fakeApp({ result: "no_op", before: { billingEntitled: false } }).fetchImpl }))),
    /* The loudest line in the module and the one a founder reads at 3am, so it
       is held to the same bar as the calm ones. */
    describeOutcome(await restoreEntitlement(ask({ dryRun: true, fetchImpl: fakeApp({ result: "applied", verified: true }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ target: false, expectedState: true }))),
    describeOutcome(await restoreEntitlement(ask({ idempotencyKey: null }))),
    describeOutcome(null),
  ];

  for (const line of lines) {
    assert.ok(line.length > 20, `a receipt line must actually say something: ${line}`);
    assert.ok(!line.includes("—"), `no em-dashes in anything a founder reads: ${line}`);
    assert.ok(!/billingEntitled|null|undefined|\bHTTP\b|dryRun|idempotenc|JSON/.test(line), `a founder should never have to read code words: ${line}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(line), "no emoji");
  }
});

test("no receipt line says the same thing to a founder twice", async () => {
  /* Every reason is already a whole message, so a line built as "reason plus
     our own ending" said "Nothing was sent to your app" twice and gave two
     copies of the same instruction. Two identical sentences read as two
     different events. */
  const lines = [
    describeOutcome(await restoreEntitlement(ask({ endpoint: null }))),
    describeOutcome(await restoreEntitlement(ask({ idempotencyKey: null }))),
    describeOutcome(await restoreEntitlement(ask({ target: undefined, direction: undefined }))),
    describeOutcome(await restoreEntitlement(ask({ target: false, expectedState: true }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "unsupported", reason: "an administrator set this by hand" }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "failed", reason: "the write was rejected" }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ fetchImpl: fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: false } }).fetchImpl }))),
    describeOutcome(await restoreEntitlement(ask({ dryRun: true, fetchImpl: fakeApp({ result: "applied", verified: true }).fetchImpl }))),
  ];

  for (const line of lines) {
    const sentences = line.split(/(?<=[.!?])\s+/).map((part) => part.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()).filter(Boolean);
    const seen = new Set();
    for (const sentence of sentences) {
      assert.ok(!seen.has(sentence), `a receipt said the same sentence twice: ${line}`);
      seen.add(sentence);
    }
    assert.equal((line.match(/read this account before trying again/gi) || []).length <= 1, true, `two copies of one instruction: ${line}`);
    assert.ok(!/ {2}/.test(line), `a gap where a sentence should be: ${line}`);
  }
});

/* ----------------------------------------------------------- the ledger */

test("the ledger entry keeps the difference between nothing happened and we do not know", async () => {
  const applied = restoreLedgerEntry(await restoreEntitlement(ask({
    fetchImpl: fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } }).fetchImpl,
  })));
  assert.equal(applied.kind, "restore", "the existing ledger kind, so the receipt keeps working");
  assert.equal(applied.result, "applied");
  assert.equal(applied.verified, true);
  assert.equal(applied.before, false);
  assert.equal(applied.after, true);
  assert.equal(applied.outcomeKnown, true);

  const lost = restoreLedgerEntry(await restoreEntitlement(ask({ fetchImpl: async () => { throw new Error("socket hang up"); } })));
  assert.equal(lost.result, "could_not_reach");
  assert.equal(lost.verified, false);
  assert.equal(lost.outcomeKnown, false, "read back next month this must not look like nothing happened");
  assert.equal(lost.before, null, "an unknown state is never written down as false");
});

test("an outcome that never said whether it knows is not written down as knowing", async () => {
  /* The shape runSweep builds in its own catch: { result, reason } and nothing
     else. Recorded as outcomeKnown:true it reads, next month, as "we sent it
     and nothing happened", which is precisely what it does not mean. */
  const entry = restoreLedgerEntry({ result: "failed", reason: "the restore threw" });
  assert.equal(entry.outcomeKnown, false, "silence about what we know is not a claim that we know");
  assert.equal(entry.before, null);
  assert.equal(entry.after, null);

  /* And it never throws. An exception here would lose the record of the very
     attempt that went wrong. */
  for (const junk of [null, undefined, "x", 7]) {
    const written = restoreLedgerEntry(junk);
    assert.equal(written.kind, "restore");
    assert.equal(written.result, null, "a result we cannot read is never invented");
    assert.equal(written.outcomeKnown, false);
    assert.equal(written.verified, false);
  }
});

test("the sweep adapter hands the secret nowhere and still returns a full outcome", async () => {
  const app = fakeApp({ result: "applied", verified: true, before: { billingEntitled: false }, after: { billingEntitled: true } });
  const restore = restoreVia({ endpoint: "https://app.example.com/akeso-restore", secret: SECRET, fetchImpl: app.fetchImpl });

  /* Exactly how runSweep calls it. */
  const outcome = await restore("acct_42", true, { expected: false, reasonCode: "monitor:paying-but-locked-out", idempotencyKey: "akeso-grant-abc123" });

  assert.equal(outcome.result, "applied");
  assert.equal(outcome.verified, true);
  assert.equal(outcome.before.billingEntitled, false, "runSweep reads outcome.before?.billingEntitled");
  assert.equal(outcome.after.billingEntitled, true);
});
