import { createHash } from "node:crypto";
import { appendEntry, lastOfKind } from "./ledger.mjs";
import { DEFAULT_POLICY, describePolicy } from "./policy.mjs";

/* Certification: the moment the founder confirms the rules their app will be
 * judged by. Coverage starts here and never before.
 *
 * Why this file exists at all. A monitor that watches an app under rules
 * nobody confirmed does not produce "mostly right" findings, it produces
 * confident wrong ones: it calls a grace period a leak, it calls a paused
 * account a cancellation, it counts complimentary accounts as stolen money.
 * Every one of those is a founder losing trust in the tool the first week.
 * So Akeso asks a few plain questions first, writes the answers to the ledger,
 * and only then says it is watching.
 *
 * Four things make a certification stop counting, and every one of them means
 * coverage is OFF rather than degraded:
 *   1. The schema moved. The certification was made against one table and one
 *      column. If those changed under us, every later verdict was reached by
 *      reading something we were never shown.
 *   2. It got old. Billing rules drift quietly. After 180 days the honest
 *      statement is "you told me this half a year ago", not "still true".
 *   3. We could not read it: the rules are not rules we can parse, or a line
 *      written after them could not be read and may have replaced them. That
 *      is our failure, and the wording says so, but it still stops coverage.
 *   4. It is dated ahead of the clock, which means it can never get old, so
 *      rule 2 could never fire on it.
 *
 * A stale certification is never quietly treated as valid. There is no
 * implicit certification anywhere in here: the absence of an answer is a
 * missing answer, never an assumed one.
 */

export const CERTIFICATION_MAX_AGE_DAYS = 180;

/* Stamped into every certification. If the questions ever change, an old
   certification can still be read for exactly what it was: answers to the
   questions we were asking then. */
export const QUESTION_SET_VERSION = "1";

/* Carried in the fingerprint itself, so a future change to how fingerprints
   are computed can never compare equal to an old one and silently keep a
   certification alive that nothing has actually re-confirmed. */
const FINGERPRINT_VERSION = "sch1";

const DAY_MS = 86400000;

/* A laptop whose clock is a few minutes fast must not lose its coverage the
   moment it certifies. A certification dated next year must not buy itself a
   year of never expiring. Ten minutes separates those two cases. */
const CLOCK_GRACE_MS = 10 * 60000;

/* ------------------------------------------------------------- questions */

/* The questions, in the founder's words. Two of them (past_due, paused) are
   the ones policy.mjs already refuses to decide on the merchant's behalf. The
   others exist because they are the most common causes of a false accusation:
   a refund that meant "sorry about that month", an account that was always
   meant to be free, and a customer still sitting at the checkout page.

   Every question carries its own `why`. A founder who does not understand why
   they are being asked will pick whatever is on the left, and then the rules
   Akeso runs on are noise.

   `topic` is how the question is named back to a founder in a report. Printing
   the id instead puts `first_payment_incomplete` in front of someone who was
   promised plain English. */
export const CERTIFICATION_QUESTIONS = [
  {
    id: "past_due",
    topic: "a card that failed",
    question: "A customer's card fails and Stripe starts retrying it. Until the retries run out, should that customer keep using your product?",
    options: [
      { value: "keep", label: "Keep their access while Stripe retries the card" },
      { value: "end", label: "End their access as soon as a payment fails" },
    ],
    default: "keep",
    why: "Most failed payments are an expired card, and most of them go through on a retry. Stripe does not decide this one for you, so if Akeso does not have your answer it cannot tell your own grace period apart from money leaking.",
  },
  {
    id: "paused",
    topic: "a paused subscription",
    question: "A subscription is paused, so Stripe has stopped collecting money for it. Should the customer keep access while it is paused?",
    options: [
      { value: "keep", label: "Yes, keep their access while the subscription is paused" },
      { value: "end", label: "No, access should stop while they are not being charged" },
    ],
    default: "end",
    why: "Pausing usually means the customer asked for a break, and some products keep the lights on during one. This is your call, not Stripe's, and getting it wrong in either direction produces alarms about customers who are behaving exactly as agreed.",
  },
  {
    id: "refund",
    topic: "a refund",
    question: "You refund a customer. Should the refund on its own end their access?",
    options: [
      { value: "follow_subscription", label: "No, go by the subscription. A refund on its own changes nothing." },
      { value: "end", label: "Yes, a refund means they should lose access" },
    ],
    default: "follow_subscription",
    why: "A refund can mean \"sorry about that month, stay\" or it can mean \"we are done\". Only you know which one it is in your business. Akeso reports every refund it sees, and this answer is the rule it will be judged against.",
  },
  {
    id: "no_subscription",
    topic: "accounts with no subscription",
    question: "Do you have accounts that are meant to use your product with no Stripe subscription at all, such as hand-made trials, friends, staff accounts or lifetime deals?",
    options: [
      { value: "expected", label: "Yes, some accounts are meant to have access without a subscription" },
      { value: "not_expected", label: "No, everyone with access should have a Stripe subscription" },
    ],
    default: "expected",
    why: "These accounts look identical to a leak from the outside. Akeso reports them and never removes access by itself either way, but your answer decides whether the list reads as normal or as something to go and look at.",
  },
  {
    id: "first_payment_incomplete",
    topic: "a first payment that has not finished",
    question: "Someone is part-way through their first payment and it has not completed yet. Should Akeso judge that account?",
    options: [
      { value: "no_conclusion", label: "No, leave them alone until the payment settles" },
      { value: "treat_as_not_paying", label: "Yes, treat an unfinished first payment as not paying" },
    ],
    default: "no_conclusion",
    why: "Stripe gives a first payment 23 hours to complete. Anything Akeso concludes inside that window is about a customer who is still at the checkout page, and most of those findings fix themselves within the hour.",
  },
];

const questionById = (id) => CERTIFICATION_QUESTIONS.find((question) => question.id === id) || null;

/* ---------------------------------------------------------------- policy */

/* Turns the founder's answers into the policy object the rest of the product
   already runs on. DEFAULT_POLICY is extended, never re-stated: the status
   table lives in policy.mjs and having a second copy of it here is how the
   two would eventually disagree. */
export function buildPolicy(answers = {}) {
  const chosen = {};
  const defaulted = [];

  /* Anything that is not a set of answers is refused rather than read as an
     empty set of answers. A caller that passed the wrong thing would otherwise
     certify Akeso's suggestions under the founder's name. */
  if (answers !== null && answers !== undefined && (typeof answers !== "object" || Array.isArray(answers))) {
    throw new Error(`Answers must be given as a set of question ids and the answer to each, for example { past_due: "keep" }.`);
  }

  /* A misspelled question id is a lost answer, not an unanswered question. The
     founder who typed `past_dues: "end"` would otherwise be told, in writing,
     that they left that question at Akeso's suggestion and that access
     continues while a card is failing. */
  for (const id of Object.keys(answers || {})) {
    if (!questionById(id)) {
      throw new Error(`"${id}" is not one of the questions Akeso asks. The questions are: ${CERTIFICATION_QUESTIONS.map((question) => question.id).join(", ")}.`);
    }
  }

  for (const question of CERTIFICATION_QUESTIONS) {
    const given = answers?.[question.id];
    if (given === undefined || given === null || given === "") {
      chosen[question.id] = question.default;
      defaulted.push(question.id);
      continue;
    }
    /* An answer we do not recognise is never rounded to the nearest one we do.
       Silently defaulting a typo would certify rules the founder never gave. */
    if (!question.options.some((option) => option.value === given)) {
      throw new Error(`"${given}" is not one of the answers to "${question.id}". The answers are: ${question.options.map((option) => option.value).join(", ")}.`);
    }
    chosen[question.id] = given;
  }

  return {
    ...DEFAULT_POLICY,
    entitledWhilePastDue: chosen.past_due === "keep",
    entitledWhilePaused: chosen.paused === "keep",
    neverConclude: chosen.first_payment_incomplete === "no_conclusion" ? ["incomplete"] : [],
    /* Carried, not acted on by the sweep: nothing in Akeso removes access on a
       refund by itself. It is the rule a refund gets reported against. */
    refundEndsAccess: chosen.refund === "end",
    expectAccountsWithNoSubscription: chosen.no_subscription === "expected",
    answers: chosen,
    /* Which answers the founder never actually gave. A report that cannot say
       "you told us this" versus "we assumed this" is not evidence. */
    defaulted,
    questionSetVersion: QUESTION_SET_VERSION,
    /* A short name for exactly these answers, so a finding read back next month
       can be tied to the rules that produced it.
       It is deliberately NOT `ruleVersion`. `ruleVersion` is a shared contract
       value: the generated adapter exports AKESO_RULE_VERSION, and both
       restoreBillingEntitlement and the restore endpoint refuse any request
       whose ruleVersion is not equal to it. A version invented here from the
       founder's answers would not match the constant in their app, and every
       restore would come back "conflict" — including the grants that let a
       paying customer back in. So the answers get their own field and the
       contract value is left alone for the founder to bump. */
    rulesFingerprint: rulesFingerprintFor(chosen),
  };
}

function rulesFingerprintFor(chosen) {
  const material = JSON.stringify(CERTIFICATION_QUESTIONS.map((question) => [question.id, chosen[question.id]]));
  return `rules_${createHash("sha256").update(material).digest("hex").slice(0, 8)}`;
}

/* ------------------------------------------------------------ the schema */

/* A short stable name for the shape of the app's billing state.
 *
 * The whole point is staleness detection: a certification says "these rules,
 * read from this table and this column". If the founder renames the column or
 * moves the flag to another table, every verdict after that was reached by
 * reading something nobody ever certified. Comparing fingerprints is how that
 * gets noticed instead of quietly producing wrong findings for a month. */
export function fingerprintSchema({ table, column, accountColumn, extraFields = [] } = {}) {
  const clean = (value) => String(value ?? "").trim().toLowerCase();
  const tableName = clean(table);
  const entitledColumn = clean(column);

  /* A fingerprint over nothing would match every schema forever, which is
     worse than having no fingerprint at all. */
  if (!tableName || !entitledColumn) {
    throw new Error("A schema fingerprint needs at least the table and the column that holds billing access. Without them it would match any schema and no change could ever be noticed.");
  }

  const list = Array.isArray(extraFields) ? extraFields : [extraFields];
  /* Sorted and de-duplicated: the order fields happen to be listed in is not a
     change to the customer's schema, and treating it as one would demand a
     re-certification every time a config file got tidied. */
  const extras = [...new Set(list.map(clean).filter(Boolean))].sort();

  const material = JSON.stringify([tableName, entitledColumn, clean(accountColumn), extras]);
  return `${FINGERPRINT_VERSION}_${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

/* --------------------------------------------------------------- certify */

/* Writes the certification to the ledger. This is the only thing that turns
   coverage on, and it is an append like everything else: re-certifying later
   adds an entry, and the newest one is what is in force. */
export async function certify(root, { policy, priceToPlan = {}, schemaFingerprint, adapterVersion = null, notes = null, certifiedAt = new Date().toISOString() } = {}) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Certification needs the rules the founder confirmed. Build them with buildPolicy(answers).");
  }
  for (const key of ["entitledWhilePastDue", "entitledWhilePaused", "ruleVersion"]) {
    if (!(key in policy)) throw new Error(`These rules are missing "${key}", so Akeso cannot say what it would be judging by. Build them with buildPolicy(answers).`);
  }
  /* Without a fingerprint the certification could never go stale, so a schema
     change would silently keep passing as certified. Refusing here is the
     whole staleness guarantee. */
  if (!schemaFingerprint || typeof schemaFingerprint !== "string") {
    throw new Error("Certification needs a schema fingerprint from fingerprintSchema(). Without one, a change to your billing table could never make this certification stale.");
  }
  if (!priceToPlan || typeof priceToPlan !== "object" || Array.isArray(priceToPlan)) {
    throw new Error("priceToPlan must be a map of Stripe price ids to the plan names you use, for example { price_123: \"Pro\" }.");
  }
  for (const [priceId, planName] of Object.entries(priceToPlan)) {
    if (!priceId.trim()) {
      throw new Error(`One of the Stripe price ids in this map is blank, and its plan name is "${String(planName)}". Akeso cannot tell which price you meant.`);
    }
    if (typeof planName !== "string" || !planName.trim()) {
      throw new Error(`The plan name for "${priceId}" is empty. Akeso will not invent a name for a plan you sell.`);
    }
  }
  /* The ledger is append-only, so a date written here can never be corrected,
     only superseded. A date Akeso cannot read leaves the certification unusable
     forever; a date in the future would postpone its expiry by however far into
     the future it was set. Both are refused before anything is written. */
  const certifiedMs = typeof certifiedAt === "string" ? Date.parse(certifiedAt) : Number.NaN;
  if (!Number.isFinite(certifiedMs)) {
    throw new Error(`"${String(certifiedAt)}" is not a date Akeso can read. Use a full timestamp such as 2026-08-31T09:15:00.000Z.`);
  }
  if (certifiedMs > Date.now() + CLOCK_GRACE_MS) {
    throw new Error("This certification is dated in the future, so Akeso cannot say how old it is or when to ask you to confirm the rules again. Check the clock on this machine.");
  }

  return appendEntry(root, {
    kind: "certify",
    certifiedAt,
    policy,
    priceToPlan,
    schemaFingerprint,
    adapterVersion,
    notes,
    questionSetVersion: QUESTION_SET_VERSION,
  });
}

/* ---------------------------------------------------------------- status */

/* Rules Akeso can actually read: an object that answers, in so many words, the
   two questions policy.mjs refuses to answer on the merchant's behalf. */
function readableRules(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  return typeof policy.entitledWhilePastDue === "boolean" && typeof policy.entitledWhilePaused === "boolean";
}

/* Folds the ledger into the certification in force right now, and says
   plainly whether it still counts. Never mutates anything: the newest
   `certify` entry wins, older ones stay exactly as they were written. */
export function certificationStatus(entries = [], { schemaFingerprint = null, now = Date.now() } = {}) {
  const all = entries || [];
  const entry = lastOfKind(all, "certify");

  /* A line the ledger could not parse might have been a newer certification.
     Only the unreadable lines that come after the certification in force can
     change the answer: anything unreadable before it was superseded anyway. */
  const couldNotRead = (entry ? all.slice(all.lastIndexOf(entry) + 1) : all)
    .some((row) => row?.kind === "unreadable");

  if (!entry) {
    /* Not certified is not a stale certification, and it is not a failure
       either. It is simply an app that nobody has turned coverage on for. */
    return {
      certified: false, at: null, policy: null, priceToPlan: null,
      schemaFingerprint: null, adapterVersion: null, notes: null,
      ageDays: null, stale: false, staleCode: null, staleReason: null,
      couldNotRead,
    };
  }

  const at = entry.certifiedAt || entry.at || null;
  const base = {
    certified: true,
    at,
    policy: entry.policy || null,
    priceToPlan: entry.priceToPlan || null,
    schemaFingerprint: entry.schemaFingerprint || null,
    adapterVersion: entry.adapterVersion ?? null,
    notes: entry.notes ?? null,
    ageDays: null,
    couldNotRead,
  };
  const stale = (staleCode, staleReason) => ({ ...base, stale: true, staleCode, staleReason });

  /* A certification whose rules cannot be read is not rules. Only a
     hand-edited ledger produces this, since certify() refuses to write it, and
     it has to fail closed: an entry carrying `policy: "keep"` would otherwise
     read as covered while every rule in it came out undefined, which the engine
     reads as "not entitled" for every customer whose card is being retried. */
  if (!readableRules(base.policy)) {
    /* The unreadable value is not passed on. A caller that reaches for
       `status.policy` would otherwise hand a sweep something shaped like rules
       whose every answer reads as undefined, which the engine takes as "not
       entitled". Null sends it to the documented default instead. */
    return { ...stale("no_rules_recorded", "This certification does not record the rules that were confirmed in a form Akeso can read, so it cannot say what it would be judging your customers by."), policy: null };
  }

  /* Not being able to read part of the record is our failure, not the app's,
     and the wording says so. It still stops coverage, because the line Akeso
     could not read may have been a newer set of rules. */
  if (couldNotRead) {
    return stale("ledger_unreadable", "Akeso could not read part of this app's own record, and the unreadable part was written after this certification, so it cannot tell whether newer rules were confirmed since.");
  }

  /* The schema is checked before the age, because reading the wrong column is
     the more dangerous of the two failures. */
  if (!schemaFingerprint) {
    /* Not knowing is never the same as matching. If Akeso cannot confirm the
       app still stores billing access where it was certified, coverage is not
       something it can honestly claim. This is our own inability, and the
       wording says so rather than blaming the app. */
    return stale("schema_unverified", "Akeso could not read this app's billing table on this run, so it cannot confirm the rules you certified still apply to it.");
  }
  if (base.schemaFingerprint !== schemaFingerprint) {
    return stale("schema_changed", "The table or column your app keeps billing access in is not the one you certified.");
  }

  const certifiedMs = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(certifiedMs)) {
    return stale("age_unknown", "Akeso cannot tell when this certification was made, so it cannot tell whether it is still current.");
  }
  /* A certification dated ahead of the clock never gets older, so the 180 day
     rule would never fire on it. A ledger dated next year would buy itself a
     year of unearned coverage, which is a pass for exactly the wrong reason. */
  if (certifiedMs > now + CLOCK_GRACE_MS) {
    return stale("dated_in_future", `This certification is dated ${at.slice(0, 10)}, which is ahead of this machine's clock, so Akeso cannot tell how old it is.`);
  }

  /* Clamped at zero so a clock a few seconds out never shows a founder an age
     of minus one days. */
  const ageDays = Math.max(0, Math.floor((now - certifiedMs) / DAY_MS));
  if (ageDays > CERTIFICATION_MAX_AGE_DAYS) {
    return { ...base, ageDays, stale: true, staleCode: "expired", staleReason: `These rules were confirmed ${ageDays} days ago, which is more than ${CERTIFICATION_MAX_AGE_DAYS} days.` };
  }

  return { ...base, ageDays, stale: false, staleCode: null, staleReason: null };
}

/* ----------------------------------------------------------- the reading */

/* The plain-English name of a question, for a report. Falls back to the id
   rather than inventing a name for a question this version does not know. */
const topicFor = (id) => questionById(id)?.topic || id;

/* Each confirmed answer as one sentence a founder can check against what they
   meant. Read from the policy, not from the answers list, because the policy
   is what the engine will actually run on: if the two ever disagreed, the
   founder needs to see the one that decides. */
function confirmedRules(policy) {
  const unrecorded = "this certification does not record an answer, so Akeso reports it and changes nothing.";
  const answered = (value, whenTrue, whenFalse) =>
    (typeof value === "boolean" ? (value ? whenTrue : whenFalse) : unrecorded);

  return [
    `A card fails and Stripe is retrying it: ${policy.entitledWhilePastDue ? "the customer keeps access while Stripe retries." : "access ends as soon as a payment fails."}`,
    `A subscription is paused: ${policy.entitledWhilePaused ? "access continues while collection is paused." : "access stops while collection is paused."}`,
    `A refund on its own: ${answered(policy.refundEndsAccess, "it ends access.", "it changes nothing. Access follows the subscription.")}`,
    `Accounts with no Stripe subscription at all: ${answered(policy.expectAccountsWithNoSubscription, "expected, so they are listed and left alone.", "not expected, so they are listed for you to look at.")}`,
    `A first payment that has not finished: ${(policy.neverConclude || []).includes("incomplete") ? "not judged either way until it settles." : "treated as not paying."}`,
  ];
}

/* What the founder actually reads. Whether Akeso is covering this app right
   now, since when, under which rules, and if it is not, the one thing to do
   about it.
 *
 * It is given the certification status and nothing else on purpose. A ledger
 * that starts a year before the certification must never be able to leak an
 * earlier date into a coverage claim, and the cleanest way to guarantee that
 * is to make the earlier date unreachable from here. */
export function coverageStatement(status) {
  if (!status || !status.certified) {
    const whatToDoNext = "Run npx akeso-check certify to answer them and turn coverage on.";
    const lines = [
      "Akeso is not covering this app yet.",
      "Nothing is being watched, and nothing here is a verdict about your billing.",
      `Coverage starts when you confirm the rules Akeso should judge your customers by. There are ${CERTIFICATION_QUESTIONS.length} questions, each in plain English, and each one says why it is being asked.`,
      /* If part of the record was unreadable, "you have not certified" is a
         claim Akeso cannot support. Answering again is still the right move,
         so the next step does not change; only the honesty of the sentence
         above it does. */
      ...(status?.couldNotRead
        ? ["Akeso could not read part of this app's own record, so if you did confirm the rules before, that record cannot be read now."]
        : []),
      whatToDoNext,
    ];
    return { covered: false, since: null, certifiedAt: null, headline: lines[0], lines, whatToDoNext, text: lines.join("\n") };
  }

  const day = (status.at || "").slice(0, 10);

  /* A status that says certified but carries no readable rules or no readable
     date cannot come out of certificationStatus, only out of a caller that
     built one by hand. It is read as "not covering" rather than allowed to
     throw halfway through printing, because a printer that dies takes the
     command's own findings down with it. */
  const unusable = !readableRules(status.policy) || !Number.isFinite(Date.parse(status.at));

  if (status.stale || unusable) {
    /* Re-answering the questions fixes a certification that went stale. It
       fixes nothing when the reason is that Akeso could not find the billing
       table on this run, so that case gets the step that actually helps
       instead of handing our own failure back to the founder as homework. */
    const whatToDoNext = status.staleCode === "schema_unverified"
      ? "Run this again from the folder your app's code is in, so Akeso can find your billing table. If it still cannot find it, run npx akeso-check certify to point it at the right one."
      : "Run npx akeso-check certify to confirm the rules again. Coverage restarts the moment you do.";
    const lines = [
      "Akeso is not covering this app right now.",
      day ? `You confirmed the rules on ${day}.` : "The date those rules were confirmed was not recorded.",
      status.staleReason || (unusable
        ? "Akeso could not read what was confirmed, so it will not say what it would be judging your customers by."
        : "Those rules can no longer be shown to apply."),
      /* Deliberately no claim about the period in between. We do not know when
         the schema moved, so saying "you were covered until then" would be a
         number nobody measured. */
      "Akeso will not judge your customers under rules it cannot prove still apply, so it has stopped rather than guessed.",
      whatToDoNext,
    ];
    return { covered: false, since: null, certifiedAt: status.at || null, headline: lines[0], lines, whatToDoNext, text: lines.join("\n") };
  }

  const policy = status.policy;
  /* About, not exactly. Staleness is measured from an instant and this line is
     a date, so the two can differ by part of a day. "180 days" is the rule and
     the date is the reading of it, which is the honest way round. */
  const expiresOn = new Date(Date.parse(status.at) + CERTIFICATION_MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const mapped = Object.keys(status.priceToPlan || {}).length;
  /* Certification turns coverage on. It does not start a sweep, and this module
     has no way to know whether one is scheduled, so it does not say one is. */
  const whatToDoNext = "Nothing to do here. These are the rules every sweep from now on will judge your customers by.";

  const lines = [
    `Akeso is covering this app. Coverage started on ${day}.`,
    /* The one sentence this whole module exists to make true. */
    `Akeso was not watching before ${day} and makes no claim about anything that happened then.`,
    "",
    /* Every answer, in the founder's words, whether or not describePolicy
       happens to mention it. describePolicy names a status only when it falls
       on one particular side: a founder who said "end access when a card
       fails" is not listed under either heading, so their own answer was
       nowhere in this statement. A rule a founder cannot see is a rule they
       cannot correct, and it is the rule Akeso will act on. */
    "The rules you confirmed:",
    ...confirmedRules(policy).map((line) => `  ${line}`),
    "  Akeso never removes access on its own. Anything that would end a customer's access waits for you to approve it.",
    "",
    "The same rules again, in Stripe's own words:",
    ...describePolicy(policy).map((line) => `  ${line}`),
    "",
    mapped
      ? `${mapped} Stripe price ${mapped === 1 ? "id is" : "ids are"} mapped to your plan names.`
      : "No Stripe price ids are mapped to plan names, so Akeso will call plans by their price id.",
    (policy.defaulted || []).length
      ? `${policy.defaulted.length} of the ${CERTIFICATION_QUESTIONS.length} questions were left at Akeso's suggested answer: ${policy.defaulted.map(topicFor).join(", ")}.`
      : "Every question was answered by you. None of these rules is an Akeso assumption.",
    `These rules stand for ${CERTIFICATION_MAX_AGE_DAYS} days, so until about ${expiresOn}. After that Akeso stops covering this app until you confirm them again, because billing rules drift quietly.`,
    whatToDoNext,
  ];

  return { covered: true, since: status.at, certifiedAt: status.at, headline: lines[0], lines, whatToDoNext, text: lines.join("\n") };
}

/* The question a founder is being asked, with its own reason attached. Kept
   here so a command never has to re-word a question and accidentally change
   what was certified. */
export function describeQuestion(id) {
  const question = questionById(id);
  if (!question) return null;
  return {
    ...question,
    defaultLabel: question.options.find((option) => option.value === question.default)?.label || null,
  };
}
