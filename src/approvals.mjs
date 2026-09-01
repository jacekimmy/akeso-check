import { randomUUID } from "node:crypto";
import { appendEntry, readLedger } from "./ledger.mjs";

/* Queued removals, and the human who has to say yes.
 *
 * Taking paid access away is the one thing Akeso can do that creates an
 * incident. A wrong grant costs a few dollars. A wrong removal locks a paying
 * customer out of the thing they paid for, usually at the moment they are
 * looking at it. So removals do not travel the path grants travel: they are
 * written down as an intention, they sit inside a window where one tap cancels
 * them, and nothing reaches the customer's app until a human approves.
 *
 * Three things in this file are worth saying out loud:
 *
 *   1. Queuing is not removing. Approving is not removing either. Approving
 *      records that a human said yes; the executor is a separate step that
 *      re-reads the account before it touches anything.
 *   2. Both decisions are final. A cancel cannot be undone by a later approve,
 *      and an approve cannot be undone by a later cancel. Last-write-wins is
 *      the rule that lets a stray line reverse a human.
 *   3. Nothing is stored as a status. State is folded out of the ledger every
 *      time it is read, so there is no column anywhere that can drift out of
 *      step with the history, and expiry needs no cleanup job.
 */

/* The cancel window. The sweep passes the number it already publishes as
   LIMITS.removalDelayMinutes; this is only the fallback, and it is deliberately
   not imported from monitor.mjs, because monitor will import this file and a
   constant borrowed across an import cycle reads as undefined at load time. */
export const DEFAULT_DELAY_MINUTES = 30;

/* An approval nobody answered dies after a week. The reason is not tidiness:
   state moves. A removal approved against what Stripe said last Tuesday could
   take access from someone who resubscribed on Thursday. Expiry is derived when
   the queue is read and is never written, so the history keeps saying only what
   actually happened. */
export const EXPIRY_DAYS = 7;
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const usable = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const msAt = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isNaN(ms) ? null : ms;
};
const minutesWord = (count) => `${count} minute${count === 1 ? "" : "s"}`;
const asSentence = (text) => `${String(text).trim().replace(/[.\s]+$/, "")}.`;

/* ---------------------------------------------------------------- queuing */

/* Write the intention. Nothing is sent to the customer's app from here, which
   is why this needs no confirmation step and no blast-radius check: the only
   thing that happens is that a human gets something to answer. */
export async function queueRemoval(root, {
  account,
  reason = null,
  priceMonthly = null,
  expectedState = null,
  ruleVersion = null,
  delayMinutes = DEFAULT_DELAY_MINUTES,
  now = Date.now(),
} = {}) {
  /* A row that names no account is nothing a human could approve or cancel,
     and the fold would drop it. Better to refuse at the edge than to leave a
     line in the queue that can only confuse the person reading it. */
  if (!usable(account)) throw new Error("a queued removal must name the account it would affect");

  const minutes = Number.isFinite(delayMinutes) && delayMinutes >= 0 ? delayMinutes : DEFAULT_DELAY_MINUTES;
  const queuedAt = new Date(now).toISOString();

  return appendEntry(root, {
    kind: "approval",
    id: randomUUID(),
    state: "queued",
    account: String(account),
    reason,
    /* Only a price we were actually told. A missing price stays null and the
       founder-facing line simply says no dollar figure. */
    priceMonthly: typeof priceMonthly === "number" ? priceMonthly : null,
    /* What the app looked like when this was queued. The executor compares it
       against a fresh read before acting, so an account that changed in the
       meantime is skipped instead of overwritten. */
    expectedState: expectedState ?? null,
    /* Which policy version produced this verdict. A removal read back next
       month means nothing without knowing the rule that justified it. */
    ruleVersion: ruleVersion ?? null,
    delayMinutes: minutes,
    queuedAt,
    readyAt: new Date(now + minutes * 60000).toISOString(),
  });
}

/* -------------------------------------------------------------- decisions */

const refusal = (id, state, message) => ({ ok: false, id, state, entry: null, confirmed: false, message });

/* A human says yes. Refused unless the row is queued and its cancel window has
   passed, because a window that a tap can skip is decoration, and being slow to
   remove access has never been the failure that hurts anyone. */
export async function approve(root, id, { by = null, now = Date.now() } = {}) {
  const key = usable(id);
  const state = key ? approvalState(await readLedger(root), key, { now }) : "unknown";

  if (state === "approved") {
    /* Not an error and not a second entry. Two taps on the same button must
       leave one approval behind, not two. */
    return { ok: true, id: key, state: "approved", entry: null, confirmed: true, alreadyDone: true,
      message: "That removal was already approved. Nothing more is needed from you." };
  }
  if (state === "unknown") return refusal(key, state, "Akeso has no queued removal with that id. Nothing was approved, and nothing will be removed.");
  if (state === "cancelled") return refusal(key, state, "That removal was cancelled, and a cancellation is final. Nothing was removed. Run a fresh sweep if that account should still lose access.");
  if (state === "expired") return refusal(key, state, `That removal was queued more than ${EXPIRY_DAYS} days ago and nobody answered it, so it expired. Nothing was removed. Run a fresh sweep to see whether it is still true.`);
  if (state === "queued") {
    const row = foldApprovals(await readLedger(root), { now }).get(key);
    const left = Math.max(1, Math.ceil(((msAt(row?.readyAt) ?? now) - now) / 60000));
    return refusal(key, state, `That removal is still inside its cancel window for another ${minutesWord(left)}, so it cannot be approved yet. You can cancel it now, or approve it once the window ends.`);
  }

  const entry = await appendEntry(root, {
    kind: "approval",
    id: key,
    state: "approved",
    by: by || null,
    decidedAt: new Date(now).toISOString(),
  });

  /* Read it back before saying it worked. A write we did not confirm is not a
     result, here or anywhere else in this product. */
  const confirmed = approvalState(await readLedger(root), key, { now }) === "approved";
  return {
    ok: confirmed,
    id: key,
    state: confirmed ? "approved" : "unknown",
    entry,
    confirmed,
    message: confirmed
      ? `Approved${by ? ` by ${by}` : ""}. Nothing has changed in your app yet. The removal is now cleared to run, and Akeso re-reads that account afterwards to confirm it worked.`
      : "Akeso wrote the approval but could not read it back, so it is not treating it as approved. Nothing was removed. Look at .akeso/ledger.jsonl before trying again.",
  };
}

/* A human says no. Allowed at any point before the row is decided, including
   before the window ends and after it has expired: stopping a removal is always
   the safe direction, so it is never delayed and never rate limited. */
export async function cancel(root, id, { by = null, reason = null, now = Date.now() } = {}) {
  const key = usable(id);
  const state = key ? approvalState(await readLedger(root), key, { now }) : "unknown";

  if (state === "cancelled") {
    return { ok: true, id: key, state: "cancelled", entry: null, confirmed: true, alreadyDone: true,
      message: "That removal was already cancelled. Nothing was taken away, and that account keeps its access." };
  }
  if (state === "unknown") return refusal(key, state, "Akeso has no queued removal with that id. Nothing was cancelled, and nothing will be removed.");
  if (state === "approved") {
    /* An approval is as final as a cancellation, so the honest answer names the
       action that actually helps: granting access back is instant and safe. */
    return refusal(key, state, "That removal was already approved, and an approval is final. If that account should keep its access, grant it back instead: grants are instant and safe.");
  }

  const entry = await appendEntry(root, {
    kind: "approval",
    id: key,
    state: "cancelled",
    by: by || null,
    reason,
    decidedAt: new Date(now).toISOString(),
  });

  const confirmed = approvalState(await readLedger(root), key, { now }) === "cancelled";
  return {
    ok: confirmed,
    id: key,
    state: confirmed ? "cancelled" : "unknown",
    entry,
    confirmed,
    message: confirmed
      ? "Cancelled. That account keeps its access, and Akeso will not queue this same removal again until a sweep finds it again."
      : "Akeso wrote the cancellation but could not read it back. Treat that removal as still queued and look at .akeso/ledger.jsonl.",
  };
}

/* ------------------------------------------------------------- the fold */

/* Derived, never stored. "ready" and "expired" are both facts about the clock,
   and writing a fact about the clock down is how a queue starts lying. */
function derive(row, now) {
  if (row.stored === "approved") return { state: "approved", ready: false };
  if (row.stored === "cancelled") return { state: "cancelled", ready: false };

  const queuedMs = msAt(row.queuedAt);
  if (queuedMs !== null && now - queuedMs >= EXPIRY_MS) return { state: "expired", ready: false };

  /* A readyAt we cannot read is not a window that has passed. Unprovable is
     never a pass, and least of all for the one action that can lock a paying
     customer out. */
  const readyMs = msAt(row.readyAt);
  const ready = readyMs !== null && now >= readyMs;
  return { state: ready ? "ready" : "queued", ready };
}

/* Every approval id in the ledger, folded to where it stands now. Returns a Map
   in the order the removals were queued, so the oldest question is first. */
export function foldApprovals(entries, { now = Date.now() } = {}) {
  const rows = new Map();
  if (!Array.isArray(entries)) return rows;

  for (const entry of entries) {
    if (!entry || entry.kind !== "approval") continue;
    /* An entry with no usable id names nothing. It is skipped rather than
       thrown on: one malformed line must never make the whole queue
       unreadable, because the queue is what stands between a mistake and a
       customer losing access. */
    const id = usable(entry.id);
    if (!id) continue;

    const existing = rows.get(id);

    if (entry.state === "queued") {
      /* The first queuing is the record. A repeat neither restarts the cancel
         window nor revives something a human already answered. */
      if (existing) continue;
      rows.set(id, {
        id,
        account: entry.account ?? null,
        reason: entry.reason ?? null,
        priceMonthly: typeof entry.priceMonthly === "number" ? entry.priceMonthly : null,
        expectedState: entry.expectedState ?? null,
        ruleVersion: entry.ruleVersion ?? null,
        queuedAt: entry.queuedAt ?? entry.at ?? null,
        readyAt: entry.readyAt ?? null,
        stored: "queued",
        by: null,
        decidedAt: null,
        cancelReason: null,
      });
      continue;
    }

    if (entry.state === "approved" || entry.state === "cancelled") {
      /* A decision about an id that was never queued is ignored. Reading a bare
         "approved" as an approval would let one stray line authorise a removal
         nobody ever proposed. */
      if (!existing) continue;
      /* Both decisions are terminal. Last-write-wins here would let a later
         approve undo a cancel a human already made, which is exactly the
         sequence that takes access from someone who asked to keep it. */
      if (existing.stored !== "queued") continue;
      existing.stored = entry.state;
      existing.by = entry.by ?? null;
      existing.decidedAt = entry.decidedAt ?? entry.at ?? null;
      if (entry.state === "cancelled") existing.cancelReason = entry.reason ?? null;
      continue;
    }
    /* Any other state belongs to a version of this file we do not know about.
       Ignored, never guessed at. */
  }

  for (const row of rows.values()) Object.assign(row, derive(row, now));
  return rows;
}

/* What is still waiting on a human. Approved, cancelled and expired rows are
   answered questions and never appear here, or the founder would be asked the
   same thing twice. */
export function pendingApprovals(entries, { now = Date.now() } = {}) {
  return [...foldApprovals(entries, { now }).values()]
    .filter((row) => row.state === "queued" || row.state === "ready")
    .map(({ id, account, reason, priceMonthly, queuedAt, readyAt, ready, expectedState }) =>
      ({ id, account, reason, priceMonthly, queuedAt, readyAt, ready, expectedState }));
}

/* Where one removal stands. An id we have never seen is "unknown", which is a
   finding in itself and is never allowed to default to anything actionable. */
export function approvalState(entries, id, { now = Date.now() } = {}) {
  const key = usable(id);
  if (!key) return "unknown";
  return foldApprovals(entries, { now }).get(key)?.state ?? "unknown";
}

/* ------------------------------------------------------------ the wording */

/* One line a founder can act on. Every branch ends with what happens next,
   because a queue that says only what is wrong leaves the reader stuck. */
export function describeApproval(row, { now = Date.now() } = {}) {
  if (!row) return "Akeso has no record of that removal. Nothing is queued, so nothing will be removed.";

  const account = usable(row.account) || "An account whose name was not recorded";
  const because = row.reason ? ` ${asSentence(row.reason)}` : "";
  /* A dollar figure only when Stripe actually told us the price. */
  const price = typeof row.priceMonthly === "number" ? ` That is $${row.priceMonthly.toFixed(2)} a month at list price.` : "";
  const state = row.state || (row.ready ? "ready" : "queued");

  if (state === "approved") {
    return `${account}: you approved removing paid access. Akeso removes it on the next run and re-reads the account afterwards to confirm.`;
  }
  if (state === "cancelled") {
    return `${account}: the removal was cancelled, so nothing was taken away. That account keeps its access unless a later sweep queues it again.`;
  }
  if (state === "expired") {
    return `${account}: a removal was queued more than ${EXPIRY_DAYS} days ago and nobody answered, so it expired and nothing was removed. Run a sweep to see whether it is still true.`;
  }
  if (state === "ready") {
    return `${account} still has paid access.${because}${price} Approve it to take that access away, or cancel it. Nothing is removed until you choose.`;
  }

  const left = Math.max(1, Math.ceil(((msAt(row.readyAt) ?? now) - now) / 60000));
  return `${account} still has paid access.${because}${price} You can cancel this now. It cannot be approved for another ${minutesWord(left)}, and nothing is removed until you approve it.`;
}
