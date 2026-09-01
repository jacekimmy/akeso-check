import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MINIMUM_JUDGED,
  applyStandings,
  precisionReport,
  recordFeedback,
  rulePrecision,
  ruleStanding,
  standingsFor,
} from "../src/precision.mjs";
import { readLedger, verifyLedger } from "../src/ledger.mjs";

/* This module is allowed to stop an alert from reaching a human. Every test
   here is a rule standing between it and a silenced warning that was true. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-precision-"));

let nextSeq = 0;
/* Ledger-shaped feedback without the ledger, so the pure fold can be tested
   without touching a disk. */
function feedback(rule, { confirmed = 0, dismissed = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < confirmed; i += 1) rows.push({ kind: "feedback", seq: (nextSeq += 1), rule, findingId: `${rule}-c${nextSeq}`, verdict: "confirmed" });
  for (let i = 0; i < dismissed; i += 1) rows.push({ kind: "feedback", seq: (nextSeq += 1), rule, findingId: `${rule}-d${nextSeq}`, verdict: "dismissed" });
  return rows;
}

const statsFor = (rule, counts) => rulePrecision(feedback(rule, counts))[0];
const alert = (rule, title = "something happened") => ({ level: "urgent", rule, title, whatHappensNext: "Akeso tells you." });

/* --------------------------------------------------- nothing measured yet */

test("a rule with no feedback at all never gets a precision number", () => {
  assert.deepEqual(rulePrecision([]), [], "no judgements means no rows, not a row full of zeroes");

  const stats = statsFor("locked_out", { confirmed: 0, dismissed: 0 });
  assert.equal(stats, undefined, "a rule nobody judged does not appear at all");
});

test("an unjudged rule is never defaulted to right or to wrong", () => {
  /* A superseding entry can leave a rule present with nothing counted. Its
     precision must still be null. */
  const entries = [
    { kind: "feedback", seq: 1, rule: "orphan", findingId: "f1", verdict: "not a verdict" },
  ];
  const stats = rulePrecision(entries)[0];
  assert.equal(stats.precision, null, "precision is null, never 1.0 because it is ours and never 0.0 because it is untested");
  assert.equal(stats.verdictKnown, false, "the row says out loud that nothing was measured");
  assert.equal(stats.judged, 0);
  assert.equal(stats.unrecognised, 1, "the unreadable verdict is visible, not silently discarded");
});

test("a rule with no feedback is neither trusted nor demoted", () => {
  assert.equal(ruleStanding(null), "unproven");
  assert.equal(ruleStanding(undefined), "unproven");
  assert.equal(ruleStanding({ confirmed: 0, dismissed: 0, judged: 0, precision: null }), "unproven");
});

test("a rule judged wrong every time but too few times is unproven, never demoted", () => {
  const stats = statsFor("noisy", { confirmed: 0, dismissed: MINIMUM_JUDGED - 1 });
  assert.equal(stats.precision, 0, "the measurement is real as far as it goes");
  assert.equal(ruleStanding(stats), "unproven", "four false alarms is a suspicion, not a measurement");
});

test("the minimum number of judgements is where a verdict becomes possible", () => {
  assert.equal(ruleStanding(statsFor("a", { confirmed: 0, dismissed: MINIMUM_JUDGED - 1 })), "unproven");
  assert.equal(ruleStanding(statsFor("b", { confirmed: 0, dismissed: MINIMUM_JUDGED })), "demoted");
});

test("zero judgements stays unproven even when the minimum is set to zero", () => {
  /* Otherwise a caller could switch the minimum off and demote every rule the
     day the product ships. */
  assert.equal(ruleStanding({ confirmed: 0, dismissed: 0, judged: 0 }, { minimumJudged: 0 }), "unproven");
});

/* ------------------------------------------------------------ boundaries */

test("exactly half right is on notice, not demoted", () => {
  assert.equal(ruleStanding(statsFor("half", { confirmed: 5, dismissed: 5 })), "on_notice");
  assert.equal(ruleStanding(statsFor("half-again", { confirmed: 3, dismissed: 3 })), "on_notice");
  assert.equal(ruleStanding(statsFor("half-big", { confirmed: 50, dismissed: 50 })), "on_notice");
});

test("one judgement below half right is demoted", () => {
  assert.equal(ruleStanding(statsFor("just-under", { confirmed: 4, dismissed: 6 })), "demoted");
  assert.equal(ruleStanding(statsFor("way-under", { confirmed: 49, dismissed: 51 })), "demoted");
});

test("exactly nine in ten is trusted", () => {
  assert.equal(ruleStanding(statsFor("nine", { confirmed: 9, dismissed: 1 })), "trusted");
  assert.equal(ruleStanding(statsFor("ninety", { confirmed: 90, dismissed: 10 })), "trusted");
  assert.equal(ruleStanding(statsFor("twenty-seven", { confirmed: 27, dismissed: 3 })), "trusted");
});

test("just under nine in ten is on notice, not trusted", () => {
  assert.equal(ruleStanding(statsFor("close", { confirmed: 89, dismissed: 11 })), "on_notice");
  assert.equal(ruleStanding(statsFor("eight", { confirmed: 8, dismissed: 2 })), "on_notice");
});

test("a rule right every time is trusted", () => {
  assert.equal(ruleStanding(statsFor("perfect", { confirmed: MINIMUM_JUDGED, dismissed: 0 })), "trusted");
});

test("the minimum number of judgements can be raised without changing the lines", () => {
  const stats = statsFor("small-sample", { confirmed: 2, dismissed: 8 });
  assert.equal(ruleStanding(stats, { minimumJudged: 10 }), "demoted");
  assert.equal(ruleStanding(stats, { minimumJudged: 11 }), "unproven", "a higher bar makes a rule unproven, never trusted");
});

/* ------------------------------------------------------------ the fold */

test("one finding judged twice counts once, and the later judgement wins", () => {
  const entries = [
    { kind: "feedback", seq: 1, rule: "drift", findingId: "f1", verdict: "dismissed" },
    { kind: "feedback", seq: 2, rule: "drift", findingId: "f1", verdict: "confirmed" },
  ];
  const stats = rulePrecision(entries)[0];
  assert.equal(stats.judged, 1, "changing your mind about one finding is not two pieces of evidence");
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.dismissed, 0);
  assert.equal(stats.superseded, 1, "the replaced judgement is still counted where it can be seen");
});

test("judgements without a finding id are never folded into each other", () => {
  const entries = [
    { kind: "feedback", seq: 1, rule: "drift", verdict: "confirmed" },
    { kind: "feedback", seq: 2, rule: "drift", verdict: "dismissed" },
  ];
  const stats = rulePrecision(entries)[0];
  assert.equal(stats.judged, 2, "two unidentified judgements are two judgements, not one overwriting the other");
});

test("each rule is measured on its own evidence", () => {
  const stats = rulePrecision([
    ...feedback("locked_out", { confirmed: 10, dismissed: 0 }),
    ...feedback("still_entitled", { confirmed: 1, dismissed: 9 }),
  ]);
  const byRule = Object.fromEntries(stats.map((row) => [row.rule, row]));
  assert.equal(ruleStanding(byRule.locked_out), "trusted");
  assert.equal(ruleStanding(byRule.still_entitled), "demoted");
});

test("the ledger is folded at read time, so a demotion is reversible", () => {
  /* A rule can be wrong for a month and right afterwards. Nothing is un-set;
     later judgements simply outweigh earlier ones. */
  const history = feedback("drift", { confirmed: 2, dismissed: 8 });
  assert.equal(ruleStanding(rulePrecision(history)[0]), "demoted");

  history.push(...feedback("drift", { confirmed: 20 }));
  assert.equal(ruleStanding(rulePrecision(history)[0]), "on_notice", "confirmations bring a demoted rule back");

  history.push(...feedback("drift", { confirmed: 58 }));
  const recovered = rulePrecision(history)[0];
  assert.equal(ruleStanding(recovered), "trusted");
  assert.equal(recovered.confirmed, 80);
  assert.equal(recovered.judged, 88);
});

test("a recovered rule's alerts reach the founder again", () => {
  const history = feedback("drift", { confirmed: 1, dismissed: 9 });
  assert.equal(applyStandings([alert("drift")], standingsFor(rulePrecision(history))).deliver.length, 0);

  history.push(...feedback("drift", { confirmed: 30 }));
  const after = applyStandings([alert("drift")], standingsFor(rulePrecision(history)));
  assert.equal(after.deliver.length, 1, "the same alert now reaches a human again");
  assert.equal(after.demoted.length, 0);
});

/* --------------------------------------------------------- applying them */

test("a demoted rule's alerts never reach a human", () => {
  const standings = standingsFor(rulePrecision(feedback("noisy", { confirmed: 1, dismissed: 9 })));
  const { deliver, demoted } = applyStandings([alert("noisy", "eleven accounts drifted")], standings);

  assert.equal(deliver.length, 0, "a rule wrong nine times in ten does not get to interrupt anyone");
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].alert.title, "eleven accounts drifted", "the alert itself is kept, for the record");
});

test("a held-back alert always names the measured precision that held it back", () => {
  const standings = standingsFor(rulePrecision(feedback("noisy", { confirmed: 2, dismissed: 8 })));
  const { demoted } = applyStandings([alert("noisy")], standings);

  assert.match(demoted[0].reason, /2 times out of 10/);
  assert.match(demoted[0].reason, /20 percent/);
  assert.equal(demoted[0].precision, 0.2);
  assert.match(demoted[0].reason, /reaches you again/, "the message says what happens next");
});

test("no alert is ever dropped without being recorded", () => {
  const standings = standingsFor(rulePrecision([
    ...feedback("noisy", { confirmed: 1, dismissed: 9 }),
    ...feedback("good", { confirmed: 10, dismissed: 0 }),
    ...feedback("middling", { confirmed: 6, dismissed: 4 }),
  ]));
  const alerts = [alert("noisy"), alert("good"), alert("middling"), alert("never_judged"), { level: "urgent", title: "no rule named" }];
  const { deliver, demoted } = applyStandings(alerts, standings);

  assert.equal(deliver.length + demoted.length, alerts.length, "every alert comes out one side or the other");
  for (const held of demoted) assert.ok(held.reason, "a held-back alert without a reason is a silent drop");
});

test("an alert from a rule nobody has judged is still delivered, and says it is unproven", () => {
  const { deliver, demoted } = applyStandings([alert("brand_new")], standingsFor(rulePrecision([])));

  assert.equal(demoted.length, 0, "silence is never applied on an unmeasured basis");
  assert.equal(deliver[0].standing, "unproven");
  assert.equal(deliver[0].precision, null, "an unmeasured rule carries no number");
  assert.match(deliver[0].precisionNote, /unproven/);
});

test("an alert with no rule named is delivered, never held back", () => {
  const standings = standingsFor(rulePrecision(feedback("noisy", { confirmed: 0, dismissed: 10 })));
  const { deliver, demoted } = applyStandings([{ level: "urgent", title: "Akeso stopped itself" }], standings);

  assert.equal(demoted.length, 0, "we cannot measure what is not named, so we never silence it");
  assert.equal(deliver[0].standing, "unproven");
});

test("a trusted rule's alert goes through untouched by any caveat", () => {
  const standings = standingsFor(rulePrecision(feedback("good", { confirmed: 10, dismissed: 0 })));
  const { deliver } = applyStandings([alert("good")], standings);

  assert.equal(deliver[0].standing, "trusted");
  assert.equal(deliver[0].precisionNote, undefined, "being trusted means saying nothing extra");
  assert.equal(deliver[0].title, "something happened", "the original alert is passed through intact");
});

test("an on notice rule keeps alerting and says how often it has been right", () => {
  const standings = standingsFor(rulePrecision(feedback("middling", { confirmed: 6, dismissed: 4 })));
  const { deliver } = applyStandings([alert("middling")], standings);

  assert.equal(deliver[0].standing, "on_notice");
  assert.match(deliver[0].precisionNote, /6 times out of 10/);
  assert.match(deliver[0].precisionNote, /60 percent/);
});

test("a demotion handed over with no measurement behind it never invents one", () => {
  const { demoted } = applyStandings([alert("hand_marked")], { hand_marked: "demoted" });

  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].precision, null);
  assert.doesNotMatch(demoted[0].reason, /percent/, "no accuracy figure is claimed when none was measured");
  assert.match(demoted[0].reason, /not given the measurement/);
});

test("standings can be handed over as a map as well as a list", () => {
  const stats = rulePrecision(feedback("noisy", { confirmed: 1, dismissed: 9 }));
  const asMap = new Map(stats.map((row) => [row.rule, row]));

  assert.equal(applyStandings([alert("noisy")], asMap).demoted.length, 1);
  assert.equal(applyStandings([alert("noisy")], standingsFor(stats)).demoted.length, 1);
});

/* -------------------------------------------------------------- report */

test("an unproven rule is never given a percentage", () => {
  const lines = precisionReport(rulePrecision(feedback("young", { confirmed: 1, dismissed: 1 })));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /not enough judgements yet/);
  assert.doesNotMatch(lines[0], /percent/, "two judgements is not a fifty percent accuracy, it is no measurement at all");
  assert.match(lines[0], /2 of 5 needed/);
});

test("every reported rule says what Akeso did about it", () => {
  const lines = precisionReport(rulePrecision([
    ...feedback("noisy", { confirmed: 1, dismissed: 9 }),
    ...feedback("good", { confirmed: 10, dismissed: 0 }),
    ...feedback("middling", { confirmed: 6, dismissed: 4 }),
    ...feedback("young", { confirmed: 1, dismissed: 0 }),
  ]));

  assert.equal(lines.length, 4);
  assert.match(lines.join("\n"), /Demoted, so its alerts now go to the record only/);
  assert.match(lines.join("\n"), /Trusted, so its alerts come straight to you/);
  assert.match(lines.join("\n"), /On notice/);
  assert.match(lines.join("\n"), /keeps alerting you/);
  assert.match(lines[0], /"noisy"/, "the rule needing attention is reported first");
});

test("a rule right exactly once is described in a sentence a person would write", () => {
  const stats = rulePrecision(feedback("barely", { confirmed: 1, dismissed: 9 }));
  const line = precisionReport(stats)[0];
  const { demoted } = applyStandings([alert("barely")], standingsFor(stats));

  assert.match(line, /1 time out of 10/);
  assert.doesNotMatch(line, /1 times/, "a founder reads this, and bad grammar reads as nobody having looked");
  assert.doesNotMatch(demoted[0].reason, /1 times/);
});

test("the report tells the truth when nothing has been judged", () => {
  const lines = precisionReport(rulePrecision([]));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /does not claim an accuracy/);
  assert.doesNotMatch(lines[0], /percent/);
});

test("a percentage is never rounded up across the line that decided the standing", () => {
  /* 179 right out of 200 is 89.5 percent, which is on notice and not trusted.
     Rounding would print "90 percent" next to "On notice", which reads as the
     product contradicting itself, so the figure is truncated. */
  const nearlyTrusted = precisionReport(rulePrecision(feedback("close", { confirmed: 179, dismissed: 21 })))[0];
  assert.match(nearlyTrusted, /On notice/);
  assert.match(nearlyTrusted, /89 percent/);
  assert.doesNotMatch(nearlyTrusted, /90 percent/, "a rounded figure must never claim the standing the rule did not reach");

  /* 99 out of 200 is 49.5 percent: demoted, and it must not print as 50. */
  const nearlyHalf = precisionReport(rulePrecision(feedback("halfish", { confirmed: 99, dismissed: 101 })))[0];
  assert.match(nearlyHalf, /Demoted/);
  assert.match(nearlyHalf, /49 percent/);
  assert.doesNotMatch(nearlyHalf, /50 percent/);
});

test("the report accounts for judgements it could not use", () => {
  const entries = [
    ...feedback("drift", { confirmed: 5, dismissed: 1 }),
    { kind: "feedback", seq: 900, rule: "drift", findingId: "later", verdict: "dismissed" },
    { kind: "feedback", seq: 901, rule: "drift", findingId: "later", verdict: "confirmed" },
    { kind: "feedback", seq: 902, rule: "drift", findingId: "odd", verdict: "maybe" },
  ];
  const text = precisionReport(rulePrecision(entries)).join("\n");

  assert.match(text, /replaced by a later one/);
  assert.match(text, /could not be read as confirmed or dismissed/);
});

test("nothing a founder reads carries an emoji or an em dash", () => {
  const stats = rulePrecision([
    ...feedback("noisy", { confirmed: 1, dismissed: 9 }),
    ...feedback("good", { confirmed: 10, dismissed: 0 }),
    ...feedback("middling", { confirmed: 6, dismissed: 4 }),
    ...feedback("young", { confirmed: 2, dismissed: 0 }),
  ]);
  const standings = standingsFor(stats);
  const { deliver, demoted } = applyStandings(
    ["noisy", "good", "middling", "young"].map((rule) => alert(rule)),
    standings,
  );
  const prose = [
    ...precisionReport(stats),
    ...demoted.map((row) => row.reason),
    ...deliver.map((row) => row.precisionNote).filter(Boolean),
  ];

  assert.ok(prose.length >= 6);
  for (const line of prose) {
    assert.doesNotMatch(line, /[—–]/, `an em dash reached a human: ${line}`);
    assert.doesNotMatch(line, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `an emoji reached a human: ${line}`);
  }
});

/* ------------------------------------------------------------- recording */

test("a judgement is appended to the ledger and leaves the chain intact", async () => {
  const root = await scratch();
  await recordFeedback(root, { findingId: "f1", rule: "still_entitled", account: "cus_1", verdict: "confirmed", note: "they really had cancelled" });
  await recordFeedback(root, { findingId: "f2", rule: "still_entitled", account: "cus_2", verdict: "dismissed" });

  const entries = await readLedger(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, "feedback");
  assert.equal(entries[0].verdict, "confirmed");
  assert.equal(verifyLedger(entries).intact, true, "feedback is evidence, so it lives in the same tamper-evident chain");

  const stats = rulePrecision(entries)[0];
  assert.equal(stats.judged, 2);
  assert.equal(stats.precision, 0.5);
});

test("a verdict Akeso does not understand is refused, never filed as a dismissal", async () => {
  const root = await scratch();
  await assert.rejects(
    () => recordFeedback(root, { findingId: "f1", rule: "drift", verdict: "maybe" }),
    /not a verdict Akeso can count/,
    "a typo must never be allowed to demote a working rule",
  );
  await assert.rejects(() => recordFeedback(root, { findingId: "f1", rule: "drift" }), /not a verdict Akeso can count/);
  assert.deepEqual(await readLedger(root), [], "a refused judgement leaves nothing behind");
});

test("a judgement that does not name a rule is refused", async () => {
  const root = await scratch();
  await assert.rejects(
    () => recordFeedback(root, { findingId: "f1", verdict: "confirmed" }),
    /has to say which rule/,
    "feedback that cannot be attributed teaches nothing and would sit there looking like evidence",
  );
  assert.deepEqual(await readLedger(root), []);
});

test("a judgement changes standing the next time the ledger is read", async () => {
  const root = await scratch();
  for (let i = 0; i < MINIMUM_JUDGED; i += 1) {
    await recordFeedback(root, { findingId: `f${i}`, rule: "no_subscription", verdict: "dismissed" });
  }
  const demotedNow = standingsFor(rulePrecision(await readLedger(root)));
  assert.equal(demotedNow[0].standing, "demoted");
  assert.equal(applyStandings([alert("no_subscription")], demotedNow).deliver.length, 0);

  for (let i = 0; i < MINIMUM_JUDGED + 1; i += 1) {
    await recordFeedback(root, { findingId: `g${i}`, rule: "no_subscription", verdict: "confirmed" });
  }
  const afterwards = standingsFor(rulePrecision(await readLedger(root)));
  assert.equal(afterwards[0].standing, "on_notice", "the record is appended to, never edited, and the standing follows");
  assert.equal(applyStandings([alert("no_subscription")], afterwards).deliver.length, 1);
});

test("other kinds of ledger entry are never mistaken for judgements", async () => {
  const stats = rulePrecision([
    { kind: "sweep", seq: 1, comparison: null },
    { kind: "restore", seq: 2, direction: "grant", result: "applied" },
    { kind: "unreadable", raw: "half a line" },
    ...feedback("drift", { confirmed: 1 }),
  ]);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].rule, "drift");
  assert.equal(stats[0].judged, 1);
});

/* ------------------------------------------- one rule's evidence is its own */

test("a judgement about one rule can never change another rule's count", () => {
  /* Finding ids are only unique inside the rule that raised them. Folding on
     the id alone lets one rule's feedback delete another rule's evidence and
     move its standing, which is two rules' numbers being blended. */
  const shared = [
    ...Array.from({ length: MINIMUM_JUDGED }, (_, i) => (
      { kind: "feedback", seq: i + 1, rule: "paying_but_locked_out", findingId: `f${i + 1}`, verdict: "confirmed" }
    )),
    { kind: "feedback", seq: 99, rule: "canceled_still_entitled", findingId: "f1", verdict: "dismissed" },
  ];
  const byRule = Object.fromEntries(rulePrecision(shared).map((row) => [row.rule, row]));

  assert.equal(byRule.paying_but_locked_out.judged, MINIMUM_JUDGED, "the other rule's judgement did not erase one of these");
  assert.equal(byRule.paying_but_locked_out.superseded, 0);
  assert.equal(ruleStanding(byRule.paying_but_locked_out), "trusted", "a rule right every time stays trusted whatever another rule was judged");
  assert.equal(byRule.canceled_still_entitled.judged, 1);
});

test("a blank finding id is not an identifier, so judgements are never folded into one", () => {
  /* An empty string looks like an id and identifies nothing. Treated as one it
     makes every judgement carrying it look like the same finding judged over
     and over, and all but the last disappear from the count. */
  const stats = rulePrecision([
    { kind: "feedback", seq: 1, rule: "drift", findingId: "", verdict: "confirmed" },
    { kind: "feedback", seq: 2, rule: "drift", findingId: "  ", verdict: "confirmed" },
    { kind: "feedback", seq: 3, rule: "drift", findingId: null, verdict: "confirmed" },
    { kind: "feedback", seq: 4, rule: "drift", findingId: "", verdict: "dismissed" },
  ])[0];

  assert.equal(stats.judged, 4, "four judgements are four pieces of evidence, not one");
  assert.equal(stats.superseded, 0);
  assert.equal(stats.confirmed, 3);
});

test("a finding id that looks like a made up one never collides with a judgement that has none", () => {
  const stats = rulePrecision([
    { kind: "feedback", seq: 1, rule: "drift", verdict: "confirmed" },
    { kind: "feedback", seq: 2, rule: "drift", findingId: "unidentified:1", verdict: "dismissed" },
    { kind: "feedback", seq: 3, rule: "drift", findingId: "drift anon 3", verdict: "dismissed" },
  ])[0];

  assert.equal(stats.judged, 3, "a founder cannot type a finding id that deletes someone else's judgement");
  assert.equal(stats.superseded, 0);
});

test("the same finding judged twice under the same rule still counts once", () => {
  /* The guard above must not have bought its safety by switching superseding
     off, which is the easy way to make the tests above pass. */
  const stats = rulePrecision([
    { kind: "feedback", seq: 1, rule: "drift", findingId: "f1", verdict: "dismissed" },
    { kind: "feedback", seq: 2, rule: "drift", findingId: " f1 ", verdict: "confirmed" },
  ])[0];

  assert.equal(stats.judged, 1);
  assert.equal(stats.confirmed, 1, "the later judgement wins, and spacing around an id does not make a new finding");
  assert.equal(stats.superseded, 1);
});

test("the fold takes its order from the entries, never from the array it was handed", () => {
  /* A caller holding a newest-first list must not invert every superseded
     judgement, because that changes standings without the ledger changing. */
  const history = [
    { kind: "feedback", at: "2026-01-01T00:00:00.000Z", rule: "drift", findingId: "f1", verdict: "dismissed" },
    { kind: "feedback", at: "2026-01-02T00:00:00.000Z", rule: "drift", findingId: "f1", verdict: "confirmed" },
  ];
  assert.deepEqual(rulePrecision([...history].reverse()), rulePrecision(history));
  assert.equal(rulePrecision([...history].reverse())[0].confirmed, 1, "the later judgement wins whichever end of the list it arrived on");

  const bySeq = feedback("drift", { confirmed: 3, dismissed: 1 });
  assert.deepEqual(rulePrecision([...bySeq].reverse()), rulePrecision(bySeq));
});

/* ---------------------------------------- never assert what was not measured */

test("a demotion handed over with numbers that contradict it never asserts they agree", () => {
  /* Saying "which is below half right" over nine right out of ten is Akeso
     stating something it did not measure, in the one message whose whole job
     is to justify silencing a warning. */
  const { demoted } = applyStandings([alert("hand_marked")], [
    { rule: "hand_marked", confirmed: 9, dismissed: 1, judged: 10, precision: 0.9, standing: "demoted" },
  ]);

  assert.equal(demoted.length, 1);
  assert.doesNotMatch(demoted[0].reason, /is below half right/, "a false claim about the measurement is worse than no claim");
  assert.match(demoted[0].reason, /do not agree/, "the founder is told the marking and the count disagree");
  assert.match(demoted[0].reason, /9 times out of 10/, "the number Akeso actually has is still shown");
});

test("the sentence promising a rule will come back matches the line that decides it", () => {
  /* Exactly half right is on notice and is delivered. Promising the founder
     "more than half" describes a product that does not exist. */
  const stats = rulePrecision(feedback("low", { confirmed: 2, dismissed: 8 }));
  const line = precisionReport(stats)[0];
  const { demoted } = applyStandings([alert("low")], standingsFor(stats));

  assert.match(line, /at least half the time/);
  assert.match(demoted[0].reason, /at least half the time/);
  assert.doesNotMatch(line, /more than half/);
  assert.doesNotMatch(demoted[0].reason, /more than half/);

  const exactlyHalf = standingsFor(rulePrecision(feedback("low", { confirmed: 5, dismissed: 5 })));
  assert.equal(applyStandings([alert("low")], exactlyHalf).deliver.length, 1, "and at exactly half it really does come back");
});

test("an alert that names no rule is never asked to be judged", async () => {
  /* recordFeedback refuses feedback with no rule, so asking for a judgement on
     an alert that names none asks for something Akeso would then refuse. */
  const { deliver } = applyStandings([{ level: "urgent", title: "Akeso stopped itself" }], []);

  assert.doesNotMatch(deliver[0].precisionNote, /Tell Akeso whether/);
  assert.match(deliver[0].precisionNote, /always reaches you/, "the note says what happens next, and it is true");

  const root = await scratch();
  await assert.rejects(() => recordFeedback(root, { rule: null, verdict: "confirmed" }), /has to say which rule/);
});

test("a rule name that is only spaces is refused, never filed as a rule of its own", async () => {
  const root = await scratch();
  await assert.rejects(
    () => recordFeedback(root, { findingId: "f1", rule: "   ", verdict: "confirmed" }),
    /has to say which rule/,
    "a rule of spaces would be measured forever and never match an alert",
  );
  assert.deepEqual(await readLedger(root), []);
});

test("a blank finding id is never written to the ledger as though it identified something", async () => {
  const root = await scratch();
  await recordFeedback(root, { findingId: "  ", rule: "drift", verdict: "confirmed" });
  await recordFeedback(root, { findingId: "", rule: "drift", verdict: "confirmed" });

  const entries = await readLedger(root);
  assert.equal(entries[0].findingId, null, "a blank is recorded as no id at all, so it can never fold two findings together");
  assert.equal(rulePrecision(entries)[0].judged, 2);
});

test("nothing Akeso could not read is turned into a verdict about the founder's rules", () => {
  /* Our own missing input is our failure. It must come back as no measurement,
     never as a crash in the middle of a sweep and never as a demotion. */
  assert.deepEqual(rulePrecision(null), []);
  assert.deepEqual(applyStandings(null, null), { deliver: [], demoted: [] });
  assert.match(precisionReport(null)[0], /does not claim an accuracy/);
});
