import path from "node:path";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { precisionReport, recordFeedback, rulePrecision } from "../precision.mjs";
import { readLedger } from "../ledger.mjs";

/* `npx akeso-check feedback`
 *
 * How Akeso learns whether it was right. A founder who dismisses a finding is
 * telling Akeso its rule cried wolf; one who confirms it is telling Akeso the
 * rule earned its interruption. A rule that is wrong more than half the time
 * stops interrupting anyone until it earns its way back, which is the only
 * defence a monitor has against being muted.
 */

const RULES = ["paying-but-locked-out", "canceled-but-entitled", "self-halt", "all-clear-again"];

export async function runFeedback(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "feedback") || process.cwd());

  const rule = flagValue("--rule");
  const verdict = args.includes("--confirm") ? "confirmed" : args.includes("--dismiss") ? "dismissed" : null;

  if (!rule || !verdict) {
    const ledger = await readLedger(root);
    const lines = precisionReport(rulePrecision(ledger));
    console.log(`\nHow often Akeso has been right so far:`);
    for (const line of lines?.length ? lines : ["No judgements yet. Akeso has not been told whether any finding was real."]) console.log(`  ${line}`);
    console.log(`\nTo tell it:`);
    console.log(`  npx akeso-check feedback --rule <rule> --confirm     the finding was real`);
    console.log(`  npx akeso-check feedback --rule <rule> --dismiss     it was a false alarm`);
    console.log(`\nRules: ${RULES.join(", ")}`);
    console.log(`Add --account <id> to say which account, and --note "..." to say why.\n`);
    return;
  }

  if (!RULES.includes(rule)) {
    console.log(`\n"${rule}" is not one of Akeso's rules. They are: ${RULES.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  await recordFeedback(root, { rule, verdict, account: flagValue("--account"), note: flagValue("--note") });
  const lines = precisionReport(rulePrecision(await readLedger(root)));
  console.log(`\nRecorded. ${verdict === "confirmed" ? "That counts in the rule's favour." : "That counts against the rule."}`);
  for (const line of lines || []) console.log(`  ${line}`);
  console.log();
}
