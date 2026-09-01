#!/usr/bin/env node
import { runCheck } from "../src/commands/check.mjs";
import { runFix } from "../src/commands/fix.mjs";
import { runMonitor } from "../src/commands/monitor.mjs";
import { runApprovals } from "../src/commands/approvals.mjs";
import { runCertify } from "../src/commands/certify.mjs";
import { runStatement } from "../src/commands/statement.mjs";
import { runFeedback } from "../src/commands/feedback.mjs";

/* One loop, three steps:
 *
 *   check  ->  fix  ->  check again (does it hold?)  ->  monitor
 *     ^                                                     |
 *     +---------------- drift found again ------------------+
 *
 * check, fix and monitor are the loop. certify, approvals and statement exist
 * only to serve the third step: certify turns coverage on, approvals is where
 * a human says yes to the one dangerous action, and statement reads the
 * history back.
 *
 * Running it with no command is the Check, because that is the door a stranger
 * comes through and it must never ask them to learn a vocabulary first. Each
 * command ends by drawing the loop and naming the next step, so the sequence
 * lives in the tool instead of in the founder's head.
 */

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
Akeso: does your app give paid access to exactly the people paying for it?

THE LOOP. Three steps, and each one hands something to the next.

  1  check     Does the billing code handle it right?
               npx akeso-check                          read the code, grade it A to F
               npx akeso-check --lifecycle-url <url>    the real test: a pretend
                                                        customer pays, cancels, fails
                                                        a card, gets refunded
               add --sandbox                            same, with real Stripe events
                                                        from your own test sandbox,
                                                        including a trial and a renewal

  2  fix       Write the repair for what step 1 found.
               npx akeso-check fix                      show it, change nothing
               npx akeso-check fix --show               print the code it would write
               npx akeso-check fix --apply              write it, originals backed up
               add --verify-url <url>                   prove it, and undo it if the
                                                        proof fails
               npx akeso-check fix --revert             put everything back

  3  monitor   Correct code from now on does not fix accounts that already drifted.
               npx akeso-check certify                  a few questions about how you
                                                        want your customers treated.
                                                        Coverage starts here
               npx akeso-check monitor --entitlements-url <url>
                                                        compare Stripe against your
                                                        app's real accounts, today
               npx akeso-check monitor --watch          keep checking, every hour
               npx akeso-check monitor --after-deploy   you just deployed; check again soon
               npx akeso-check approvals                removals waiting for your yes
               npx akeso-check feedback                 tell Akeso whether a finding was real
               npx akeso-check statement                the month, in plain numbers

Akeso restores access on its own. It never removes access on its own.
Every run appends to .akeso/ledger.jsonl in your project, and every command
ends by telling you the next one.

Everything runs on this machine. Nothing is sent anywhere.
`;

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
} else if (command === "fix") {
  await runFix(args);
} else if (command === "monitor") {
  await runMonitor(args);
} else if (command === "certify") {
  await runCertify(args);
} else if (command === "approvals") {
  await runApprovals(args);
} else if (command === "statement") {
  await runStatement(args);
} else if (command === "feedback") {
  await runFeedback(args);
} else {
  await runCheck(args);
}
