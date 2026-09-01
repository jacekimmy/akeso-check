import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CERTIFICATION_MAX_AGE_DAYS,
  CERTIFICATION_QUESTIONS,
  buildPolicy,
  certificationStatus,
  certify,
  coverageStatement,
  describeQuestion,
  fingerprintSchema,
} from "../src/certification.mjs";
import { DEFAULT_POLICY, entitledUnder } from "../src/policy.mjs";
import { appendEntry, checkEntry, readLedger, verifyLedger } from "../src/ledger.mjs";

/* Coverage starts at certification and never before. Every test here is a way
   the product could quietly start claiming to watch an app under rules nobody
   confirmed, which is how a monitor produces confident wrong findings. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-cert-"));
const DAY_MS = 86400000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

const SCHEMA = { table: "profiles", column: "billing_entitled", accountColumn: "id" };
const PRINT = fingerprintSchema(SCHEMA);

const certified = async (root, overrides = {}) => certify(root, {
  policy: buildPolicy({}),
  priceToPlan: { price_123: "Pro" },
  schemaFingerprint: PRINT,
  adapterVersion: "1",
  ...overrides,
});

/* Every date a founder is shown, as YYYY-MM-DD, in the order they appear. */
const datesIn = (text) => text.match(/\d{4}-\d{2}-\d{2}/g) || [];

/* ------------------------------------------------- there is no implicit yes */

test("an app nobody certified is not covered, and nothing implies otherwise", () => {
  const status = certificationStatus([], { schemaFingerprint: PRINT });
  assert.equal(status.certified, false);
  assert.equal(status.policy, null, "no rules are in force until a human confirms some");
  assert.equal(status.stale, false, "never certified is not the same as gone stale");

  const statement = coverageStatement(status);
  assert.equal(statement.covered, false);
  assert.equal(statement.since, null);
  assert.match(statement.text, /not covering this app yet/);
  assert.match(statement.whatToDoNext, /certify/, "a founder is never left without the next step");
});

test("a ledger full of checks and sweeps still means uncertified", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));
  await appendEntry(root, { kind: "sweep", comparison: { clean: true }, drift: null, alerts: [] });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.certified, false, "work done before certification never certifies anything");
  assert.equal(coverageStatement(status).covered, false);
});

/* ------------------------------------------------------ coverage claims */

test("coverage is never claimed for any time before the certification", async () => {
  const root = await scratch();
  /* A ledger that starts a year before coverage did. The statement must not
     be able to reach that date. */
  await appendEntry(root, checkEntry({ grade: "F", findings: ["cancels ignored"] }));
  const at = daysAgo(30);
  await certified(root, { certifiedAt: at });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  const statement = coverageStatement(status);
  const day = at.slice(0, 10);

  assert.equal(statement.covered, true);
  assert.equal(statement.since, at, "coverage starts at the certification, not at the first ledger entry");
  assert.match(statement.text, new RegExp(`Coverage started on ${day}`));
  assert.match(statement.text, /was not watching before/);
  for (const date of datesIn(statement.text)) {
    assert.ok(date >= day, `the statement shows ${date}, which is before coverage began on ${day}`);
  }
});

test("the rules in force are stated in the same words the founder confirmed them in", async () => {
  const root = await scratch();
  await certified(root, { policy: buildPolicy({ past_due: "end", refund: "end", no_subscription: "not_expected" }) });

  const statement = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));
  assert.match(statement.text, /The rules you confirmed:/);
  assert.ok(!/past_due/.test(statement.text.split("Not paying")[0]), "past_due is not listed as keeping access when the founder said end it");
  assert.match(statement.text, /a refund ends access/);
  assert.match(statement.text, /not expected/);
  assert.match(statement.text, /1 Stripe price id is mapped/);
});

test("every answer the founder gave is visible in the statement, including the ones that keep access", async () => {
  /* A rule a founder cannot see is a rule they cannot correct, and a wrong
     rule they never noticed is where confident wrong findings come from. */
  const root = await scratch();
  await certified(root, { policy: buildPolicy({ paused: "keep" }) });
  const keeps = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));
  assert.match(keeps.text, /Paused subscriptions: access continues/);

  const root2 = await scratch();
  await certified(root2, { policy: buildPolicy({ paused: "end" }) });
  const ends = coverageStatement(certificationStatus(await readLedger(root2), { schemaFingerprint: PRINT }));
  assert.match(ends.text, /Paused subscriptions: access stops/);
});

test("a statement says which answers were the founder's and which were Akeso's suggestion", async () => {
  const root = await scratch();
  await certified(root, { policy: buildPolicy({}) });
  const allDefaults = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));
  assert.match(allDefaults.text, new RegExp(`${CERTIFICATION_QUESTIONS.length} of the ${CERTIFICATION_QUESTIONS.length} questions were left at Akeso's suggested answer`));

  const answers = Object.fromEntries(CERTIFICATION_QUESTIONS.map((question) => [question.id, question.default]));
  const root2 = await scratch();
  await certified(root2, { policy: buildPolicy(answers) });
  const answered = coverageStatement(certificationStatus(await readLedger(root2), { schemaFingerprint: PRINT }));
  assert.match(answered.text, /None of these rules is an Akeso assumption/);
});

/* ------------------------------------------------------------ staleness */

test("a changed schema makes a fresh certification stale, and coverage stops", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(1) });

  const moved = fingerprintSchema({ ...SCHEMA, column: "is_pro" });
  const status = certificationStatus(await readLedger(root), { schemaFingerprint: moved });

  assert.equal(status.certified, true, "the certification still exists");
  assert.equal(status.stale, true, "one day old and already stale, because it now describes a different schema");
  assert.equal(status.staleCode, "schema_changed");

  const statement = coverageStatement(status);
  assert.equal(statement.covered, false, "a stale certification is never silently treated as valid");
  assert.equal(statement.since, null, "no coverage claim while the rules cannot be shown to apply");
  assert.match(statement.text, /not covering this app right now/);
  assert.match(statement.whatToDoNext, /certify/);
});

test("a certification older than the limit is stale even when the schema still matches", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(CERTIFICATION_MAX_AGE_DAYS + 20) });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.stale, true);
  assert.equal(status.staleCode, "expired");
  assert.match(status.staleReason, new RegExp(`more than ${CERTIFICATION_MAX_AGE_DAYS} days`));
  assert.equal(coverageStatement(status).covered, false);
});

test("a certification inside the age limit still covers the app", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(CERTIFICATION_MAX_AGE_DAYS - 1) });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.stale, false, "the limit is a limit, not a hair trigger");
  assert.equal(status.ageDays, CERTIFICATION_MAX_AGE_DAYS - 1);
  assert.equal(coverageStatement(status).covered, true);
});

test("a schema Akeso could not read this run is never assumed to match", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(1) });

  /* Our own inability to read the schema. It must not buy a pass, and the
     wording must blame the run rather than the customer's app. */
  const status = certificationStatus(await readLedger(root), {});
  assert.equal(status.stale, true);
  assert.equal(status.staleCode, "schema_unverified");
  assert.match(status.staleReason, /Akeso could not read/);
  assert.equal(coverageStatement(status).covered, false);
});

test("a certification with no rules recorded can never read as covered", () => {
  /* Only a hand-edited ledger produces this, and it must fail closed. */
  const entries = [{ kind: "certify", certifiedAt: daysAgo(1), schemaFingerprint: PRINT, priceToPlan: {} }];
  const status = certificationStatus(entries, { schemaFingerprint: PRINT });
  assert.equal(status.stale, true);
  assert.equal(status.staleCode, "no_rules_recorded");
  assert.equal(coverageStatement(status).covered, false);
});

test("a certification with an unreadable date is stale, never assumed current", () => {
  const entries = [{ kind: "certify", certifiedAt: "some time last spring", policy: buildPolicy({}), schemaFingerprint: PRINT, priceToPlan: {} }];
  const status = certificationStatus(entries, { schemaFingerprint: PRINT });
  assert.equal(status.stale, true);
  assert.equal(status.staleCode, "age_unknown");
});

test("a stale statement never claims the app was covered up to the moment it went stale", async () => {
  const root = await scratch();
  const at = daysAgo(90);
  await certified(root, { certifiedAt: at });
  const status = certificationStatus(await readLedger(root), { schemaFingerprint: fingerprintSchema({ ...SCHEMA, table: "accounts" }) });

  const statement = coverageStatement(status);
  /* Akeso does not know when the schema moved, so any "covered until" date
     would be a number nobody measured. */
  assert.ok(!/until/.test(statement.text), "no claim about a period Akeso cannot measure");
  for (const date of datesIn(statement.text)) {
    assert.ok(date >= at.slice(0, 10), "even a stale statement never reaches back before certification");
  }
});

/* --------------------------------------------------------------- policy */

test("no answers gives the documented defaults, and says every one of them was a default", () => {
  const policy = buildPolicy();

  assert.equal(policy.entitledWhilePastDue, DEFAULT_POLICY.entitledWhilePastDue);
  assert.equal(policy.entitledWhilePaused, DEFAULT_POLICY.entitledWhilePaused);
  assert.deepEqual(policy.neverConclude, DEFAULT_POLICY.neverConclude);
  assert.equal(policy.ruleVersion, DEFAULT_POLICY.ruleVersion);
  assert.deepEqual(policy.defaulted, CERTIFICATION_QUESTIONS.map((question) => question.id), "a report must be able to say which rules the founder never gave");
});

test("answering every question the way Akeso suggests is the same rule set, not a new one", () => {
  const answers = Object.fromEntries(CERTIFICATION_QUESTIONS.map((question) => [question.id, question.default]));
  const policy = buildPolicy(answers);

  assert.deepEqual(policy.defaulted, [], "these answers were given, not assumed");
  assert.equal(policy.ruleVersion, DEFAULT_POLICY.ruleVersion, "identical rules must carry an identical version");
});

test("different rules carry a different rule version, so a finding can be traced back", () => {
  const lenient = buildPolicy({});
  const strict = buildPolicy({ past_due: "end" });
  assert.notEqual(strict.ruleVersion, lenient.ruleVersion);
  assert.equal(buildPolicy({ past_due: "end" }).ruleVersion, strict.ruleVersion, "the same answers always version the same");
});

test("the founder's answers actually change what the engine concludes", () => {
  assert.equal(entitledUnder("past_due", buildPolicy({ past_due: "keep" })), true);
  assert.equal(entitledUnder("past_due", buildPolicy({ past_due: "end" })), false);
  assert.equal(entitledUnder("paused", buildPolicy({ paused: "keep" })), true);
  assert.equal(entitledUnder("paused", buildPolicy({ paused: "end" })), false);
  assert.equal(entitledUnder("incomplete", buildPolicy({})), null, "mid-checkout is not judged by default");
  assert.equal(entitledUnder("incomplete", buildPolicy({ first_payment_incomplete: "treat_as_not_paying" })), false);
});

test("the status table is never redefined by certification", () => {
  const policy = buildPolicy({ past_due: "end", paused: "keep" });
  /* Every rule that is not the merchant's to decide comes through unchanged. */
  assert.equal(entitledUnder("unpaid", policy), false);
  assert.equal(entitledUnder("canceled", policy), false);
  assert.equal(entitledUnder("active", policy), true);
  assert.equal(entitledUnder("trialing", policy), true);
  assert.equal(entitledUnder("some_future_status", policy), null, "an unknown status is still never guessed at");
});

test("an answer that was never offered is refused, never rounded to the nearest one", () => {
  assert.throws(() => buildPolicy({ past_due: "sometimes" }), /not one of the answers/);
  assert.throws(() => buildPolicy({ paused: true }), /not one of the answers/);
  /* An unanswered question is a default. A wrong answer is an error. The two
     must never collapse into each other. */
  assert.equal(buildPolicy({ past_due: undefined }).defaulted.includes("past_due"), true);
});

test("every question is answerable by a non-technical founder and says why it is asked", () => {
  const ids = new Set();
  for (const question of CERTIFICATION_QUESTIONS) {
    assert.ok(question.id && !ids.has(question.id), `duplicate or missing id: ${question.id}`);
    ids.add(question.id);
    assert.ok(question.question.endsWith("?"), `${question.id} is not phrased as a question`);
    assert.ok(question.options.length >= 2, `${question.id} offers no choice`);
    assert.ok(question.options.some((option) => option.value === question.default), `${question.id} defaults to an answer it does not offer`);
    assert.ok(question.why && question.why.length > 40, `${question.id} does not say why it is being asked`);
    for (const option of question.options) assert.ok(option.label && option.label.length > 3, `${question.id} has an unlabelled option`);
  }
  for (const required of ["past_due", "paused", "refund", "no_subscription"]) {
    assert.ok(ids.has(required), `the ${required} rule was never asked about`);
  }
  assert.equal(describeQuestion("past_due").defaultLabel, "Keep their access while Stripe retries the card");
  assert.equal(describeQuestion("not_a_question"), null, "an unknown question is not invented");
});

test("nothing a founder reads uses jargon punctuation or emoji", async () => {
  const root = await scratch();
  await certified(root);
  const statuses = [
    certificationStatus([], { schemaFingerprint: PRINT }),
    certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }),
    certificationStatus(await readLedger(root), {}),
  ];
  const prose = [
    ...CERTIFICATION_QUESTIONS.flatMap((question) => [question.question, question.why, ...question.options.map((option) => option.label)]),
    ...statuses.map((status) => coverageStatement(status).text),
  ].join("\n");

  assert.ok(!/[—–]/.test(prose), "no em-dashes or en-dashes");
  assert.ok(!/\p{Extended_Pictographic}/u.test(prose), "no emoji");
  assert.ok(!/tamper-proof/i.test(prose), "the ledger is tamper-evident, never tamper-proof");
});

/* ----------------------------------------------------------- fingerprint */

test("the same schema always fingerprints the same, and any real change does not", () => {
  assert.equal(fingerprintSchema(SCHEMA), fingerprintSchema({ ...SCHEMA }), "same inputs, same fingerprint");

  const variants = [
    { ...SCHEMA, table: "accounts" },
    { ...SCHEMA, column: "is_pro" },
    { ...SCHEMA, accountColumn: "user_id" },
    { ...SCHEMA, extraFields: ["plan"] },
  ];
  const seen = new Set([fingerprintSchema(SCHEMA)]);
  for (const variant of variants) {
    const print = fingerprintSchema(variant);
    assert.ok(!seen.has(print), `${JSON.stringify(variant)} collided with another schema`);
    seen.add(print);
  }
});

test("re-ordering the same columns is not a schema change", () => {
  /* Otherwise tidying a config file would demand a fresh certification, and a
     founder who is asked to re-certify for nothing stops reading the ask. */
  assert.equal(
    fingerprintSchema({ ...SCHEMA, extraFields: ["plan", "trial_ends_at"] }),
    fingerprintSchema({ ...SCHEMA, extraFields: ["trial_ends_at", "plan", "plan"] }),
  );
  assert.equal(fingerprintSchema(SCHEMA), fingerprintSchema({ table: " Profiles ", column: "BILLING_ENTITLED", accountColumn: "Id" }), "case and stray spaces are not a schema change");
});

test("a fingerprint is never made from a schema Akeso does not know", () => {
  /* A fingerprint over nothing would match every schema forever. */
  assert.throws(() => fingerprintSchema({ column: "billing_entitled" }), /needs at least the table/);
  assert.throws(() => fingerprintSchema({ table: "profiles" }), /needs at least the table/);
  assert.throws(() => fingerprintSchema({}), /needs at least the table/);
});

/* --------------------------------------------------------------- ledger */

test("certifying is an append that leaves the chain intact and readable", async () => {
  const root = await scratch();
  const record = await certified(root, { notes: "confirmed on the onboarding call" });

  const entries = await readLedger(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "certify");
  assert.equal(entries[0].certifiedAt, record.certifiedAt);
  assert.equal(entries[0].priceToPlan.price_123, "Pro");
  assert.deepEqual(verifyLedger(entries), { intact: true, entries: 1 });
});

test("re-certifying appends and the newest rules win, leaving the old entry untouched", async () => {
  const root = await scratch();
  const first = await certified(root, { policy: buildPolicy({}), certifiedAt: daysAgo(200) });
  const moved = fingerprintSchema({ ...SCHEMA, column: "is_pro" });
  await certified(root, { policy: buildPolicy({ past_due: "end" }), schemaFingerprint: moved, certifiedAt: daysAgo(1) });

  const entries = await readLedger(root);
  assert.equal(entries.length, 2, "history is added to, never rewritten");
  assert.deepEqual(entries[0], first, "the superseded certification is exactly as it was written");
  assert.deepEqual(verifyLedger(entries), { intact: true, entries: 2 });

  const status = certificationStatus(entries, { schemaFingerprint: moved });
  assert.equal(status.stale, false, "the new certification covers the new schema");
  assert.equal(status.policy.entitledWhilePastDue, false, "the rules in force are the newest ones");
  assert.equal(coverageStatement(status).since, entries[1].certifiedAt, "coverage restarts at the new certification");
});

test("a certification that could never go stale is refused", async () => {
  const root = await scratch();
  await assert.rejects(
    () => certify(root, { policy: buildPolicy({}), priceToPlan: {} }),
    /needs a schema fingerprint/,
    "without a fingerprint a schema change could never be noticed",
  );
  assert.deepEqual(await readLedger(root), [], "a refused certification writes nothing");
});

test("a certification with no rules to judge by is refused", async () => {
  const root = await scratch();
  await assert.rejects(() => certify(root, { schemaFingerprint: PRINT }), /needs the rules/);
  await assert.rejects(() => certify(root, { policy: { ruleVersion: "1" }, schemaFingerprint: PRINT }), /missing "entitledWhilePastDue"/);
});

test("a plan name is never invented for a price the founder sells", async () => {
  const root = await scratch();
  await assert.rejects(
    () => certify(root, { policy: buildPolicy({}), schemaFingerprint: PRINT, priceToPlan: { price_123: "" } }),
    /will not invent a name/,
  );
  await assert.rejects(
    () => certify(root, { policy: buildPolicy({}), schemaFingerprint: PRINT, priceToPlan: ["price_123"] }),
    /map of Stripe price ids/,
  );
});

test("an empty price map is allowed, and the statement says plans will be named by price id", async () => {
  const root = await scratch();
  await certified(root, { priceToPlan: {} });
  const statement = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));
  assert.equal(statement.covered, true, "not naming your plans is not a reason to refuse coverage");
  assert.match(statement.text, /call plans by their price id/);
});
