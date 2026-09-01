# Akeso

Does your app give paid access to exactly the people paying for it?

Three commands, one loop:

```
npx akeso-check            find out          grade A to F
npx akeso-check fix        repair it         preview, apply, always undoable
npx akeso-check monitor    keep it true      Stripe vs your real accounts, today
```

Check finds the problem. Fix writes the repair and Akeso proves it by running
the same test again, undoing itself if the proof fails. Monitor answers the
different question the code cannot: correct code from now on does not fix the
accounts that already drifted.

Every command ends by naming the next one, and every run appends to
`.akeso/ledger.jsonl` in your project, so the history is yours.

Runs on your machine. Nothing leaves it.

## Use

In your project folder:

```
npx akeso-check
```

Reads your code, writes `akeso-report.html`, and opens it. Seconds.

The full test, with your dev server running:

```
npx akeso-check --lifecycle-url http://localhost:3000
```

A pretend customer is run through ten billing situations: checkout, trial end,
renewal, a failing card, cancel at period end, immediate cancel, reactivation,
refund, the same event delivered twice, events out of order. After each one,
your app's own code is asked whether that customer still has paid access. The
report gets the graded results. About a minute.

The highest-fidelity test, if your project's env has your Stripe TEST key:

```
npx akeso-check --lifecycle-url http://localhost:3000 --sandbox
```

Real customers and subscriptions are created in your own Stripe test sandbox,
a Stripe test clock moves time forward (a 7-day trial ending, a month
passing), and Stripe's own events are delivered to your app: subscribe, trial
conversion, monthly renewal, cancel at period end, cancellation. Everything
created is deleted afterwards. Refuses to run with anything but a test-mode
key (sk_test_...). A few minutes.

Options:

- `--sandbox` real Stripe events from your own test sandbox, including trial
  and renewal via a test clock (needs your test key in the project's env)
- `--account <id>` run every scenario against one real account id (for deployed
  test environments; the account is reset between scenarios)
- `--probe-url <url>` a deployed app's own guarded probe, token included, so
  the Check does not try to install a temporary one over a live deploy
- `--webhook-secret <whsec_...>` override the signing secret (normally read
  from your project's env files, locally)
- `--html <path>` where to write the report
- `--no-open` do not open the report
- `--json` machine-readable output instead

## Fix

```
npx akeso-check fix                   what it would change, and why
npx akeso-check fix --show            the code it would write
npx akeso-check fix --apply           write it
npx akeso-check fix --revert          put everything back
```

It refuses to run until a Check has found something, because a repair with no
evidence behind it is guesswork. It writes four files: the corrected webhook
handler, one entitlement module that is the only file touching your database,
a reconciliation job for events that never arrived, and a SQL migration you
paste yourself (Akeso never runs schema changes).

Before writing anything it requires a clean git tree, moves to its own branch,
and backs up every file it replaces. Generated files are marked
`DO NOT EDIT`, and `--revert` refuses to touch any file you edited afterwards.

Add `--verify-url http://localhost:3000` and Akeso proves the repair by
re-running the full lifecycle test against your running app, and reverts the
whole thing automatically if its own test disagrees.

Add `--with-endpoints` to also generate the two endpoints the monitor needs.
They are opt-in, because a founder who only wanted their webhook repaired
should not silently get a write path into their own app.

## Monitor

Correct code from now on does not fix the accounts that already drifted.
Monitor answers the question the code cannot: right now, today, does every
person's access match what they pay?

Three steps, in order:

```
npx akeso-check fix --apply --with-endpoints
npx akeso-check certify
npx akeso-check monitor --entitlements-url https://yourapp.com/api/akeso/entitlements
```

`--with-endpoints` adds two small files to your app: one that lets Akeso read
who currently has access, and one that lets it change a single account's
access through your own guarded function. Both refuse every request not
signed with a secret that is generated on your machine and printed once.
Delete the restore file and Akeso can no longer write to your app at all.

`certify` asks a few plain questions about how you want your customers
treated (what happens when a card fails, when a subscription pauses, on a
refund). Akeso does not watch an app until you have answered them, and it
stops if your database schema changes underneath the answers.

`monitor` compares Stripe against your app's real accounts. It states the rule
it used before it states any finding, and it declines to judge what it cannot:
a subscription set to cancel at period end still counts as paying, an account
mid-checkout gets no verdict, and an account with no Stripe subscription at
all is reported, never accused. If no Stripe subscription matches any account
your app reported, it says nothing could be compared rather than calling that
clean.

**Akeso restores access on its own. It never removes access on its own.**
With `--apply --restore-url <url>`, a paying customer who is locked out is let
back in immediately and the change is read back to confirm. A cancelled
customer who still has access is queued for you:

```
npx akeso-check approvals                    what is waiting for your yes
npx akeso-check approvals --approve <id>     take that account's access away
npx akeso-check approvals --cancel <id>      leave it alone
```

Removals are capped at 3 per sweep and 3 per hour, never applied to an account
granted access in the last 7 days, and a removal cannot be sent without naming
the approval that authorised it. A kill switch (`.akeso/HALT`) stops every
write, grants included.

```
npx akeso-check statement                    the month, in plain numbers
npx akeso-check statement --html out.html    the same thing as a page
```

The statement keeps three numbers apart and never adds them: access restored,
access removed, and exposure at list price. Revenue recovered is reported as
unmeasured, because Akeso cannot see your payouts. A month in which Akeso did
not run is reported as not run, never as clean. Akeso also measures how often
its own findings were right, and a rule that is wrong more than half the time
is demoted to record-only until it earns its way back.

## Privacy

There is no account and no server. Your code, keys, and customer data are read
locally and sent nowhere. The report is a file on your disk. The package has
zero dependencies and every line is plain JavaScript you can read.

Lifecycle tests refuse to run against a project configured with a live-mode
Stripe key. The temporary access probe it adds during a run is removed when
the run ends, and it never writes anything else to your app.

## Honesty rules

- Every result comes from an executed run. Nothing is stubbed.
- A dead server, a rejected delivery, or any failure of the tool itself is
  reported as "could not test", never as your app's grade.
- A pass that cannot be proven (for example, access that was already on) is
  reported as not provable, never as a pass.

## Covers

Stripe Billing subscriptions on Next.js or Node apps with Postgres or
Supabase. One plan field, one active subscription per account. Anything else
is out of scope and the report says so.
