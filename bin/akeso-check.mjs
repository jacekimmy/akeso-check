#!/usr/bin/env node
import { runCheck } from "../src/commands/check.mjs";
import { runFix } from "../src/commands/fix.mjs";
import { runMonitor } from "../src/commands/monitor.mjs";

/* Three commands, one loop:
 *
 *   npx akeso-check            find out whether billing is handled correctly
 *   npx akeso-check fix        write the repair (preview first, always undoable)
 *   npx akeso-check monitor    compare today's real customers against Stripe
 *
 * Running it with no command is the Check, because that is the door a stranger
 * comes through and it must never ask them to learn a vocabulary first. Each
 * command ends by naming the next one, so the sequence lives in the tool
 * instead of in the founder's head.
 */

const args = process.argv.slice(2);
const command = args[0];

const HELP = `
Akeso Check — does your app give paid access to exactly the people paying for it?

  npx akeso-check                            read the code, grade it, write a report
  npx akeso-check --lifecycle-url <url>      the real test: a pretend customer
                                             pays, cancels, fails a card, refunds
  npx akeso-check --lifecycle-url <url> --sandbox
                                             the same, with real Stripe events from
                                             your own test sandbox (trial, renewal)

  npx akeso-check fix                        show the repair for what was found
  npx akeso-check fix --show                 print the code it would write
  npx akeso-check fix --apply                write it (originals backed up first)
  npx akeso-check fix --revert               put everything back

  npx akeso-check monitor --entitlements-url <url>
                                             compare Stripe against your app's
                                             real accounts, right now
  npx akeso-check monitor --receipt          what Akeso has done, from the ledger

Everything runs on this machine. Nothing is sent anywhere.
`;

if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
} else if (command === "fix") {
  await runFix(args);
} else if (command === "monitor") {
  await runMonitor(args);
} else {
  await runCheck(args);
}
