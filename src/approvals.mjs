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

/* The clock, in milliseconds, or nothing at all. A Date object handed in here
   would be concatenated rather than added, and the row would be written with
   readyAt equal to queuedAt: a removal with no cancel window, created silently.
   Anything that is not a time we can do arithmetic on is refused instead. */
const clockMs = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/* A price is only a price if it can be printed. NaN, Infinity and a negative
   figure all reach the founder as "$NaN a month", which is worse than silence:
   a number Akeso cannot stand behind must not appear at all. */
const money = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/* Every founder-facing line is one line. The queue prints as a list, and an
   account name or a Stripe reason carrying a newline would split one removal
   into two rows that each look like a separate removal. */
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

const minutesWord = (count) => `${count} minute${count === 1 ? "" : "s"}`;
const asSentence = (text) => `${oneLine(text).replace(/[.\s]+$/, "")}.`;

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

  /* Without a readable clock there is no window, and a window is the whole
     protection. Refusing costs one sweep; guessing costs a customer. */
  const at = clockMs(now);
  if (at === null) throw new Error("a queued removal needs the current time in milliseconds, so nothing was queued and nothing will be removed");

  /* A window at or past the expiry would queue a removal that ages out before
     any human is allowed to approve it, and a window of billions of minutes
     throws on the date maths instead of queuing anything. Neither is a delay we
     can honour, so both fall back to the documented one rather than writing a
     row that cannot work. The number actually used is stored on the entry, so
     the window and the ledger can never disagree about it. */
  const minutes = Number.isFinite(delayMinutes) && delayMinutes >= 0 && delayMinutes < EXPIRY_DAYS * 24 * 60
    ? delayMinutes
    : DEFAULT_DELAY_MINUTES;
  const queuedAt = new Date(at).toISOString();

  const entry = await appendEntry(root, {
    kind: "approval",
    id: randomUUID(),
    state: "queued",
    account: usable(account),
    reason,
    /* Only a price we were actually told. A missing price stays null and the
       founder-facing line simply says no dollar figure. */
    priceMonthly: money(priceMonthly),
    /* What the app looked like when this was queued. The executor compares it
       against a fresh read before acting, so an account that changed in the
       meantime is skipped instead of overwritten. */
    expectedState: expectedState ?? null,
    /* Which policy version produced this verdict. A removal read back next
       month means nothing without knowing the rule that justified it. */
    ruleVersion: ruleVersion ?? null,
    delayMinutes: minutes,
    queuedAt,
    readyAt: new Date(at + minutes * 60000).toISOString(),
  });

  /* Read it back before calling it queued. A line the fold cannot see is a
     question nobody will be asked, and telling a founder that a removal is
     waiting on them when the queue is in fact empty is its own kind of lie. */
  const stored = approvalState(await readLedger(root), entry.id, { now: at });
  if (stored !== "queued" && stored !== "ready") {
    throw new Error("Akeso wrote the queued removal but could not read it back, so nothing is queued and nothing will be removed. Look at .akeso/ledger.jsonl.");
  }
  return entry;
}

/* -------------------------------------------------------------- decisions */

const refusal = (id, state, message) => ({ ok: false, id, state, entry: null, confirmed: false, message });

/* A human says yes. Refused unless the row is queued and its cancel window has
   passed, because a window that a tap can skip is decoration, and being slow to
   remove access has never been the failure that hurts anyone. */
export async function approve(root, id, { by = null, now = Date.now() } = {}) {
  const key = usable(id);
  const row = key ? foldApprovals(await readLedger(root), { now }).get(key) : undefined;
  const state = row?.state ?? "unknown";

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
    const { at, readyMs, readable } = timing(row, now);
    /* No countdown unless there is a countdown to give. A row whose timestamps
       cannot be read would otherwise be told "another 1 minute" every minute
       forever, which points the founder at a button that will never work. */
    if (!readable) {
      return refusal(key, state, "Akeso cannot read the times on that queued removal, so it will not approve it. Nothing was removed. Cancel it to clear it from the list, then run a sweep to queue it again.");
    }
    const left = Math.max(1, Math.ceil((readyMs - at) / 60000));
    return refusal(key, state, `That removal is still inside its cancel window for another ${minutesWord(left)}, so it cannot be approved yet. Nothing was removed. You can cancel it now, or approve it once the window ends.`);
  }

  const entry = await appendEntry(root, {
    kind: "approval",
    id: key,
    state: "approved",
    by: by || null,
    /* Reached only when the window was proved to have passed, so the clock is
       readable here by construction. */
    decidedAt: new Date(clockMs(now)).toISOString(),
  });

  /* Read it back before saying it worked. A write we did not confirm is not a
     result, here or anywhere else in this product. The state reported is the
     one the ledger actually holds afterwards, never a placeholder: if someone
     cancelled this a second earlier, that is the fact the founder needs, not a
     hunt for a broken write that did not happen. */
  const after = approvalState(await readLedger(root), key, { now });
  const confirmed = after === "approved";
  return {
    ok: confirmed,
    id: key,
    state: after,
    entry,
    confirmed,
    message: confirmed
      ? `Approved${by ? ` by ${by}` : ""}. Nothing has changed in your app yet. The removal is now cleared to run, and Akeso re-reads that account afterwards to confirm it worked.`
      : after === "cancelled"
        ? "That removal was cancelled before this approval landed, and a cancellation is final. Nothing was removed, and that account keeps its access."
        : `Akeso wrote the approval but could not confirm it: the queue now reads that removal as ${after}. Nothing was removed. Look at .akeso/ledger.jsonl before trying again.`,
  };
}

/* A human says no. Allowed at any point before the row is decided, including
   before the window ends and after it has expired: stopping a removal is always
   the safe direction, so it is never delayed and never rate limited. */
export async function cancel(root, id, { by = null, reason = null, now = Date.now() } = {}) {
  const key = usable(id);
  const state = key ? approvalState(await readLedger(root), key, { now }) : "unknown";
  /* Cancelling is the safe direction, so it is allowed even when the clock or
     the row's own timestamps are unreadable: whatever else is true here,
     nothing gets removed. */
  const at = clockMs(now);

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
    /* A clock we could not read is left empty rather than written as 1970. The
       ledger stamps every line with its own time, so the fold still knows when
       this happened without this file inventing it. */
    decidedAt: at === null ? null : new Date(at).toISOString(),
  });

  const after = approvalState(await readLedger(root), key, { now });
  const confirmed = after === "cancelled";
  return {
    ok: confirmed,
    id: key,
    state: after,
    entry,
    confirmed,
    message: confirmed
      ? "Cancelled. That account keeps its access, and Akeso will not queue this same removal again until a sweep finds it again."
      : after === "approved"
        ? "That removal was approved before this cancellation landed, and an approval is final. If that account should keep its access, grant it back instead: grants are instant and safe."
        : `Akeso wrote the cancellation but could not confirm it: the queue now reads that removal as ${after}. Treat it as still queued and look at .akeso/ledger.jsonl.`,
  };
}

/* ------------------------------------------------------------- the fold */

/* The three clock facts a queued removal needs before anyone can act on it.
   Kept in one place so the sentence a founder reads and the rule the fold
   applies can never disagree about whether a row has a future. */
function timing(row, now) {
  const at = clockMs(now);
  const queuedMs = msAt(row?.queuedAt);
  const readyMs = msAt(row?.readyAt);
  return { at, queuedMs, readyMs, readable: at !== null && queuedMs !== null && readyMs !== null };
}

/* Derived, never stored. "ready" and "expired" are both facts about the clock,
   and writing a fact about the clock down is how a queue starts lying. */
function derive(row, now) {
  if (row.stored === "approved") return { state: "approved", ready: false };
  if (row.stored === "cancelled") return { state: "cancelled", ready: false };

  const { at, queuedMs, readyMs, readable } = timing(row, now);

  /* Expiry rests on queuedAt alone, so a row we can date still ages out even
     when the rest of its timestamps are broken. */
  if (at !== null && queuedMs !== null && at - queuedMs >= EXPIRY_MS) return { state: "expired", ready: false };

  /* Ready needs all three. A readyAt we cannot read is not a window that has
     passed, and a queuedAt we cannot read means we cannot prove the row is not
     months stale, which is the exact thing the seven day rule exists to stop.
     Either way the row stays visible so a human can cancel it, and stays
     unapprovable: unprovable is never a pass, and least of all for the one
     action that can lock a paying customer out. */
  const ready = readable && at >= readyMs;
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
        priceMonthly: money(entry.priceMonthly),
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
  const waiting = [...foldApprovals(entries, { now }).values()]
    .filter((row) => row.state === "queued" || row.state === "ready")
    .map((row, index) => ({ row, index, queuedMs: msAt(row.queuedAt) }));

  /* Oldest question first, by when the removal was queued rather than by where
     its line landed in the file. The two agree right up until two sweeps write
     out of order, and the founder should always be answering the longest wait.
     A row with no readable queuedAt can never be approved, so it sorts last
     instead of sitting at the top of the list looking urgent. */
  waiting.sort((a, b) => {
    if (a.queuedMs === null && b.queuedMs === null) return a.index - b.index;
    if (a.queuedMs === null) return 1;
    if (b.queuedMs === null) return -1;
    return a.queuedMs - b.queuedMs || a.index - b.index;
  });

  return waiting.map(({ row: { id, account, reason, priceMonthly, queuedAt, readyAt, ready, expectedState } }) =>
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

  const account = usable(row.account) ? oneLine(row.account) : "An account whose name was not recorded";
  /* Account names and Stripe reasons are somebody else's text. Folded onto one
     line here so a newline in either cannot split one removal into two rows a
     founder reads as two removals. */
  const because = usable(row.reason) ? ` ${asSentence(row.reason)}` : "";
  /* A dollar figure only when Stripe actually told us a price we can print. */
  const amount = money(row.priceMonthly);
  const price = amount === null ? "" : ` That is $${amount.toFixed(2)} a month at list price.`;
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

  const { at, readyMs, readable } = timing(row, now);
  /* A countdown is only printed when there is one to give. "Another 1 minute"
     on a row whose timestamps cannot be read repeats the same minute forever
     and sends the founder back to a button that will never work. */
  if (!readable) {
    return `${account} still has paid access.${because}${price} Akeso cannot read the times on this queued removal, so it will not offer to approve it. Cancel it to clear it from the list, then run a sweep to queue it again.`;
  }
  const left = Math.max(1, Math.ceil((readyMs - at) / 60000));
  return `${account} still has paid access.${because}${price} You can cancel this now. It cannot be approved for another ${minutesWord(left)}, and nothing is removed until you approve it.`;
}
