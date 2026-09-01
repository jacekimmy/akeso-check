import { appendEntry } from "./ledger.mjs";

/* Rule precision: Akeso measuring whether its own alerts tell the truth.
 *
 * The finding this file exists for: an alert that is right less than half the
 * time is worse than no alert. People mute it, and a muted monitor is worth
 * nothing. So every rule that is allowed to interrupt a founder has to earn
 * the interruption, and the only honest way to know whether it has is to ask
 * the founder whether the alert was real and to count the answers.
 *
 * Three rules run through everything here, and each exists because of a way
 * this kind of measurement normally goes wrong:
 *
 *   1. A rule nobody has judged has NO precision. Not 1.0 because it is ours,
 *      not 0.0 because it is untested. Null, and it says so out loud. An
 *      invented accuracy is the first lie a product like this tells.
 *   2. Silence is never applied on an unmeasured basis. An unproven rule keeps
 *      alerting and admits it is unproven. Only a rule measured wrong more
 *      often than right is taken out of the founder's inbox.
 *   3. Nothing is dropped quietly. A held-back alert still goes to the record,
 *      carrying the measured number that held it back.
 *
 * Standing is a fold over the ledger, never a flag written somewhere. The
 * judgements are appended and the standing is derived at read time, which is
 * what makes a demotion reversible without anything having to be un-set.
 */

/* Below this many judgements a rule has an opinion about itself, not a
   measurement. Five is small, deliberately: the cost of leaving a bad rule
   alerting for five findings is annoyance, and the cost of muting a good rule
   on one grumpy dismissal is a missed lockout. */
export const MINIMUM_JUDGED = 5;

/* The two lines that decide a rule's fate, kept as whole numbers on purpose.
   A rule sitting exactly on a line must land on the documented side every
   single time, and floating point division decides ties by rounding luck.
   Cross-multiplying whole numbers cannot. */
export const TRUSTED_AT = { confirmed: 9, judged: 10 };   /* precision 0.9 */
export const ON_NOTICE_AT = { confirmed: 1, judged: 2 };  /* precision 0.5 */

const VERDICTS = ["confirmed", "dismissed"];

/* ------------------------------------------------------------- recording */

/* One judgement from the founder about one finding. "confirmed" means the
   alert was real, "dismissed" means it was a false alarm.

   Both refusals below are deliberate. A judgement with no rule name teaches
   nothing and would sit in the ledger looking like evidence, and a verdict we
   do not recognise must never be quietly filed as a dismissal, because that
   would let a typo demote a working rule. */
export async function recordFeedback(root, { findingId = null, rule, account = null, verdict, note = null }) {
  if (!rule) {
    throw new Error(`Feedback has to say which rule it is about. Without that Akeso cannot tell which of its checks was right, so the judgement was not recorded.`);
  }
  if (!VERDICTS.includes(verdict)) {
    throw new Error(`"${verdict ?? "nothing"}" is not a verdict Akeso can count, so nothing was recorded. Use "confirmed" if the alert was real, or "dismissed" if it was a false alarm.`);
  }
  return appendEntry(root, { kind: "feedback", findingId, rule, account, verdict, note });
}

/* ------------------------------------------------------------- measuring */

/* Fold the whole history into one row per rule.
 *
 * One finding gets one judgement. A founder who judges the same finding twice
 * has changed their mind, not produced two pieces of evidence, so the later
 * entry replaces the earlier one. Counting both is how a single argued-about
 * finding quietly demotes a rule. */
export function rulePrecision(entries = []) {
  /* Oldest first is what readLedger returns and what "later wins" depends on.
     Sorting by seq costs nothing and stops a reversed array from silently
     inverting every superseded judgement. */
  const feedback = entries
    .filter((entry) => entry?.kind === "feedback")
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));

  const winnerAt = new Map();
  feedback.forEach((entry, index) => {
    /* A judgement with no finding id can never be superseded, because nothing
       identifies what it was about. It counts once, on its own. */
    winnerAt.set(entry.findingId ?? `unidentified:${entry.seq ?? index}`, index);
  });
  const winners = new Set(winnerAt.values());

  const buckets = new Map();
  const bucketFor = (rule) => {
    if (!buckets.has(rule)) buckets.set(rule, { rule, confirmed: 0, dismissed: 0, superseded: 0, unrecognised: 0 });
    return buckets.get(rule);
  };

  feedback.forEach((entry, index) => {
    const bucket = bucketFor(entry.rule ?? "(rule not named)");
    if (!winners.has(index)) { bucket.superseded += 1; return; }
    if (entry.verdict === "confirmed") bucket.confirmed += 1;
    else if (entry.verdict === "dismissed") bucket.dismissed += 1;
    /* Not a verdict we understand. Counted where it can be seen, never folded
       into either side, because a guess here changes a real standing. */
    else bucket.unrecognised += 1;
  });

  return [...buckets.values()]
    .map((bucket) => {
      const judged = bucket.confirmed + bucket.dismissed;
      return {
        ...bucket,
        judged,
        /* Null, never a default. A caller that reads null as zero would demote
           every rule the day it ships. */
        precision: judged > 0 ? bucket.confirmed / judged : null,
        /* Says out loud whether the number above is a measurement at all. */
        verdictKnown: judged > 0,
      };
    })
    .sort((left, right) => left.rule.localeCompare(right.rule));
}

/* ------------------------------------------------------------- standings */

/* What Akeso is allowed to do with a rule, given what it has measured.
 *
 * "unproven" is a real answer, not a missing one: too few judgements to know.
 * It is neither trusted nor demoted, and the difference matters, because
 * demoting on no evidence silences a rule that may be the only thing standing
 * between a paying customer and a lockout. */
export function ruleStanding(stats, { minimumJudged = MINIMUM_JUDGED } = {}) {
  const judged = stats?.judged ?? 0;
  const confirmed = stats?.confirmed ?? 0;

  /* Zero judgements is unproven whatever the minimum is set to. A precision of
     null can never be read as good or bad. */
  if (judged === 0 || judged < minimumJudged) return "unproven";
  if (confirmed * TRUSTED_AT.judged >= judged * TRUSTED_AT.confirmed) return "trusted";
  if (confirmed * ON_NOTICE_AT.judged >= judged * ON_NOTICE_AT.confirmed) return "on_notice";
  return "demoted";
}

/* The bridge between the measurement and the decision: every measured rule
   with its standing attached, ready for applyStandings and the report. */
export function standingsFor(stats, { minimumJudged = MINIMUM_JUDGED } = {}) {
  return asRows(stats).map((row) => ({
    ...row,
    minimumJudged,
    standing: ruleStanding(row, { minimumJudged }),
  }));
}

/* ---------------------------------------------------------- applying them */

/* Split the sweep's alerts into what reaches a human and what is held back.
 *
 * A demoted rule's alerts are not deleted and not forgotten. They are returned
 * in `demoted`, each carrying the measured accuracy that held it back, so the
 * caller writes them to the ledger. Every alert that goes in comes out on one
 * side or the other; an alert that vanished silently would be exactly the bug
 * this whole file is meant to prevent. */
export function applyStandings(alerts = [], standings = []) {
  const byRule = new Map(asRows(standings).map((row) => [row.rule, row]));
  const deliver = [];
  const demoted = [];

  for (const alert of alerts) {
    const rule = alert?.rule ?? null;
    const row = rule === null ? null : byRule.get(rule) ?? null;
    const standing = row?.standing ?? ruleStanding(row);

    if (standing === "demoted") {
      demoted.push({
        alert,
        rule,
        standing,
        precision: row?.precision ?? null,
        confirmed: row?.confirmed ?? 0,
        dismissed: row?.dismissed ?? 0,
        judged: row?.judged ?? 0,
        reason: heldBackReason(row),
      });
      continue;
    }

    const note = deliveryNote(row, standing);
    deliver.push({
      ...alert,
      standing,
      /* Carried forward unmeasured rather than absent, so a caller printing
         this cannot mistake "we did not measure it" for "it is fine". */
      precision: row?.precision ?? null,
      judged: row?.judged ?? 0,
      ...(note ? { precisionNote: note } : {}),
    });
  }

  return { deliver, demoted };
}

/* ---------------------------------------------------------- the report */

/* Plain English, one line per rule: how often it was right, and what Akeso did
   about it. Ordered so the rules that need a human eye come first. */
const ATTENTION_ORDER = { demoted: 0, on_notice: 1, unproven: 2, trusted: 3 };

export function precisionReport(stats, { minimumJudged = MINIMUM_JUDGED } = {}) {
  const rows = standingsFor(stats, { minimumJudged });
  if (!rows.length) {
    return ["No alert has been judged yet, so Akeso does not claim an accuracy for any of its rules."];
  }

  const lines = [];
  for (const row of [...rows].sort(byAttention)) {
    const name = `The "${row.rule}" rule`;

    if (row.standing === "unproven") {
      /* No percentage here, ever. A percentage from one or two judgements
         reads like a measurement and is not one. */
      lines.push(`${name}: not enough judgements yet (${row.judged} of ${minimumJudged} needed). It keeps alerting you, and says it is unproven until it has been judged enough times.`);
    } else if (row.standing === "trusted") {
      lines.push(`${name}: right ${timesRight(row)} (${percentOf(row)} percent). Trusted, so its alerts come straight to you.`);
    } else if (row.standing === "on_notice") {
      lines.push(`${name}: right ${timesRight(row)} (${percentOf(row)} percent). On notice. Akeso keeps sending these to you and keeps counting. It stops sending them if the rule drops below half right.`);
    } else {
      lines.push(`${name}: right only ${timesRight(row)} (${percentOf(row)} percent). Demoted, so its alerts now go to the record only. It starts reaching you again as soon as it is right more than half the time.`);
    }

    if (row.superseded > 0) {
      lines.push(`  ${row.superseded} earlier ${plural(row.superseded, "judgement")} on this rule ${plural(row.superseded, "was", "were")} replaced by a later one, and only the later one counts.`);
    }
    if (row.unrecognised > 0) {
      lines.push(`  ${row.unrecognised} recorded ${plural(row.unrecognised, "judgement")} on this rule could not be read as confirmed or dismissed, so ${plural(row.unrecognised, "it was", "they were")} left out of the count.`);
    }
  }
  return lines;
}

/* ------------------------------------------------------------- internals */

const byAttention = (left, right) =>
  (ATTENTION_ORDER[left.standing] ?? 9) - (ATTENTION_ORDER[right.standing] ?? 9) || left.rule.localeCompare(right.rule);

/* Truncated, never rounded. "90 percent" printed next to the word "demoted"
   reads like a contradiction, and rounding up is exactly how that happens.
   Truncation can never cross the line that decided the standing. Computed from
   the two whole numbers so no float rounding creeps in either. */
const percentOf = ({ confirmed = 0, judged = 0 }) => (judged > 0 ? Math.floor((confirmed * 100) / judged) : null);

const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many);

/* "1 times out of 10" is the kind of sentence that tells a founder nobody read
   this screen before shipping it. */
const timesRight = ({ confirmed = 0, judged = 0 }) => `${confirmed} ${plural(confirmed, "time")} out of ${judged}`;

const EMPTY_ROW = {
  confirmed: 0, dismissed: 0, judged: 0, superseded: 0, unrecognised: 0,
  precision: null, verdictKnown: false,
};

/* Accepts what any caller is likely to hold: the array rulePrecision returns,
   a Map of rule to stats, a Map or object of rule to the standing word, or
   nothing at all. */
function asRows(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean).map((value) => rowFrom(value?.rule, value));
  if (input instanceof Map) return [...input.entries()].map(([rule, value]) => rowFrom(rule, value));
  if (typeof input === "object") return Object.entries(input).map(([rule, value]) => rowFrom(rule, value));
  return [];
}

function rowFrom(rule, value) {
  const name = String(value?.rule ?? rule ?? "(rule not named)");
  /* A caller who passed only the word "demoted" has told us the standing but
     not the measurement behind it, so the counts stay at zero and nothing
     downstream is allowed to quote a percentage for it. */
  if (typeof value === "string") return { ...EMPTY_ROW, rule: name, standing: value, minimumJudged: MINIMUM_JUDGED };
  const row = { ...EMPTY_ROW, minimumJudged: MINIMUM_JUDGED, ...value, rule: name };
  return { ...row, standing: row.standing ?? ruleStanding(row, { minimumJudged: row.minimumJudged }) };
}

/* Why this alert did not reach you, in the founder's words, with the number
   that decided it. Never a number we do not have. */
function heldBackReason(row) {
  if (!row || !row.judged) {
    return `Held back from your alerts because this rule is demoted. Akeso was not given the measurement behind that, so no accuracy figure is claimed here. The alert is in the record, and "monitor --precision" shows the counts.`;
  }
  return `Held back from your alerts. This rule was right only ${timesRight(row)} (${percentOf(row)} percent), which is below half right, so its alerts go to the record only. It reaches you again as soon as it is right more than half the time.`;
}

/* What a delivered alert says about the rule behind it. Trusted rules say
   nothing extra; silence is the point of being trusted. */
function deliveryNote(row, standing) {
  if (standing === "unproven") {
    const judged = row?.judged ?? 0;
    const minimum = row?.minimumJudged ?? MINIMUM_JUDGED;
    return `Akeso has not judged this rule enough times to know how often it is right (${judged} of ${minimum} needed), so treat it as unproven. Tell Akeso whether this one was real and it starts to know.`;
  }
  if (standing === "on_notice") {
    return `This rule has been right ${timesRight(row)} (${percentOf(row)} percent). Akeso is still sending it, and still counting.`;
  }
  return null;
}
