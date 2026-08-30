# Akeso Check

One command a founder runs inside their own Stripe-backed SaaS project. It
answers: **when someone pays, cancels, or their card fails — does your app get
it right?** Grade A to F, plain English, and a live mismatch list with the
dollar exposure. Nothing leaves the machine.

## The rules this tool is built under (from AKESO_MASTER_V5)
- Nothing is transmitted anywhere. No credentials are ever stored.
- Refuses to run lifecycle tests against a live-mode Stripe key. Live keys are
  accepted only for the optional read-only snapshot.
- Never writes to any table except its own temporary access probe, removed on exit.
- Findings name the mechanism, never a vendor.
- Every result comes from an executed run. No stubbed checks.
- Billing entitlement is what we test — never the final access decision
  (admin blocks and abuse blocks are reported, never touched).

## Acceptance (all must pass before READY)
1. On a sample app with a deliberately broken (grant-only) webhook handler:
   reports **F**, with the cancel scenario failing.
2. On the same app after the fix: reports **A**.
3. Prints the exact Stripe API and CLI versions used.
