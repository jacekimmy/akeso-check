import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/* The ledger: one append-only file that the whole product runs on.
 *
 * Check writes what it found. Fix refuses to run until it can read a Check
 * that found something, and writes what it changed. Monitor reads both and
 * writes every sweep and every restore. So "the three features are connected"
 * is not a diagram — this file IS the connection, and a founder can read it
 * with their own eyes.
 *
 * Append-only and hash-chained, for the reason money records always are: an
 * entry that was quietly rewritten later is worth nothing as evidence. Each
 * entry carries the hash of the one before it, so any edit to history breaks
 * every hash after it and `verifyLedger` says exactly where.
 *
 * It lives in the founder's project (.akeso/ledger.jsonl) and is never
 * transmitted anywhere, like everything else here.
 */

export const LEDGER_DIR = ".akeso";
export const LEDGER_FILE = "ledger.jsonl";

export const ledgerPath = (root) => path.join(root, LEDGER_DIR, LEDGER_FILE);

/* The hash covers the entry's content AND its predecessor, which is what makes
   the chain tamper-evident rather than merely checksummed. */
function hashEntry(entry, prevHash) {
  const { hash, ...rest } = entry;
  return createHash("sha256").update(`${prevHash || "genesis"}\n${JSON.stringify(rest)}`).digest("hex");
}

export async function readLedger(root) {
  const text = await readFile(ledgerPath(root), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { kind: "unreadable", raw: line }; }
  });
}

/* Every write goes through here: sequence, timestamp, and chain hash are the
   ledger's business, never the caller's. */
export async function appendEntry(root, entry) {
  const existing = await readLedger(root);
  const previous = existing.at(-1) || null;
  const record = {
    seq: (previous?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    ...entry,
    prev: previous?.hash || null,
  };
  record.hash = hashEntry(record, previous?.hash);
  await mkdir(path.join(root, LEDGER_DIR), { recursive: true });
  await appendFile(ledgerPath(root), `${JSON.stringify(record)}\n`);
  return record;
}

/* Walks the chain and reports the first break. "Valid" here means only that
   nothing was edited or removed after the fact — never that the contents are
   true. The distinction matters and the wording is deliberate. */
export function verifyLedger(entries) {
  let prevHash = null;
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "unreadable") {
      return { intact: false, brokenAt: index + 1, reason: "an entry is not readable JSON" };
    }
    if ((entry.prev || null) !== prevHash) {
      return { intact: false, brokenAt: entry.seq ?? index + 1, reason: "an entry does not follow the one before it" };
    }
    if (entry.hash !== hashEntry(entry, prevHash)) {
      return { intact: false, brokenAt: entry.seq ?? index + 1, reason: "an entry was changed after it was written" };
    }
    prevHash = entry.hash;
  }
  return { intact: true, entries: entries.length };
}

export const lastOfKind = (entries, kind) => [...entries].reverse().find((entry) => entry.kind === kind) || null;

/* What Check writes. Grades and findings only — never source code, never a
   key, never a customer identifier beyond what the founder already has. */
export const checkEntry = ({ grade, lifecycleGrade, sandboxGrade, findings, scenarioResults, framework, root }) =>
  ({ kind: "check", grade, lifecycleGrade, sandboxGrade, findings, scenarioResults, framework, root });

/* What Fix writes: which files changed, the hash of each file before and
   after, and the Check entry it was authorised by. */
export const fixEntry = ({ authorisedBy, files, backupDir, repairs }) =>
  ({ kind: "fix", authorisedBy, files, backupDir, repairs });

/* What Monitor writes for a sweep and for each restore. */
export const sweepEntry = ({ comparison, drift, alerts }) =>
  ({ kind: "sweep", comparison, drift, alerts });

export const restoreEntry = ({ account, direction, reasonCode, idempotencyKey, result, before, after, verified }) =>
  ({ kind: "restore", account, direction, reasonCode, idempotencyKey, result, before, after, verified });
