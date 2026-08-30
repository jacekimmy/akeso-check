import { scenarios, signPayload } from "./stripe-events.mjs";

/* Delivers the lifecycle scenarios to a running app and grades what its own
 * billing entitlement says after each one.
 *
 * Discipline carried from the product-care engine: a delivery failure is OUR
 * problem (server down, connection refused) and produces "could not test",
 * never a failing grade for the app. Only the app's own answer to "is this
 * person entitled?" can pass or fail a scenario.
 */

async function deliver(webhookUrl, event, webhookSecret) {
  const rawBody = JSON.stringify(event);
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signPayload(rawBody, webhookSecret),
    },
    body: rawBody,
  });
  return { status: response.status, ok: response.ok };
}

async function probe(probeUrl, account) {
  const response = await fetch(`${probeUrl}?account=${encodeURIComponent(account)}`);
  if (!response.ok) throw new Error(`probe returned ${response.status}`);
  const body = await response.json();
  if (typeof body.billingEntitled !== "boolean") throw new Error("probe did not return billingEntitled");
  return body.billingEntitled;
}

export async function runLifecycle({ webhookUrl, probeUrl, webhookSecret }) {
  const results = [];

  for (const scenario of scenarios()) {
    const deliveries = [];
    let harnessError = null;
    try {
      for (const event of scenario.events) {
        deliveries.push({ type: event.type, ...(await deliver(webhookUrl, event, webhookSecret)) });
        /* Small gap so file-backed fixtures and debounced handlers settle. */
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } catch (error) {
      harnessError = error?.message || String(error);
    }

    let observed = null;
    let probeError = null;
    if (!harnessError) {
      try { observed = await probe(probeUrl, scenario.account); } catch (error) { probeError = error?.message || String(error); }
    }

    const graded = scenario.expect !== null && !harnessError && !probeError;
    results.push({
      id: scenario.id,
      name: scenario.name,
      expected: scenario.expect,
      observed,
      deliveries,
      outcome: harnessError || probeError
        ? "could_not_test"          /* our fault, never the app's */
        : scenario.expect === null
          ? "reported"              /* refund policy: shown, not graded */
          : observed === scenario.expect ? "pass" : "fail",
      critical: Boolean(scenario.critical),
      harnessError: harnessError || probeError || null,
    });
  }

  return { results, grade: gradeOf(results), scenarioCount: results.length };
}

/* One letter a founder understands. F is reserved for the failure that costs
   money every single day: canceled customers keeping access. */
export function gradeOf(results) {
  const graded = results.filter((r) => r.outcome === "pass" || r.outcome === "fail");
  const untestable = results.filter((r) => r.outcome === "could_not_test");
  if (graded.length === 0) return { letter: "?", reason: "Nothing could be tested — see the errors below. This is a problem with the run, not proof about the app." };

  const failures = graded.filter((r) => r.outcome === "fail");
  const criticalFailure = failures.find((r) => r.critical);

  const letter = criticalFailure ? "F"
    : failures.length === 0 ? (untestable.length ? "B" : "A")
    : failures.length === 1 ? "C"
    : "D";

  const reason = criticalFailure
    ? "Customers who cancel keep their paid access. This leaks money every day until it is fixed."
    : failures.length === 0
      ? untestable.length
        ? `Every tested scenario passed, but ${untestable.length} could not be tested.`
        : "Every lifecycle scenario passed."
      : `${failures.length} lifecycle scenario${failures.length === 1 ? "" : "s"} failed.`;

  return { letter, reason, failures: failures.map((r) => r.id), untested: untestable.map((r) => r.id) };
}
