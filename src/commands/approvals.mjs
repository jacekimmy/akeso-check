import path from "node:path";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { approve, cancel, describeApproval, pendingApprovals } from "../approvals.mjs";
import { readLedger } from "../ledger.mjs";
import { restoreEntitlement } from "../restore.mjs";
import { appendEntry, restoreEntry } from "../ledger.mjs";
import { guardWrite } from "../safety.mjs";

/* `npx akeso-check approvals`
 *
 * The human half of the one dangerous action. Every removal Akeso wants to
 * make waits here until a person says yes, and this is where they see the
 * list, approve one, or cancel it.
 *
 * Approving is what sends it. Nothing in the monitor ever removes access on
 * its own, which is why this command exists at all.
 */

export async function runApprovals(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "approvals") || process.cwd());
  const ledger = await readLedger(root);
  const now = Date.now();

  const approveId = flagValue("--approve");
  const cancelId = flagValue("--cancel");

  if (cancelId) {
    await cancel(root, cancelId, { by: "you", reason: flagValue("--reason") || "cancelled from the command line" });
    console.log(`\nCancelled. That account keeps its access, and Akeso will not ask again about this one.\n`);
    return;
  }

  if (approveId) {
    const queued = pendingApprovals(ledger, { now }).find((row) => row.id === approveId);
    if (!queued) {
      console.log(`\nThere is no removal waiting with that id.`);
      console.log(`Run "npx akeso-check approvals" to see what is waiting.\n`);
      process.exitCode = 1;
      return;
    }
    if (!queued.ready) {
      console.log(`\nThat removal is still inside its waiting window, on purpose.`);
      console.log(`${describeApproval(queued, { now })}\n`);
      process.exitCode = 1;
      return;
    }

    /* Even an approved removal passes the safety gate. A human saying yes does
       not override a kill switch, a suspended account, or the write budget. */
    const guard = await guardWrite(root, { account: queued.account, direction: "remove", entries: ledger, now });
    if (!guard.allowed) {
      console.log(`\nAkeso will not send that removal right now:`);
      for (const reason of guard.reasons) console.log(`  ${reason}`);
      console.log();
      process.exitCode = 1;
      return;
    }

    const endpoint = flagValue("--restore-url");
    const secret = process.env.AKESO_SHARED_SECRET;
    if (!endpoint || !secret) {
      /* Approval is still recorded: the decision is the founder's and it
         happened. Only the delivery is missing, and we say exactly that. */
      await approve(root, approveId, { by: "you" });
      console.log(`\nApproved and recorded, but not sent: Akeso needs your app's restore endpoint.`);
      console.log(`  npx akeso-check approvals --approve ${approveId} --restore-url https://yourapp.com/api/akeso/restore`);
      console.log(`  and AKESO_SHARED_SECRET set in your environment.\n`);
      return;
    }

    await approve(root, approveId, { by: "you" });
    /* The approval id travels with the request. The write path refuses a
       removal that cannot be traced back to a person saying yes, so this is
       not decoration: it is how that refusal is satisfied honestly. */
    const outcome = await restoreEntitlement({
      endpoint, secret,
      account: queued.account, target: false, direction: "remove",
      expectedState: queued.expectedState,
      reasonCode: "approved-removal",
      idempotencyKey: queued.id,
      approvalId: queued.id,
    });
    await appendEntry(root, restoreEntry({
      account: queued.account, direction: "remove", reasonCode: "approved-removal",
      idempotencyKey: queued.id, result: outcome.result,
      before: outcome.before?.billingEntitled ?? null,
      after: outcome.after?.billingEntitled ?? null,
      verified: Boolean(outcome.verified),
    }));

    console.log(`\n${outcome.result === "applied"
      ? `Done. ${queued.account} no longer has paid access, and Akeso read it back to confirm.`
      : `Not applied: ${outcome.reason || outcome.result}.`}\n`);
    return;
  }

  const pending = pendingApprovals(ledger, { now });
  if (!pending.length) {
    console.log(`\nNothing is waiting for you. Akeso has not asked to remove anyone's access.`);
    console.log(`Removals only ever appear here, never automatically.\n`);
    return;
  }

  console.log(`\n${pending.length} removal${pending.length === 1 ? "" : "s"} waiting for you.`);
  console.log(`Akeso never takes paid access away on its own. Nothing below has happened.\n`);
  for (const row of pending) {
    console.log(`  ${row.id}`);
    console.log(`    ${describeApproval(row, { now })}`);
  }
  console.log(`\n  npx akeso-check approvals --approve <id>    take this account's access away`);
  console.log(`  npx akeso-check approvals --cancel <id>     leave it alone\n`);
}
