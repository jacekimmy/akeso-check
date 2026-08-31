# Akeso Check

Tests whether your Stripe-backed app grants and revokes paid access correctly.
When someone pays, cancels, fails a card, or gets a refund, does your app get
it right? Grade A to F, in plain English.

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

Options:

- `--account <id>` run every scenario against one real account id (for deployed
  test environments; the account is reset between scenarios)
- `--webhook-secret <whsec_...>` override the signing secret (normally read
  from your project's env files, locally)
- `--html <path>` where to write the report
- `--no-open` do not open the report
- `--json` machine-readable output instead

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
