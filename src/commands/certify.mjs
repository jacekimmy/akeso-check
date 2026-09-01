import path from "node:path";
import { createInterface } from "node:readline/promises";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { CERTIFICATION_QUESTIONS, buildPolicy, certificationStatus, certify, coverageStatement, fingerprintSchema } from "../certification.mjs";
import { readLedger } from "../ledger.mjs";

/* `npx akeso-check certify`
 *
 * Coverage starts here and never before. Akeso will not claim to be watching
 * an app until the founder has confirmed the rules it will judge their
 * customers by, because a monitor running on rules nobody agreed to produces
 * confident wrong findings and then gets muted.
 *
 * Four plain questions, about two minutes.
 */

export async function runCertify(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "certify") || process.cwd());
  const detection = await detect(root);
  const ledger = await readLedger(root);

  const fingerprint = fingerprintSchema({
    table: detection.database?.entitlementTable,
    column: detection.database?.entitlementColumn,
    accountColumn: "id",
  });

  if (args.includes("--status")) {
    const status = certificationStatus(ledger, { schemaFingerprint: fingerprint, now: Date.now() });
    console.log(`\n${coverageStatement(status).text}\n`);
    return;
  }

  const existing = certificationStatus(ledger, { schemaFingerprint: fingerprint, now: Date.now() });
  if (existing.certified && !existing.stale && !args.includes("--again")) {
    console.log(`\n${coverageStatement(existing).text}`);
    console.log(`\nTo answer the questions again: npx akeso-check certify --again\n`);
    return;
  }

  console.log(`\nAkeso needs to know how you want your own customers treated.`);
  console.log(`These are your decisions, not Akeso's, and it will not act until you make them.`);
  console.log(`${CERTIFICATION_QUESTIONS.length} questions, about two minutes.\n`);

  const answers = {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [index, question] of CERTIFICATION_QUESTIONS.entries()) {
      console.log(`\n${index + 1}. ${question.question}`);
      if (question.why) console.log(`   ${question.why}`);
      for (const [choice, option] of question.options.entries()) {
        console.log(`   ${choice + 1}) ${option.label}${option.value === question.default ? "   (default)" : ""}`);
      }
      const reply = (await rl.question(`   Your answer [1-${question.options.length}, or Enter for the default]: `)).trim();
      const picked = reply === ""
        ? question.options.find((option) => option.value === question.default) || question.options[0]
        : question.options[Number(reply) - 1];
      if (!picked) {
        /* An unrecognised answer takes the default rather than guessing, and
           says so, because silently reinterpreting a founder's answer is how a
           policy ends up being something nobody chose. */
        console.log(`   Not one of the options, so the default was used.`);
        answers[question.id] = question.default;
      } else {
        answers[question.id] = picked.value;
      }
    }
  } finally {
    rl.close();
  }

  const policy = buildPolicy(answers);
  const priceToPlan = {};

  await certify(root, {
    policy,
    priceToPlan,
    schemaFingerprint: fingerprint,
    adapterVersion: "1",
    notes: `certified from the command line against ${detection.database?.entitlementTable || "profiles"}.${detection.database?.entitlementColumn || "billing_entitled"}`,
  });

  const status = certificationStatus(await readLedger(root), { schemaFingerprint: fingerprint, now: Date.now() });
  console.log(`\n${coverageStatement(status).text}`);
  console.log(`\nNext: npx akeso-check monitor --entitlements-url <your app's akeso entitlements endpoint>\n`);
}
