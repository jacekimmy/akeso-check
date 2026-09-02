import path from "node:path";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { readLedger } from "../ledger.mjs";
import { renderDashboard } from "../dashboard.mjs";

/* `npx akeso-check page`: the dashboard, written to akeso.html with this
   project's ledger embedded, and opened. No network: the local copy loads no
   fonts and reads nothing but the file it was written from. */
export async function runPage(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "page") || process.cwd());
  const detection = await detect(root);
  const ledger = await readLedger(root);
  const appName = detection.framework?.packageName || path.basename(root);

  const out = path.resolve(flagValue("--html") || path.join(root, "akeso.html"));
  await writeFile(out, renderDashboard({ ledger, appName, root, hosted: false }));
  console.log(`\nDashboard: ${out}`);
  console.log(`Everything on it was read from .akeso/ledger.jsonl. It has no buttons that act:`);
  console.log(`every action is a command, and the page names the one to run.\n`);
  if (!args.includes("--no-open") && !process.env.CODESPACES) {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
  }
}
