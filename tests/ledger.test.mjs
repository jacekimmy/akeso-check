import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEntry, checkEntry, ledgerPath, lastOfKind, readLedger, verifyLedger } from "../src/ledger.mjs";

/* The ledger is the evidence the whole product rests on. If it can be edited
   after the fact without anyone noticing, none of the receipts mean anything. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-ledger-"));

test("entries chain, and the chain verifies", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "F", findings: ["signature not verified"] }));
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));
  const entries = await readLedger(root);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].seq, 1);
  assert.equal(entries[1].seq, 2);
  assert.equal(entries[0].prev, null);
  assert.equal(entries[1].prev, entries[0].hash, "each entry names the one before it");
  assert.deepEqual(verifyLedger(entries), { intact: true, entries: 2 });
});

test("editing history is detected, and named by position", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "F", findings: ["cancels ignored"] }));
  await appendEntry(root, checkEntry({ grade: "F", findings: ["cancels ignored"] }));
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));

  /* The exact attack this defends against: quietly upgrading a past grade. */
  const raw = await readFile(ledgerPath(root), "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.grade = "A";
  lines[1] = JSON.stringify(tampered);
  await writeFile(ledgerPath(root), `${lines.join("\n")}\n`);

  const verdict = verifyLedger(await readLedger(root));
  assert.equal(verdict.intact, false);
  assert.equal(verdict.brokenAt, 2);
  assert.match(verdict.reason, /changed after it was written/);
});

test("deleting an entry breaks the chain too", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "F", findings: [] }));
  await appendEntry(root, checkEntry({ grade: "D", findings: [] }));
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));

  const lines = (await readFile(ledgerPath(root), "utf8")).split("\n").filter(Boolean);
  await writeFile(ledgerPath(root), `${[lines[0], lines[2]].join("\n")}\n`);

  const verdict = verifyLedger(await readLedger(root));
  assert.equal(verdict.intact, false, "a removed entry must not pass as intact history");
});

test("an empty or missing ledger is intact, not broken", async () => {
  const root = await scratch();
  assert.deepEqual(verifyLedger(await readLedger(root)), { intact: true, entries: 0 });
});

test("lastOfKind finds the most recent, not the first", async () => {
  const root = await scratch();
  await appendEntry(root, checkEntry({ grade: "F", findings: [] }));
  await appendEntry(root, { kind: "fix", files: [] });
  await appendEntry(root, checkEntry({ grade: "A", findings: [] }));
  const entries = await readLedger(root);
  assert.equal(lastOfKind(entries, "check").grade, "A");
  assert.equal(lastOfKind(entries, "fix").kind, "fix");
  assert.equal(lastOfKind(entries, "sweep"), null);
});
