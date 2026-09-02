#!/usr/bin/env node
/* Walk through Akeso exactly the way a new founder does, on a throwaway app.
 *
 *   node try/new-user.mjs          you type each command; this checks the result
 *   node try/new-user.mjs --auto   it types them for you (a smoke test)
 *
 * It copies the tutorial-shaped fixture app to ~/akeso-trial/my-app, wires
 * `npx akeso-check` in that folder to THIS checkout (not the npm registry),
 * starts the app, and then hands you one command at a time. After each one it
 * reads the ledger the command wrote and says whether the page will show what
 * it should. Nothing here touches Stripe unless you put your own TEST key in
 * the trial app's .env.local, and the fixture ships with a fake one.
 */
import { cp, mkdir, readFile, rm, writeFile, chmod, symlink, access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, "..");
const trial = path.join(homedir(), "akeso-trial", "my-app");
const PORT = 4300;
const auto = process.argv.includes("--auto");
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const rl = auto ? null : createInterface({ input: process.stdin, output: process.stdout });
const pause = async (q) => { if (auto) return ""; return rl.question(q); };

async function ledger() {
  try { return (await readFile(path.join(trial, ".akeso", "ledger.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
async function envValue(name) {
  try { return (await readFile(path.join(trial, ".env.local"), "utf8")).match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s#]+)`, "m"))?.[1] || null; } catch { return null; }
}

/* ---- 0. a fresh throwaway app, wired to this checkout ---- */
console.log(bold("\nAkeso, as a new founder sees it\n"));
console.log(`Throwaway app: ${trial}`);
await rm(trial, { recursive: true, force: true });
await mkdir(path.dirname(trial), { recursive: true });
await cp(path.join(checkout, "fixtures", "repairable-app"), trial, { recursive: true });
await rm(path.join(trial, ".akeso"), { recursive: true, force: true });
const bin = path.join(trial, "node_modules", ".bin");
await mkdir(bin, { recursive: true });
await symlink(checkout, path.join(trial, "node_modules", "akeso-check")).catch(() => {});
await writeFile(path.join(bin, "akeso-check"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(checkout, "bin", "akeso-check.mjs")}" "$@"\n`);
await chmod(path.join(bin, "akeso-check"), 0o755);
console.log(dim(`npx akeso-check in that folder runs this checkout (${checkout}), not the npm registry.\n`));

let server = null;
async function startApp() {
  if (server) { server.kill(); await new Promise((r) => setTimeout(r, 300)); }
  const secret = await envValue("AKESO_SHARED_SECRET");
  server = spawn(process.execPath, ["server.mjs"], { cwd: trial, env: { ...process.env, PORT: String(PORT), AKESO_FIXTURE_DB: path.join(trial, "data", "db.json"), ...(secret ? { AKESO_SHARED_SECRET: secret } : {}) }, stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the trial app did not start");
}
await startApp();
console.log(ok(`The app is running at http://localhost:${PORT} (this script keeps it up).\n`));

function runHere(cmd) {
  console.log(dim(`  > ${cmd}`));
  if (auto && /akeso-check page$/.test(cmd)) cmd += " --no-open";
  const r = spawnSync("sh", ["-c", cmd], { cwd: trial, stdio: "inherit", env: { ...process.env, AKESO_NO_OPEN: "1" } });
  return r.status;
}

const steps = [
  {
    say: "Read the code. Seconds. No grade yet, because nothing has run.",
    cmd: "npx akeso-check --no-open",
    expect: async (L) => L.some((e) => e.kind === "check") ? ok("The ledger has its first entry. The page would say: Code read. Not yet run.") : bad("No check entry was written."),
  },
  {
    say: "The real test: a pretend customer pays, cancels, fails a card, against the running app.",
    cmd: `npx akeso-check --lifecycle-url http://localhost:${PORT} --no-open`,
    expect: async (L) => { const c = L.filter((e) => e.kind === "check").pop(); return c?.grade === "F" ? ok("Grade F, as the tutorial-shaped app deserves. The page would say: Grade F. 6 of 10 situations fail.") : bad(`Expected grade F, got ${c?.grade}.`); },
  },
  {
    say: "Open your page. It is one file, drawn from the ledger.",
    cmd: "npx akeso-check page",
    expect: async () => { try { await access(path.join(trial, "akeso.html")); return ok("akeso.html was written and opened. Check the red F and the dashed 'Fix · Next' circle."); } catch { return bad("akeso.html was not written."); } },
  },
  {
    say: "Fix it. Akeso writes the repair, re-runs the same test, and undoes itself if the proof fails. --with-endpoints also adds the two files the monitor needs; it prints a secret ONCE. Paste that AKESO_SHARED_SECRET=... line into ~/akeso-trial/my-app/.env.local before pressing Enter.",
    cmd: `npx akeso-check fix --apply --with-endpoints --verify-url http://localhost:${PORT}`,
    expect: async (L) => { const fix = L.find((e) => e.kind === "fix"); const after = L.filter((e) => e.kind === "check").pop(); const secret = await envValue("AKESO_SHARED_SECRET"); await startApp(); return !fix ? bad("No fix entry.") : after?.grade !== "A" ? bad(`The re-test did not pass (grade ${after?.grade}).`) : !secret ? ok("Fix proven: grade A. (The secret is not in .env.local yet, so the monitor's endpoints will refuse it. Add it and re-run step 5 if you want a real sweep.)") : ok("Fix proven: grade A. The app was restarted with your secret. The page would say: The fix passed its re-test."); },
    after: async () => { const secret = await envValue("AKESO_SHARED_SECRET"); if (!secret && auto) { /* the auto run cannot paste; take it from the fix's own record if it printed one */ } },
  },
  {
    say: "Confirm the access rules (what happens on a failed card, a pause, a refund). Coverage starts here. Four plain questions.",
    cmd: "npx akeso-check certify",
    skipAuto: true,
    expect: async (L) => L.some((e) => e.kind === "certify") ? ok("Rules confirmed. Settings on the page: Access rules · Confirmed.") : bad("No certify entry."),
  },
  {
    say: `Compare Stripe with the app's real accounts. The fixture's Stripe key is fake, so this sweep should say it could not run. To see a real sweep, put your Stripe TEST key (sk_test_...) in ~/akeso-trial/my-app/.env.local; with no test subscriptions carrying client_reference_id s1..s10 it will then say nothing could be compared, which is also a real state.`,
    cmd: async () => `AKESO_SHARED_SECRET=${(await envValue("AKESO_SHARED_SECRET")) || "missing"} npx akeso-check monitor --entitlements-url http://localhost:${PORT}/api/akeso/entitlements`,
    expect: async (L) => { const s = L.filter((e) => e.kind === "sweep").pop(); return s ? ok(s.couldNotRun ? `Sweep recorded as could-not-run: ${String(s.couldNotRun).slice(0, 80)}` : `Sweep recorded: ${s.comparison?.counts?.matched ?? 0} compared.`) : bad("No sweep entry."); },
  },
  {
    say: "Open the page again. Every step you ran is on it, and the chain seal verifies every entry.",
    cmd: "npx akeso-check page",
    expect: async (L) => ok(`${L.length} entries. Also try the hosted copy: open https://akeso-check.vercel.app, Load your ledger, pick ${path.join(trial, ".akeso", "ledger.jsonl")}.`),
  },
];

let n = 0;
for (const step of steps) {
  n += 1;
  const cmd = typeof step.cmd === "function" ? await step.cmd() : step.cmd;
  console.log(`\n${bold(`Step ${n}.`)} ${step.say}`);
  console.log(`\n  cd ${trial}\n  ${bold(cmd)}\n`);
  if (auto) {
    if (step.skipAuto) { console.log(dim("  (interactive; skipped in --auto)")); continue; }
    runHere(cmd);
  } else {
    await pause(dim("Run it in another terminal, then press Enter here. "));
  }
  console.log("  " + await step.expect(await ledger()));
}

console.log(`\n${bold("Done.")} The app keeps running until you press Enter${auto ? "" : " (so you can keep playing)"}.`);
if (!auto) await pause("");
server?.kill(); rl?.close();
