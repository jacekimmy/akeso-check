/* The report a founder actually sees: a local HTML file that opens in their
 * browser. It looks like a website; it is a file on their machine, and saying
 * so prominently is part of the product — the whole trust story is "nothing
 * left your computer."
 *
 * Design rules, inherited from the product-care dashboard: plain English
 * first, colour only where it carries state, nothing on the page that was not
 * measured, and the limits of the run stated as prominently as the findings.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const GRADE_COPY = {
  A: "Your billing lifecycle holds up.",
  B: "Nothing failed, but some scenarios could not be tested.",
  C: "One lifecycle scenario fails.",
  D: "Several lifecycle scenarios fail.",
  F: "Canceled customers keep paid access.",
  "?": "The run itself had problems — this is not a verdict on your app.",
};

export function renderReport({ detection, lifecycle, generatedAt = new Date() }) {
  const grade = lifecycle?.grade ?? { letter: "?", reason: "The lifecycle test did not run." };
  const handler = detection.webhookHandlers?.[0] || null;

  const staticFindings = [];
  if (!handler) {
    staticFindings.push({ tone: "bad", text: "No Stripe webhook handler was found. Payment events from Stripe have nowhere to land." });
  } else {
    if (!handler.verifiesSignature) staticFindings.push({ tone: "bad", text: "The webhook handler does not verify Stripe's signature. Anyone who finds the URL can forge payment events." });
    else if (!handler.rawBodySeen) staticFindings.push({ tone: "warn", text: "Signature verification exists, but raw-body handling was not seen — verification like this often fails at runtime." });
    if (handler.missingEvents?.length) staticFindings.push({ tone: "warn", text: `The handler ignores ${handler.missingEvents.length} of the 7 lifecycle events: ${handler.missingEvents.join(", ")}.` });
    if (staticFindings.length === 0) staticFindings.push({ tone: "ok", text: "Signature verified against the raw body, and all 7 lifecycle events are handled." });
  }
  const clientGate = (detection.accessDecisionSites || []).find((site) => site.clientSideOnly);
  if (clientGate) staticFindings.push({ tone: "warn", text: `Paid access appears to be checked in the browser (${clientGate.file}) — a gate anyone can step around with devtools.` });

  const scenarioRows = (lifecycle?.results || []).map((result) => {
    const mark = result.outcome === "pass" ? "✓"
      : result.outcome === "fail" ? "✗"
      : result.outcome === "reported" ? "•" : "—";
    const cls = result.outcome === "pass" ? "ok"
      : result.outcome === "fail" ? (result.critical ? "bad" : "warn")
      : result.outcome === "reported" ? "note" : "mute";
    const detail = result.outcome === "fail"
      ? `expected ${result.expected ? "access" : "no access"}, the app says ${result.observed ? "access" : "no access"}`
      : result.outcome === "reported" ? `app's policy: ${result.observed ? "keeps access" : "removes access"}`
      : result.outcome === "could_not_test" ? escapeHtml(result.harnessError)
      : result.outcome === "not_provable" ? escapeHtml(result.note || "not provable on this run") : "";
    return `<div class="row ${cls}"><span class="mark">${mark}</span><span class="name">${escapeHtml(result.name)}</span><span class="detail">${detail}</span></div>`;
  }).join("\n");

  const findingRows = staticFindings.map((finding) =>
    `<div class="row ${finding.tone}"><span class="mark">${finding.tone === "ok" ? "✓" : finding.tone === "bad" ? "✗" : "!"}</span><span class="name wide">${escapeHtml(finding.text)}</span></div>`,
  ).join("\n");

  const limits = [
    "Only the billing lifecycle was tested — not login, checkout UI, or anything else.",
    "Events were delivered locally with your app's own webhook secret. If your handler re-fetches objects from Stripe's API, run the sandbox mode with your Stripe test key for full fidelity.",
    detection.capabilities?.blockers?.length ? `Not possible on this project yet: ${detection.capabilities.blockers.join(" ")}` : null,
  ].filter(Boolean).map((limit) => `<li>${escapeHtml(limit)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso Check — ${escapeHtml(detection.framework?.packageName || "your app")}</title>
<style>
  :root { --bg:#fcfcfd; --ink:#16181d; --ink2:#5b6270; --ink3:#8a919e; --line:#e6e8ec;
    --ok:#12784b; --warn:#96620a; --bad:#b3261e; --note:#2f4a78; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111317; --ink:#e9ebef; --ink2:#a4abb8;
    --ink3:#767d8a; --line:#282c34; --ok:#4cbe83; --warn:#dfa94c; --bad:#ef8578; --note:#8aa9dc; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif,-apple-system,system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  .shell { max-width:640px; margin:0 auto; padding:40px 24px 100px; }
  .local { font-size:12.5px; color:var(--ink3); border:1px solid var(--line); border-radius:20px; display:inline-block; padding:3px 12px; margin-bottom:34px; }
  .gradeCard { border:1px solid var(--line); border-radius:10px; padding:30px 28px; display:flex; gap:26px; align-items:center; }
  .gradeLetter { font-size:76px; font-weight:700; line-height:1; letter-spacing:-.04em; }
  .g-A,.g-B { color:var(--ok); } .g-C { color:var(--warn); } .g-D,.g-F { color:var(--bad); } .g-\\? { color:var(--ink3); }
  .gradeCard h1 { margin:0 0 6px; font-size:22px; letter-spacing:-.02em; }
  .gradeCard p { margin:0; color:var(--ink2); font-size:15px; }
  .app { font-size:13px; color:var(--ink3); margin-top:10px; }
  h2 { font-size:12px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink3); margin:44px 0 4px; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; gap:12px; padding:11px 0; border-bottom:1px solid var(--line); align-items:baseline; font-size:15px; }
  .mark { width:18px; text-align:center; flex:none; font-weight:600; }
  .row.ok .mark { color:var(--ok); } .row.warn .mark { color:var(--warn); }
  .row.bad .mark { color:var(--bad); } .row.bad .name { color:var(--bad); font-weight:600; }
  .row.note .mark { color:var(--note); } .row.mute { color:var(--ink3); }
  .name { flex:1; } .name.wide { flex:auto; }
  .detail { color:var(--ink3); font-size:13.5px; text-align:right; max-width:40%; }
  ul.limits { margin:8px 0 0; padding-left:20px; color:var(--ink2); font-size:14.5px; }
  ul.limits li { margin-bottom:7px; }
  .cta { margin-top:48px; border:1px solid var(--line); border-radius:10px; padding:22px 24px; }
  .cta h3 { margin:0 0 6px; font-size:17px; } .cta p { margin:0 0 14px; color:var(--ink2); font-size:14.5px; }
  .cta a { display:inline-block; background:var(--ink); color:var(--bg); text-decoration:none; border-radius:7px; padding:10px 18px; font-size:15px; font-weight:500; }
  footer { margin-top:44px; font-size:12.5px; color:var(--ink3); }
</style></head><body><div class="shell">
  <div class="local">🔒 This report is a file on your computer. Nothing was sent anywhere.</div>
  <div class="gradeCard">
    <div class="gradeLetter g-${escapeHtml(grade.letter)}">${escapeHtml(grade.letter)}</div>
    <div>
      <h1>${escapeHtml(GRADE_COPY[grade.letter] || grade.reason)}</h1>
      <p>${escapeHtml(grade.reason)}</p>
      <div class="app">${escapeHtml(detection.framework?.packageName || detection.root)} · ${escapeHtml(detection.framework?.framework || "")} · ${escapeHtml(detection.database?.kind || "")} · Stripe ${escapeHtml(detection.stripe?.secretKey?.mode || "not found")}</div>
    </div>
  </div>

  <h2>What a pretend customer went through</h2>
  <div class="rows">${scenarioRows || '<div class="row mute"><span class="mark">—</span><span class="name">The lifecycle test did not run on this project.</span></div>'}</div>

  <h2>What the code itself shows</h2>
  <div class="rows">${findingRows}</div>

  <h2>What this did not check</h2>
  <ul class="limits">${limits}</ul>

  ${grade.letter === "A" ? "" : `<div class="cta">
    <h3>Want this fixed?</h3>
    <p>The Fix Plan is an automated repair — signature verification, every lifecycle event handled, and a nightly self-check — delivered as a pull request you (or your coding agent) apply. Then re-run this Check and watch it go green.</p>
    <a href="https://akeso-check.vercel.app/#fix">Get the Fix Plan — $49</a>
  </div>`}

  <footer>Akeso Check · ${escapeHtml(generatedAt.toISOString().slice(0, 16).replace("T", " "))} · ${lifecycle ? `${lifecycle.scenarioCount} lifecycle scenarios` : "static analysis only"} · local run</footer>
</div></body></html>`;
}
