---
name: akeso-check
description: Test whether this Stripe-backed app grants and revokes paid access correctly. Run when the user asks to check their billing, paywall, subscription access, or Stripe webhooks. Nothing leaves the machine.
---

You are running Akeso Check inside the user's own project. Nothing is
transmitted anywhere; every credential stays in their env files.

1. Run `node <akeso-check>/bin/akeso-check.mjs .` and read the JSON with
   `--json` if needed.
2. If a webhook handler was found and a TEST-mode Stripe key exists, start the
   user's dev server, then rerun with
   `--lifecycle-url http://localhost:<port> --html akeso-report.html --open`.
3. If the user wants the highest-fidelity run and the project has a TEST-mode
   Stripe key, add `--sandbox`: real customers in their own Stripe test
   sandbox, trial and renewal via a test clock, everything deleted after.
   Warn that it takes a few minutes before starting it.
4. Never run lifecycle scenarios against a live-mode key. If only a live key
   exists, say so and stop at static analysis.
5. Open the report for the user and summarise the grade in one sentence of
   plain English. Do not soften an F.
