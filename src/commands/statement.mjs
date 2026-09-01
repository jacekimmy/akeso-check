import path from "node:path";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { readLedger, verifyLedger } from "../ledger.mjs";
import { monthlyStatement, renderStatementHtml, renderStatementText } from "../receipts.mjs";
import { precisionReport, rulePrecision, standingsFor } from "../precision.mjs";
import { coverageGaps, describeSchedule } from "../schedule.mjs";

/* `npx akeso-check statement`
 *
 * The month, in three numbers that are never added together, plus the two
 * things a founder actually needs at renewal time: did it run, and was it
 * right when it spoke.
 *
 * A month with no sweeps says so. "Nothing found" and "nothing looked" are
 * different sentences, and conflating them is the one way a monitoring product
 * can be worthless while appearing to work.
 */

export async function runStatement(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "statement") || process.cwd());
  const ledger = await readLedger(root);
  const month = flagValue("--month") || undefined;

  if (!ledger.length) {
    console.log(`\nThere is no history for this project yet.`);
    console.log(`Akeso writes one every time it runs, so this fills in as you use it.\n`);
    return;
  }

  const statement = monthlyStatement(ledger, { month, now: new Date() });
  console.log(`\n${renderStatementText(statement)}`);

  /* Whether the history behind those numbers was edited after the fact. Stated
     precisely: this detects an edit that did not also rewrite the chain, which
     is tamper-evidence and not tamper-proofing. */
  const intact = verifyLedger(ledger);
  console.log(`\nHistory: ${intact.intact
    ? `${intact.entries} entries, chain unbroken.`
    : `BROKEN at entry ${intact.brokenAt}. ${intact.reason}`}`);

  /* Was Akeso right when it spoke? A monitor nobody can audit becomes a
     monitor nobody believes. */
  const stats = rulePrecision(ledger);
  const lines = precisionReport(stats);
  if (lines?.length) {
    console.log(`\nHow often Akeso was right:`);
    for (const line of lines) console.log(`  ${line}`);
  }

  /* Gaps are part of the truth. A month that looks clean because nothing ran
     is not a clean month. */
  const gaps = coverageGaps(ledger, { now: Date.now() });
  if (gaps?.length) {
    console.log(`\nTimes Akeso was not watching:`);
    for (const gap of gaps.slice(0, 5)) {
      console.log(`  ${String(gap.from).slice(0, 16).replace("T", " ")} to ${String(gap.to).slice(0, 16).replace("T", " ")} (${Math.round(gap.hours)} hours)`);
    }
    if (gaps.length > 5) console.log(`  and ${gaps.length - 5} more`);
  }

  const html = flagValue("--html");
  if (html) {
    const out = path.resolve(html);
    await writeFile(out, renderStatementHtml(statement));
    console.log(`\nStatement: ${out}`);
    if (!args.includes("--no-open") && !process.env.CODESPACES) {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
    }
  } else {
    console.log(`\n  npx akeso-check statement --html statement.html    the same thing as a page you can keep`);
  }
  console.log();
}
