import { lastOfKind } from "./ledger.mjs";

/* Where the founder is in the loop, and the one thing to do next.
 *
 * The whole product is a circle:
 *
 *   check  ->  fix  ->  check again (does the repair hold?)  ->  monitor
 *     ^                                                            |
 *     +------------------ monitor finds drift ---------------------+
 *
 * Every command ends by calling this and printing the answer, so a founder
 * never has to hold the sequence in their head. Defined once, here, because
 * three commands each inventing their own idea of "next" is how a tool starts
 * contradicting itself.
 */

export function nextStep({ ledger = [], detection = null, lifecycle = null, sandbox = null } = {}) {
  const check = lastOfKind(ledger, "check");
  const fix = lastOfKind(ledger, "fix");
  const grade = sandbox?.grade?.letter || lifecycle?.grade?.letter || check?.grade || null;
  const ranLive = Boolean(lifecycle || sandbox || check?.lifecycleGrade || check?.sandboxGrade);
  const edgeFunction = detection?.webhookHandlers?.[0]?.file?.startsWith("supabase/functions/");

  if (!check && !detection) {
    return {
      stage: "start",
      headline: "Nothing has been checked yet.",
      why: "Akeso needs to look at your code before it can say anything about it.",
      command: "npx akeso-check",
    };
  }

  if (!ranLive) {
    if (edgeFunction) {
      /* Lovable and Bolt exports. The webhook is a Deno function served by
         the Supabase CLI, so the address and the start-up steps differ. */
      return {
        stage: "needs-live-test",
        headline: "Next: the real test, where a pretend customer pays and cancels.",
        why: "Reading code shows what your app is supposed to do. Only running it shows what it actually does. Your webhook is a Supabase Edge Function, so it runs under the Supabase CLI.",
        command: "npx akeso-check --lifecycle-url http://127.0.0.1:54321",
        firstDoThis: "start Supabase locally: npx supabase start, then npx supabase functions serve --env-file .env --no-verify-jwt",
      };
    }
    return {
      stage: "needs-live-test",
      headline: "Next: the real test, where a pretend customer pays and cancels.",
      why: "Reading code shows what your app is supposed to do. Only running it shows what it actually does.",
      command: "npx akeso-check --lifecycle-url http://localhost:3000",
      firstDoThis: "start your app the way you normally do (usually: npm run dev)",
    };
  }

  /* A failing grade with no fix yet, or a fix that did not hold. */
  if (grade && grade !== "A" && grade !== "?") {
    const fixedSince = fix && check && fix.seq > check.seq;
    if (fixedSince) {
      return {
        stage: "fix-did-not-hold",
        headline: "The repair is in, but the test still fails.",
        why: "Akeso will not call a repair successful when its own test disagrees. Something in the generated code needs a human look, most likely the one file that touches your database.",
        command: "npx akeso-check fix --show",
      };
    }
    return {
      stage: "needs-fix",
      headline: `Next: repair what the ${grade} is about.`,
      why: "Akeso can write the corrected webhook handler, the one entitlement function, and the nightly backstop, then you re-run this test to prove the repair.",
      command: "npx akeso-check fix",
    };
  }

  if (grade === "?") {
    return {
      stage: "could-not-test",
      headline: "The run itself had problems, so there is no verdict yet.",
      why: "This is about the run, not about your app. Usually the app was not running at the address given.",
      command: "npx akeso-check --lifecycle-url http://localhost:3000",
    };
  }

  /* Grade A. The code is right; the question becomes whether it stays right
     and whether today's live data agrees. */
  const sweep = lastOfKind(ledger, "sweep");

  if (sweep?.couldNotRun) {
    return {
      stage: "sweep-could-not-run",
      headline: "The last check of your real customers could not run.",
      why: `It stopped with: ${sweep.couldNotRun}. That is a problem with the run, not a verdict about your billing.`,
      command: "npx akeso-check monitor --entitlements-url http://localhost:3000/api/akeso/entitlements",
    };
  }

  if (sweep && (sweep.comparison?.counts?.matched ?? 0) === 0) {
    /* The most common real-world snag, and one a founder cannot guess at:
       Stripe and the app disagree about what an account is called. */
    return {
      stage: "nothing-matched",
      headline: "Nothing could be compared yet, so nothing is proven about your customers.",
      why: "No Stripe subscription matched any account your app reported. Stripe has to carry the same account id your app uses, in client_reference_id or in the subscription's metadata.",
      command: null,
    };
  }

  if (sweep) {
    const clean = sweep.comparison?.clean;
    const queued = sweep.drift?.removalsQueued || 0;
    if (queued > 0) {
      return {
        stage: "approvals-waiting",
        headline: `${queued} removal${queued === 1 ? " is" : "s are"} waiting for your yes.`,
        why: "Akeso restores access on its own, but it never takes access away without a person deciding. Nothing has happened to those accounts.",
        command: "npx akeso-check approvals",
      };
    }
    return {
      stage: "watching",
      headline: clean ? "Everything matches right now." : "The last run found accounts that do not match.",
      why: clean
        ? "Nothing to do. Run this again whenever you deploy, or on a schedule, and read the month with the statement."
        : "Look at the list above and decide what to do about each one.",
      command: clean ? "npx akeso-check statement" : "npx akeso-check approvals",
    };
  }

  return {
    stage: "monitor",
    headline: fix ? "The repair holds. Next: check that today's real customers match." : "Your billing code passes. Next: check that today's real customers match.",
    why: "Correct code from now on does not fix the accounts that already drifted. The monitor compares who Stripe says is paying against who your app lets in, right now.",
    command: "npx akeso-check monitor",
  };
}

/* One consistent block of terminal output for the step, used by all three
   commands so they cannot drift apart in tone or shape. */
export function printNextStep(step) {
  if (!step) return;
  console.log(`\n${step.headline}`);
  if (step.why) console.log(`  ${step.why}`);
  if (step.firstDoThis) console.log(`\n  1. ${step.firstDoThis}`);
  if (step.command) console.log(`${step.firstDoThis ? "  2. " : "\n  "}${step.command}`);
}
