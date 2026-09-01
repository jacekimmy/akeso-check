/* The report a founder actually sees: a local HTML file that opens in their
 * browser. It looks like a website; it is a file on their machine, and saying
 * so prominently is part of the product — the whole trust story is "nothing
 * left your computer."
 *
 * Design rules, inherited from the product-care dashboard: plain English
 * first, colour only where it carries state, nothing on the page that was not
 * measured, and the limits of the run stated as prominently as the findings.
 */

import { JOURNEY_CSS, buildJourney, renderJourney } from "./journey.mjs";
import { nextStep } from "./next-step.mjs";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const GRADE_COPY = {
  A: "Your billing lifecycle holds up.",
  B: "Nothing failed, but some scenarios could not be tested.",
  C: "One lifecycle scenario fails.",
  D: "Several lifecycle scenarios fail.",
  F: "Canceled customers keep paid access.",
  "?": "The run itself had problems. This is not a verdict on your app.",
};

export function renderReport({ detection, lifecycle, sandbox, ledger = [], step = null, generatedAt = new Date() }) {
  /* The loop, drawn from what actually executed. A founder reading this page
     should be able to answer "where am I and what happens next" before reading
     a single finding. */
  const journey = buildJourney({ detection, lifecycle, sandbox, ledger });
  const journeyHtml = renderJourney(journey, { escape: escapeHtml });
  /* Static-only is a normal, successful outcome, not a broken run. Saying "the
     run had problems" over a clean code read was the first thing a real user
     hit, and it also let the page claim scenarios were acted out when nothing
     had executed. Nothing on this page may describe work that did not happen. */
  const staticOnly = !lifecycle && !sandbox;
  /* One letter on the card. When both drivers ran, the worse one wins: a
     clean synthetic pass never papers over a real-event failure, or the other
     way round. "?" (nothing testable) defers to any driver that did test. */
  const rank = { "?": 0, A: 1, B: 2, C: 3, D: 4, F: 5 };
  const grades = [lifecycle?.grade, sandbox?.grade].filter(Boolean);
  const grade = grades.length ? grades.reduce((a, b) => (rank[b.letter] > rank[a.letter] ? b : a)) : null;
  const handler = detection.webhookHandlers?.[0] || null;

  const staticFindings = [];
  if (!handler) {
    staticFindings.push({ tone: "bad", text: "No Stripe webhook handler was found. Payment events from Stripe have nowhere to land." });
  } else {
    if (!handler.verifiesSignature) staticFindings.push({ tone: "bad", text: "The webhook handler does not verify Stripe's signature. Anyone who finds the URL can forge payment events." });
    else if (!handler.rawBodySeen) staticFindings.push({ tone: "warn", text: "Signature verification exists, but raw-body handling was not seen. Verification like this often fails at runtime." });
    if (handler.missingEvents?.length) staticFindings.push({ tone: "warn", text: `The handler ignores ${handler.missingEvents.length} of the 7 lifecycle events: ${handler.missingEvents.join(", ")}.` });
    if (staticFindings.length === 0) staticFindings.push({ tone: "ok", text: "Signature verified against the raw body, and all 7 lifecycle events are handled." });
  }
  const clientGate = (detection.accessDecisionSites || []).find((site) => site.clientSideOnly);
  if (clientGate) staticFindings.push({ tone: "warn", text: `Paid access appears to be checked in the browser (${clientGate.file}), a gate anyone can step around with devtools.` });

  const edgeFunction = handler?.file?.startsWith("supabase/functions/");
  const staticHeadline = !handler ? "No Stripe webhook handler was found."
    : !handler.verifiesSignature ? "Your webhook does not verify Stripe's signature."
    : handler.missingEvents?.length ? `Your webhook ignores ${handler.missingEvents.length} of the 7 billing events.`
    : "Your billing code reads clean.";

  const scenarioRows = (lifecycle?.results || []).map((result) => {
    const mark = result.outcome === "pass" ? "✓"
      : result.outcome === "fail" ? "✗"
      : result.outcome === "reported" ? "•" : "?";
    const cls = result.outcome === "pass" ? "ok"
      : result.outcome === "fail" ? (result.critical ? "bad" : "warn")
      : result.outcome === "reported" ? "note" : "mute";
    const detail = result.outcome === "fail"
      ? (result.expected ? "access should have been granted, but your app says no" : "access should have ended, but your app still grants it")
      : result.outcome === "reported" ? `your app's policy: ${result.observed ? "keeps access" : "removes access"}`
      : result.outcome === "could_not_test" ? escapeHtml(result.harnessError)
      : result.outcome === "not_provable" ? escapeHtml(result.note || "not provable on this run") : "";
    return `<div class="row ${cls}"><span class="mark">${mark}</span><span class="name">${escapeHtml(result.name)}</span><span class="detail">${detail}</span></div>`;
  }).join("\n");

  const sandboxRows = (sandbox?.phases || []).map((phase) => {
    const mark = phase.outcome === "pass" ? "✓" : phase.outcome === "fail" ? "✗" : "?";
    const cls = phase.outcome === "pass" ? "ok"
      : phase.outcome === "fail" ? (phase.critical ? "bad" : "warn") : "mute";
    const detail = phase.outcome === "fail"
      ? (phase.expected ? "access should have been granted, but your app says no" : "access should have ended, but your app still grants it")
      : phase.outcome === "pass" ? ""
      : escapeHtml(phase.reason || "not provable on this run");
    return `<div class="row ${cls}"><span class="mark">${mark}</span><span class="name">${escapeHtml(phase.phase)}</span><span class="detail">${detail}</span></div>`;
  }).join("\n");

  const findingRows = staticFindings.map((finding) =>
    `<div class="row ${finding.tone}"><span class="mark">${finding.tone === "ok" ? "✓" : finding.tone === "bad" ? "✗" : "!"}</span><span class="name wide">${escapeHtml(finding.text)}</span></div>`,
  ).join("\n");

  /* One next action, from the same ladder the terminal uses, so the page and
     the command line can never tell a founder two different things. */
  const chosenStep = step || nextStep({ ledger, detection, lifecycle, sandbox });
  const nextBox = chosenStep ? `<div class="nextBox">
    <div class="nextLabel">Do this next</div>
    <h3>${escapeHtml(chosenStep.headline)}</h3>
    ${chosenStep.why ? `<p>${escapeHtml(chosenStep.why)}</p>` : ""}
    ${chosenStep.firstDoThis ? `<ol><li>${escapeHtml(chosenStep.firstDoThis)}</li><li>run the command below</li></ol>` : ""}
    ${chosenStep.command ? `<pre class="cmd">${escapeHtml(chosenStep.command)}</pre>` : ""}
  </div>` : "";

  const limits = [
    staticOnly
      ? "Nothing was executed. This is a read of your code, so it cannot tell you what your app really does when a customer cancels."
      : "Only the billing lifecycle was tested. Not login, checkout UI, or anything else.",
    staticOnly || sandbox
      ? null
      : "Events were delivered locally with your app's own webhook secret. If your handler re-fetches objects from Stripe's API, add --sandbox (with your Stripe test key in the project's env) for full fidelity.",
    sandbox
      ? `Real Stripe events covered subscribing, trial conversion, one monthly renewal, and cancellation. Failing cards, refunds, duplicates, and out-of-order delivery were ${lifecycle ? "exercised with locally synthesized events only" : "not tested on this run"}.`
      : null,
    detection.capabilities?.blockers?.length ? `Not possible on this project yet: ${detection.capabilities.blockers.join(" ")}` : null,
  ].filter(Boolean).map((limit) => `<li>${escapeHtml(limit)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso Check · ${escapeHtml(detection.framework?.packageName || "your app")}</title>
<style>
  :root { --bg:#f5f6f8; --card:#ffffff; --ink:#16181d; --ink2:#4f5666; --ink3:#878e9b; --line:#e8eaee;
    --ok:#12784b; --warn:#96620a; --bad:#b3261e; --note:#2f4a78; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0e12; --card:#14171d; --ink:#e9ebef; --ink2:#a8aeba;
    --ink3:#767d8a; --line:#262b33; --ok:#4cbe83; --warn:#dfa94c; --bad:#ef8578; --note:#8aa9dc; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:664px; margin:0 auto; padding:32px 20px 64px; }
  .local { text-align:center; font-size:12.5px; color:var(--ink3); margin:0 0 18px; }
  .shell { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:40px 48px 44px;
    box-shadow:0 1px 2px rgba(16,20,28,.04), 0 8px 24px -18px rgba(16,20,28,.18); }
  .brand { display:flex; align-items:baseline; gap:7px; padding-bottom:24px; margin-bottom:36px; border-bottom:1px solid var(--line); }
  .brand .wordmark { font-size:15px; font-weight:600; letter-spacing:-.01em; }
  .brand .wordmarkSub { font-size:15px; color:var(--ink3); }
  .brand .when { margin-left:auto; font-size:12.5px; color:var(--ink3); font-variant-numeric:tabular-nums; }
  .gradeCard { display:flex; gap:26px; align-items:center; }
  .gradeLetter { flex:none; width:88px; height:88px; border-radius:18px; display:flex; align-items:center; justify-content:center;
    font-size:50px; font-weight:600; letter-spacing:-.03em; }
  .g-A,.g-B { color:var(--ok); background:color-mix(in srgb, var(--ok) 9%, transparent); }
  .g-C { color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, transparent); }
  .g-D,.g-F { color:var(--bad); background:color-mix(in srgb, var(--bad) 9%, transparent); }
  .g-\\? { color:var(--ink3); background:color-mix(in srgb, var(--ink3) 11%, transparent); }
  .gradeCard h1 { margin:0 0 7px; font-size:22px; font-weight:600; letter-spacing:-.015em; line-height:1.25; }
  .gradeCard p { margin:0; color:var(--ink2); font-size:14.5px; }
  .app { font-size:12.5px; color:var(--ink3); margin-top:10px; }
  h2 { font-size:11.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); margin:46px 0 4px; }
  .intro { margin:4px 0 14px; color:var(--ink2); font-size:13.5px; max-width:56ch; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; gap:12px; padding:12px 2px; border-bottom:1px solid var(--line); align-items:baseline; font-size:14px; }
  .mark { width:18px; text-align:center; flex:none; font-weight:600; }
  .row.ok .mark { color:var(--ok); } .row.warn .mark { color:var(--warn); }
  .row.bad .mark { color:var(--bad); } .row.bad .name { color:var(--bad); font-weight:600; }
  .row.note .mark { color:var(--note); } .row.mute { color:var(--ink3); }
  .name { flex:1; } .name.wide { flex:auto; }
  .detail { color:var(--ink3); font-size:12.5px; text-align:right; max-width:40%; }
  ul.limits { margin:8px 0 0; padding-left:18px; color:var(--ink2); font-size:13.5px; }
  ul.limits li { margin-bottom:7px; }
  .cta { margin-top:48px; border:1px solid var(--line); border-radius:12px; padding:24px 26px;
    background:color-mix(in srgb, var(--ink) 2.5%, transparent); }
  .cta h3 { margin:0 0 6px; font-size:16px; font-weight:600; } .cta p { margin:0 0 16px; color:var(--ink2); font-size:13.5px; }
  .cta a { display:inline-block; background:var(--ink); color:var(--card); text-decoration:none; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:500; }
  footer { margin-top:24px; text-align:center; font-size:12px; color:var(--ink3); }
  pre.cmd { background:color-mix(in srgb, var(--ink) 5%, transparent); border-radius:8px; padding:13px 15px; overflow-x:auto;
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; margin:0; }
  code.inline { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .loopHead { margin:40px 0 18px; }
  .loopHead h2 { margin:0 0 3px; }
  .loopHead p { margin:0; font-size:13.5px; color:var(--ink2); max-width:56ch; }
  .nextBox { margin-top:34px; border:1px solid var(--line); border-radius:12px; padding:22px 24px;
    background:color-mix(in srgb, var(--ink) 2.5%, transparent); }
  .nextBox .nextLabel { font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink3); }
  .nextBox h3 { margin:6px 0 5px; font-size:16.5px; font-weight:600; letter-spacing:-.01em; }
  .nextBox p { margin:0 0 14px; color:var(--ink2); font-size:13.5px; max-width:58ch; }
  .nextBox ol { margin:0 0 12px; padding-left:19px; color:var(--ink2); font-size:13.5px; }
${JOURNEY_CSS}
</style></head><body><div class="wrap">
  <div class="local">This report is a file on your computer. Nothing was sent anywhere.</div>
  <div class="shell">
  <div class="brand"><span class="wordmark">Akeso</span><span class="wordmarkSub">Check</span><span class="when">${escapeHtml(generatedAt.toISOString().slice(0, 10))}</span></div>
  <div class="gradeCard">
    ${staticOnly ? "" : `<div class="gradeLetter g-${escapeHtml(grade.letter)}">${escapeHtml(grade.letter)}</div>`}
    <div>
      <h1>${escapeHtml(staticOnly ? staticHeadline : (GRADE_COPY[grade.letter] || grade.reason))}</h1>
      <p>${escapeHtml(staticOnly
        ? "This is a read of your code. The live test, where a pretend customer pays and cancels, has not run yet."
        : grade.letter === "F" ? "This leaks money every day until it is fixed." : grade.reason)}</p>
      <div class="app">${escapeHtml([
        detection.framework?.packageName || detection.root,
        { "next-app-router": "a Next.js app", "next-pages": "a Next.js app", express: "an Express app", "supabase-edge": "a Supabase Edge app", "node-other": "a Node app" }[detection.framework?.framework] || null,
        detection.database?.kind && detection.database.kind !== "none-found" ? `with ${detection.database.kind === "supabase" ? "Supabase" : detection.database.kind}` : null,
        detection.stripe?.secretKey ? `Stripe ${detection.stripe.secretKey.mode.toLowerCase()} mode` : null,
      ].filter(Boolean).join(", "))}</div>
    </div>
  </div>

  <div class="loopHead">
    <h2>Where this app is</h2>
    <p>Akeso works in three steps, and each one hands something to the next. A step is only marked done when it actually ran.</p>
  </div>
  ${journeyHtml.strip}
  ${journeyHtml.detail}

  ${nextBox}
  ${lifecycle ? `<h2>What we tested</h2>
  <p class="intro">Akeso acted out ten billing situations against your app: paying, canceling, a failing card, a refund. After each one it asked your app the same question: does this customer still have paid access?</p>
  <div class="rows">${scenarioRows}</div>` : ""}
  ${sandbox ? `<h2>What real Stripe events showed</h2>
  <p class="intro">Akeso created a real customer and subscription in your own Stripe test sandbox, moved time forward with a Stripe test clock (a trial ending, a month passing), and delivered Stripe's own events to your app. Everything it created was deleted afterwards.</p>
  <div class="rows">${sandboxRows}</div>` : ""}

  <h2>What your code shows</h2>
  <p class="intro">Read from your webhook handler and access checks. Nothing was executed to produce this.</p>
  <div class="rows">${findingRows}</div>

  <h2>What this did not check</h2>
  <ul class="limits">${limits}</ul>

  </div>
  <footer>Akeso Check · ${escapeHtml(generatedAt.toISOString().slice(0, 16).replace("T", " "))} · ${[
    lifecycle ? `${lifecycle.scenarioCount} lifecycle scenarios` : null,
    sandbox ? `${sandbox.phases.length} real-event phases` : null,
  ].filter(Boolean).join(" · ") || "static analysis only"} · local run</footer>
</div></body></html>`;
}
