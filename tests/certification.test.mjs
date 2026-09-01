import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp } from "node:fs/promises";
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
import { renderAdapter } from "../src/adapter.mjs";
import { appendEntry, checkEntry, ledgerPath, readLedger, verifyLedger } from "../src/ledger.mjs";

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
  assert.match(statement.text, /A card fails and Stripe is retrying it: access ends as soon as a payment fails\./);
  assert.match(statement.text, /A refund on its own: it ends access\./);
  assert.match(statement.text, /Accounts with no Stripe subscription at all: not expected/);
  assert.match(statement.text, /never removes access on its own/, "the founder is told which direction still needs them");
  assert.match(statement.text, /1 Stripe price id is mapped/);
});

test("every answer the founder gave is visible in the statement, whichever way they answered", async () => {
  /* A rule a founder cannot see is a rule they cannot correct, and it is the
     rule Akeso will act on. The Stripe-worded list names a status only when it
     falls on one particular side: a founder who chose "end access when a card
     fails" was not mentioned under either heading, so their own answer had
     disappeared from the statement of the rules they confirmed. */
  const said = {
    past_due: {
      keep: /A card fails and Stripe is retrying it: the customer keeps access/,
      end: /A card fails and Stripe is retrying it: access ends as soon as a payment fails/,
    },
    paused: {
      keep: /A subscription is paused: access continues/,
      end: /A subscription is paused: access stops/,
    },
    refund: {
      follow_subscription: /A refund on its own: it changes nothing/,
      end: /A refund on its own: it ends access/,
    },
    no_subscription: {
      expected: /no Stripe subscription at all: expected/,
      not_expected: /no Stripe subscription at all: not expected/,
    },
    first_payment_incomplete: {
      no_conclusion: /A first payment that has not finished: not judged either way/,
      treat_as_not_paying: /A first payment that has not finished: treated as not paying/,
    },
  };

  for (const question of CERTIFICATION_QUESTIONS) {
    for (const option of question.options) {
      const root = await scratch();
      await certified(root, { policy: buildPolicy({ [question.id]: option.value }) });
      const { text } = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));
      assert.match(text, said[question.id][option.value], `answering "${option.value}" to "${question.id}" left no trace a founder could read`);
    }
  }
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

  const statement = coverageStatement(status);
  assert.equal(statement.covered, false);
  /* Re-answering the questions would not fix a table Akeso could not find, so
     our own failure is not handed back to the founder as homework. */
  assert.match(statement.whatToDoNext, /from the folder your app's code is in/);
  assert.ok(!/^Run npx akeso-check certify/.test(statement.whatToDoNext), "the next step must be one that would actually help");
});

test("a certification with no rules recorded can never read as covered", () => {
  /* Only a hand-edited ledger produces this, and it must fail closed. */
  const entries = [{ kind: "certify", certifiedAt: daysAgo(1), schemaFingerprint: PRINT, priceToPlan: {} }];
  const status = certificationStatus(entries, { schemaFingerprint: PRINT });
  assert.equal(status.stale, true);
  assert.equal(status.staleCode, "no_rules_recorded");
  assert.equal(coverageStatement(status).covered, false);
});

test("rules Akeso cannot read are not rules, whatever shape they arrive in", () => {
  /* An entry carrying `policy: "keep"` would otherwise read as covered while
     every rule in it came out undefined, which the engine reads as "not
     entitled" for every customer whose card is being retried: a queue of
     removals under rules nobody ever confirmed. */
  for (const policy of ["keep", 7, [], { ruleVersion: "1" }, { entitledWhilePastDue: "true", entitledWhilePaused: false }]) {
    const status = certificationStatus(
      [{ kind: "certify", certifiedAt: daysAgo(1), policy, schemaFingerprint: PRINT, priceToPlan: {} }],
      { schemaFingerprint: PRINT },
    );
    assert.equal(status.staleCode, "no_rules_recorded", `${JSON.stringify(policy)} was accepted as a set of rules`);
    assert.equal(status.policy, null, "rules Akeso cannot read are never handed on to a sweep");
    assert.equal(coverageStatement(status).covered, false);
  }
});

test("a statement never dies half printed, whatever it is handed", () => {
  /* A printer that throws takes the whole command down with it, including the
     findings it was about to show. Anything it cannot read reads as not
     covered, which is the safe direction. */
  for (const status of [
    null,
    {},
    { certified: true, at: "2026-01-01T00:00:00.000Z", policy: null, stale: false },
    { certified: true, at: null, policy: buildPolicy({}), stale: false },
    { certified: true, at: "not a date", policy: buildPolicy({}), stale: false },
  ]) {
    const statement = coverageStatement(status);
    assert.equal(statement.covered, false, `${JSON.stringify(status)} was read as covered`);
    assert.ok(statement.whatToDoNext, "a founder is never left without the next step");
  }
});

test("a line Akeso could not read after the certification stops coverage", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(1) });
  /* A write that was cut off, which is what a crash mid-append leaves behind.
     It may have been a newer certification, so Akeso cannot say which rules
     are in force. */
  await appendFile(ledgerPath(root), '{"kind":"certify","policy"\n');

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.stale, true, "an unreadable line after the certification may have been newer rules");
  assert.equal(status.staleCode, "ledger_unreadable");
  assert.match(status.staleReason, /Akeso could not read/, "our own failure is worded as ours, not as a fault in the app");
  assert.equal(coverageStatement(status).covered, false);
});

test("a line Akeso could not read before the certification does not stop coverage", async () => {
  /* Anything written before the certification in force was superseded by it,
     so it cannot change which rules apply. Stopping coverage for it would be
     crying wolf. */
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));
  await appendFile(ledgerPath(root), "half a line of nothing\n");
  await certified(root, { certifiedAt: daysAgo(1) });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.stale, false);
  assert.equal(coverageStatement(status).covered, true);
});

test("an unreadable record is never reported as a founder who has not certified", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));
  await appendFile(ledgerPath(root), '{"kind":"certify"\n');

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: PRINT });
  assert.equal(status.certified, false, "nothing readable says these rules were ever confirmed");
  assert.equal(status.couldNotRead, true);

  const statement = coverageStatement(status);
  assert.equal(statement.covered, false);
  assert.match(statement.text, /could not read part of this app's own record/, "not measured is said out loud, never rounded to 'you never certified'");
  assert.match(statement.whatToDoNext, /certify/);
});

test("a certification dated in the future never buys itself coverage it did not earn", () => {
  /* A certification ahead of the clock never gets older, so the age limit
     would never fire on it: a ledger dated next year would be treated as fresh
     for a year. A clock a few minutes out is a different thing and must not
     cost anyone their coverage. */
  const ahead = (ms) => certificationStatus(
    [{ kind: "certify", certifiedAt: new Date(Date.now() + ms).toISOString(), policy: buildPolicy({}), schemaFingerprint: PRINT, priceToPlan: {} }],
    { schemaFingerprint: PRINT },
  );

  const nextYear = ahead(365 * DAY_MS);
  assert.equal(nextYear.stale, true);
  assert.equal(nextYear.staleCode, "dated_in_future");
  assert.equal(coverageStatement(nextYear).covered, false);

  const slightlyFast = ahead(60000);
  assert.equal(slightlyFast.stale, false, "a clock one minute fast is not a reason to drop coverage");
  assert.equal(slightlyFast.ageDays, 0, "a founder is never shown an age of minus one days");
});

test("a date the ledger could never use is refused before it is written, not after", async () => {
  /* The ledger is append-only, so a bad date here can never be corrected, only
     superseded. Both of these would leave a certification that can never be
     aged. */
  const root = await scratch();
  await assert.rejects(
    () => certified(root, { certifiedAt: "some time last spring" }),
    /not a date Akeso can read/,
  );
  await assert.rejects(
    () => certified(root, { certifiedAt: new Date(Date.now() + 30 * DAY_MS).toISOString() }),
    /dated in the future/,
  );
  assert.deepEqual(await readLedger(root), [], "a refused certification writes nothing");
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
  assert.equal(policy.rulesFingerprint, buildPolicy({}).rulesFingerprint, "identical rules must read as identical whether typed in or left alone");
});

test("different rules carry a different fingerprint, so a finding can be traced back", () => {
  const lenient = buildPolicy({});
  const strict = buildPolicy({ past_due: "end" });
  assert.notEqual(strict.rulesFingerprint, lenient.rulesFingerprint);
  assert.equal(buildPolicy({ past_due: "end" }).rulesFingerprint, strict.rulesFingerprint, "the same answers always fingerprint the same");
});

test("certification never invents a ruleVersion the founder's own app would refuse", () => {
  /* ruleVersion is a shared contract value, not a label. The adapter Akeso
     generates exports AKESO_RULE_VERSION, and both restoreBillingEntitlement
     and the restore endpoint answer "conflict" to any request whose ruleVersion
     is not equal to it. A version derived from the founder's answers would
     never match the constant in their app, so every restore would be refused,
     including the grants that let a locked-out paying customer back in. */
  const installed = renderAdapter().match(/AKESO_RULE_VERSION = "([^"]+)"/)[1];
  assert.equal(buildPolicy({}).ruleVersion, installed);
  assert.equal(buildPolicy({ past_due: "end", paused: "keep", refund: "end" }).ruleVersion, installed, "answering the questions is not a change to the app's rule version");
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

test("an answer filed under a question Akeso does not ask is refused, never dropped", () => {
  /* A misspelled id is a lost answer, not an unanswered question. Dropped
     silently, the founder who said "end access when a card fails" would be
     told in writing that they left it at Akeso's suggestion, and Akeso would
     keep access on every failing card. */
  assert.throws(() => buildPolicy({ past_dues: "end" }), /not one of the questions/);
  assert.throws(() => buildPolicy({ pastDue: "end", paused: "keep" }), /not one of the questions/);
});

test("something that is not a set of answers is refused, never read as no answers", () => {
  for (const notAnswers of ["past_due=end", ["past_due"], 7]) {
    assert.throws(() => buildPolicy(notAnswers), /set of question ids/, `${JSON.stringify(notAnswers)} was accepted as an empty set of answers`);
  }
  /* Nothing at all is a real case: it means every question is unanswered. */
  assert.equal(buildPolicy().defaulted.length, CERTIFICATION_QUESTIONS.length);
  assert.equal(buildPolicy(null).defaulted.length, CERTIFICATION_QUESTIONS.length);
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
  for (const status of statuses) assert.ok(coverageStatement(status).whatToDoNext, "every statement says what happens next");
});

test("a founder is never shown Akeso's own names for its questions", async () => {
  /* The list of questions left at the suggested answer used to be printed as
     raw ids, which puts first_payment_incomplete in front of someone who was
     promised plain English. */
  const root = await scratch();
  await certified(root, { policy: buildPolicy({ paused: "keep" }) });
  const { text } = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));

  assert.match(text, /left at Akeso's suggested answer/);
  for (const id of ["first_payment_incomplete", "no_subscription"]) {
    assert.ok(!text.includes(id), `the statement shows a founder the internal name ${id}`);
  }
  assert.match(text, /a first payment that has not finished/, "the question is named in words instead");
});

test("a covered statement claims nothing it did not measure", async () => {
  const root = await scratch();
  await certified(root, { certifiedAt: daysAgo(2) });
  const { text } = coverageStatement(certificationStatus(await readLedger(root), { schemaFingerprint: PRINT }));

  /* Certifying turns coverage on. It does not start a sweep, and this module
     cannot see whether one is scheduled, so it must not say one is running. */
  assert.ok(!/keeps sweeping/.test(text), "certification cannot know that sweeps are happening");
  /* Staleness is measured from an instant and this line is a date, so the two
     can differ by part of a day. The rule is stated, the date is approximate,
     and the consequence is spelled out. */
  assert.match(text, new RegExp(`stand for ${CERTIFICATION_MAX_AGE_DAYS} days, so until about \\d{4}-\\d{2}-\\d{2}`));
  assert.match(text, /Akeso stops covering this app until you confirm them again/);
  assert.ok(!/two minutes/.test(text), "no invented number, however small");
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
