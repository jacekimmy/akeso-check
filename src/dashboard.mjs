/* The dashboard: the screen a founder lives in.
 *
 * One HTML file, no server, no account. The ledger is embedded (the local
 * `page` command) or dropped in (the site), and everything is folded in the
 * browser. Nothing is uploaded, so the privacy promise holds even for the
 * hosted copy.
 *
 * It is built around the founder's four questions, in the order they ask
 * them: is my billing right, which exact accounts are wrong, what is waiting
 * on me, what has Akeso done. The centrepiece is the one thing nobody else
 * shows them: every account with what Stripe says and what the app says side
 * by side, and whether the two agree. The three steps are the navigation
 * itself, each carrying its live state, so the connection between them is the
 * rail on the left rather than a diagram.
 *
 * Doctrine carries into the browser unchanged: a step is lit only when it
 * executed, no number is invented, revenue recovered is never a figure, the
 * chain is verified here with the same hash the ledger wrote, and every action
 * is a command the page names rather than a button that does it.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/* Scenario ids the ledger stores, back into the names a founder saw. */
const SCENARIO_NAMES = {
  "checkout-grants": "New payment unlocks access",
  "trial-converts": "Trial ends, subscription becomes active",
  "renewal-succeeds": "Monthly renewal payment keeps access",
  "payment-fails": "Card fails, retries exhaust: access ends",
  "cancel-at-period-end": "Customer cancels; period ends: access ends",
  "immediate-cancel": "Immediate cancellation removes access",
  reactivation: "Customer un-cancels before the period ends",
  refund: "Latest charge refunded (follows the app's own policy)",
  "duplicate-delivery": "The same event delivered twice",
  "out-of-order": "An old 'still active' event arrives after cancellation",
};

const CSS = `
  :root {
    --rail:#101315; --rail2:#171b1e; --railInk:#c9cdd1; --railMute:#6f767d;
    --ws:#f4f3ee; --ws2:#ecebe4; --card:#ffffff; --ink:#14171a; --ink2:#5c636b; --ink3:#8b9199; --rule:#dcdad2; --rule2:#c7c4b8;
    --ok:#1f7a4d; --bad:#b23a2e; --wait:#9a6b12; --sel:#e6e4db;
  }
  @media (prefers-color-scheme: dark) { :root {
    --rail:#0a0c0e; --rail2:#111417; --railInk:#c9cdd1; --railMute:#6a7178;
    --ws:#15181b; --ws2:#1b1f23; --card:#1b1f23; --ink:#e8e6df; --ink2:#a9aeb4; --ink3:#767c83; --rule:#2a2e33; --rule2:#3a3f45;
    --ok:#5ec48b; --bad:#f08a7c; --wait:#e0b45a; --sel:#23282d;
  } }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--ws); color:var(--ink); font:14px/1.5 "Instrument Sans", ui-sans-serif, -apple-system, system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  .mono { font-family:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric:tabular-nums; }
  .serif { font-family:"Instrument Serif", ui-serif, "Iowan Old Style", Georgia, serif; }

  .app { display:grid; grid-template-columns:232px 1fr; min-height:100vh; }
  .rail { background:var(--rail); color:var(--railInk); padding:22px 14px; display:flex; flex-direction:column; gap:2px; position:sticky; top:0; height:100vh; }
  .rail .brand { display:flex; align-items:baseline; gap:8px; padding:4px 10px 22px; }
  .rail .brand b { font-weight:600; letter-spacing:-.01em; font-size:15px; color:#fff; }
  .rail .brand span { font-size:12px; color:var(--railMute); }
  .rail .group { font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--railMute); padding:16px 10px 6px; }
  .rail a { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; color:var(--railInk); text-decoration:none; font-size:13.5px; }
  .rail a:hover { background:var(--rail2); }
  .rail a.on { background:var(--rail2); color:#fff; }
  .rail .dot { width:8px; height:8px; border-radius:50%; border:1.5px solid var(--railMute); flex:none; }
  .rail .dot.done { background:var(--ok); border-color:var(--ok); }
  .rail .dot.failed { background:var(--bad); border-color:var(--bad); }
  .rail .dot.next { border-color:#fff; border-style:dashed; }
  .rail .dot.partial { border-color:var(--wait); }
  .rail .count { margin-left:auto; font-size:11.5px; color:var(--railMute); }
  .rail .count.hot { color:var(--wait); }
  .rail .foot { margin-top:auto; padding:10px; font-size:11.5px; color:var(--railMute); line-height:1.5; }

  .ws { min-width:0; }
  .top { display:flex; align-items:center; gap:14px; padding:14px 28px; border-bottom:1px solid var(--rule); background:var(--ws); position:sticky; top:0; z-index:5; }
  .top .crumb { font-size:13px; color:var(--ink2); }
  .top .crumb b { color:var(--ink); font-weight:500; }
  .top .seal { margin-left:auto; font-size:12px; color:var(--ink3); }
  .top .seal.bad { color:var(--bad); }
  .btn { height:32px; padding:0 12px; border-radius:7px; border:1px solid var(--rule2); background:var(--card); color:var(--ink); font:inherit; font-size:13px; cursor:pointer; }
  .btn.primary { background:var(--ink); color:var(--ws); border-color:var(--ink); }
  .btn input { display:none; }

  .view { display:none; padding:28px 28px 60px; }
  .view.on { display:block; }
  .verdict { font-size:30px; line-height:1.15; letter-spacing:-.01em; margin:0 0 6px; max-width:30ch; }
  .verdict .muted { color:var(--ink3); }
  .why { margin:0 0 22px; color:var(--ink2); max-width:64ch; }
  .cmd { display:inline-flex; align-items:center; gap:10px; padding:8px 12px; background:var(--card); border:1px solid var(--rule2); border-radius:7px; font-size:13px; }
  .cmd::before { content:"$"; color:var(--ink3); }
  .cmd button { border:0; background:transparent; color:var(--ink3); font:inherit; font-size:12px; cursor:pointer; padding:0 0 0 6px; }

  .cols { display:grid; grid-template-columns:1fr 300px; gap:36px; margin-top:30px; }
  .h { display:flex; align-items:baseline; gap:12px; margin:0 0 10px; }
  .h h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:.02em; }
  .h .n { color:var(--ink3); font-size:12.5px; }
  .h .r { margin-left:auto; font-size:12.5px; color:var(--ink3); }

  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-weight:500; font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink3); padding:8px 10px 8px 0; border-bottom:1px solid var(--rule2); }
  td { padding:10px 10px 10px 0; border-bottom:1px solid var(--rule); vertical-align:top; }
  td.num, th.num { text-align:right; padding-right:0; white-space:nowrap; }
  td.num:not(:last-child), th.num:not(:last-child) { padding-right:22px; }
  tr.agree td { color:var(--ink2); }
  .pill { display:inline-block; white-space:nowrap; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid var(--rule2); background:var(--card); }
  .pill.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, var(--rule2)); }
  .pill.bad { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 40%, var(--rule2)); }
  .pill.wait { color:var(--wait); border-color:color-mix(in srgb, var(--wait) 40%, var(--rule2)); }
  .pill.none { color:var(--ink3); }
  .tie { font-family:"JetBrains Mono", ui-monospace, monospace; font-size:12.5px; }
  .tie.ok { color:var(--ok); } .tie.bad { color:var(--bad); } .tie.none { color:var(--ink3); }
  .empty { padding:18px 0; color:var(--ink3); font-size:13.5px; border-bottom:1px solid var(--rule); }

  .inbox .item { padding:12px 0; border-bottom:1px solid var(--rule); }
  .inbox .item.ready { border-left:2px solid var(--wait); padding-left:12px; }
  .inbox .who { font-weight:500; }
  .inbox .what { color:var(--ink2); font-size:13px; }
  .inbox .when { color:var(--ink3); font-size:12px; margin-top:2px; }
  .inbox .cmd { margin-top:8px; font-size:12px; }

  .fig { display:flex; justify-content:space-between; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--rule); }
  .fig .l { color:var(--ink2); font-size:13px; }
  .fig .v { font-size:15px; }
  .fig.total { border-top:1px solid var(--ink); border-bottom:3px double var(--ink); margin-top:8px; }
  .note { color:var(--ink3); font-size:12px; margin:4px 0 0; }
  .rule-line { margin:26px 0 0; padding:10px 14px; border-left:2px solid var(--ok); color:var(--ink); font-size:13.5px; background:var(--card); }

  .panel { display:none; margin:0 28px; padding:18px 20px; border:1px solid var(--rule2); border-radius:10px; background:var(--card); }
  .panel.on { display:block; }
  .panel .tabs { display:flex; gap:2px; margin-bottom:12px; flex-wrap:wrap; }
  .panel .tabs button { border:1px solid transparent; background:transparent; color:var(--ink2); font:inherit; font-size:13px; padding:5px 10px; border-radius:7px; cursor:pointer; }
  .panel .tabs button.on { background:var(--sel); color:var(--ink); }
  .panel ol { margin:0 0 12px; padding-left:20px; color:var(--ink2); font-size:13.5px; }
  .panel .after { margin:10px 0 0; color:var(--ink3); font-size:12.5px; }
  .demo { margin:0 28px; padding:10px 14px; border:1px solid var(--rule2); border-radius:8px; background:var(--card); font-size:13px; color:var(--ink2); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .demo b { color:var(--ink); font-weight:500; }

  @media (max-width:860px) {
    .app { grid-template-columns:1fr; }
    .rail { position:static; height:auto; flex-direction:row; flex-wrap:wrap; padding:12px; gap:4px; }
    .rail .brand { padding:6px 10px; width:100%; }
    .rail .group, .rail .foot { display:none; }
    .rail a { padding:7px 10px; }
    .cols { grid-template-columns:1fr; gap:28px; }
    .top, .view, .demo, .panel { padding-left:16px; padding-right:16px; }
    .demo, .panel { margin-left:16px; margin-right:16px; }
    .verdict { font-size:24px; }
    th:nth-child(4), td:nth-child(4) { display:none; }
  }
`;

/* All of the folding happens here, in the browser. Kept deliberately close
   to the Node modules it mirrors, and kept free of template literals so it
   can live inside one. */
const JS = String.raw`
(async function () {
  var D = window.AKESO || {};
  var L = Array.isArray(D.ledger) ? D.ledger.filter(function (e) { return e && typeof e === "object"; }) : [];
  var NOW = Date.now();
  var NAMES = D.scenarioNames || {};
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function kinds(k) { return L.filter(function (e) { return e.kind === k; }); }
  function last(k) { var a = kinds(k); return a.length ? a[a.length - 1] : null; }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace("T", " ") : ""; }
  function money(n) { return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(2) : ""; }
  function $(id) { return document.getElementById(id); }

  /* ---- fold ---- */
  var check = last("check"), fix = last("fix"), sweep = last("sweep"), cert = last("certify");
  var ranLive = !!(check && (check.lifecycleGrade || check.sandboxGrade));
  var grade = check ? (check.grade || null) : null;
  var passing = grade === "A";
  var provenFix = !!(fix && check && check.seq > fix.seq && passing);
  var accounts = (sweep && Array.isArray(sweep.accounts)) ? sweep.accounts : [];
  var matched = sweep && sweep.comparison && sweep.comparison.counts ? (sweep.comparison.counts.matched || 0) : 0;
  var agreeing = Math.max(0, matched - accounts.filter(function (a) { return a.verdict === "locked_out" || a.verdict === "still_entitled"; }).length);

  var appr = {};
  kinds("approval").forEach(function (e) {
    if (!e.id) return;
    var r = appr[e.id] || (appr[e.id] = { id: e.id, state: "queued" });
    if (e.state === "queued") { Object.assign(r, e, { state: r.state === "queued" ? "queued" : r.state }); }
    else if (e.state === "approved" || e.state === "cancelled") { if (r.state === "queued") r.state = e.state; }
  });
  var waiting = Object.values(appr).filter(function (r) {
    if (r.state !== "queued") return false;
    var q = Date.parse(r.queuedAt || ""); if (isFinite(q) && NOW - q > 7 * 86400000) return false;
    return true;
  }).map(function (r) { var ready = Date.parse(r.readyAt || ""); r.ready = isFinite(ready) && NOW >= ready; return r; });

  var restores = kinds("restore");
  var restored = restores.filter(function (e) { return e.direction === "grant" && e.result === "applied"; });
  var removed = restores.filter(function (e) { return e.direction === "remove" && e.result === "applied"; });
  var verified = restores.filter(function (e) { return e.result === "applied" && e.verified; });
  var sweeps = kinds("sweep").filter(function (e) { return e.comparison && !e.couldNotRun; });
  var exposure = sweeps.length ? sweeps.reduce(function (s, e) { return s + (Number(e.comparison.monthlyExposure) || 0); }, 0) / sweeps.length : null;

  var covered = !!(cert && cert.policy);
  var states = {
    check: ranLive ? "done" : check ? "partial" : "todo",
    fix: provenFix ? "done" : (fix && !passing) ? "failed" : fix ? "partial" : (ranLive && !passing) ? "next" : (ranLive && passing) ? "notneeded" : "todo",
    monitor: (sweep && !sweep.couldNotRun && matched > 0) ? "done" : sweep ? "failed" : (passing || provenFix) ? "next" : "todo"
  };

  /* ---- the next step: the same ladder as the terminal ---- */
  var step;
  if (!check) step = { h: "Nothing has been checked yet.", w: "Akeso needs to look at your code before it can say anything about it.", c: "npx akeso-check" };
  else if (!ranLive) step = { h: "Next: the real test, where a pretend customer pays and cancels.", w: "Reading code shows what your app is supposed to do. Only running it shows what it actually does.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
  else if (grade && grade !== "A" && grade !== "?") step = (fix && fix.seq > check.seq) ? { h: "The repair is in, but the test still fails.", w: "Akeso will not call a repair successful when its own test disagrees.", c: "npx akeso-check fix --show" } : { h: "Next: repair what the " + grade + " is about.", w: "It writes the corrected webhook handler and the one file that touches your database. Re-run the test to prove it.", c: "npx akeso-check fix" };
  else if (grade === "?") step = { h: "The run itself had problems, so there is no verdict yet.", w: "This is about the run, not about your app.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
  else if (sweep && sweep.couldNotRun) step = { h: "The last check of your real customers could not run.", w: String(sweep.couldNotRun), c: "npx akeso-check monitor" };
  else if (sweep && matched === 0) step = { h: "Nothing could be compared yet, so nothing is proven about your customers.", w: "No Stripe subscription matched any account your app reported. Stripe has to carry the same account id your app uses.", c: null };
  else if (sweep && waiting.length) step = { h: waiting.length + " removal" + (waiting.length === 1 ? " is" : "s are") + " waiting for your yes.", w: "Akeso never takes access away without a person deciding. Nothing has happened to those accounts yet.", c: "npx akeso-check approvals" };
  else if (sweep) step = sweep.comparison && sweep.comparison.clean ? { h: "Everything matches right now.", w: "Every paying customer has access, and nobody who stopped paying still has it.", c: "npx akeso-check statement" } : { h: "The last run found accounts that do not match.", w: "The table below names them.", c: "npx akeso-check approvals" };
  else step = { h: provenFix ? "The repair holds. Next: check that today's real customers match." : "Your billing code passes. Next: check that today's real customers match.", w: "Correct code from now on does not fix the accounts that already drifted.", c: "npx akeso-check monitor" };

  /* ---- render ---- */
  var app = (D.appName || "this app");
  $("crumbApp").textContent = app;
  ["check", "fix", "monitor"].forEach(function (k) { var d = $("dot-" + k); d.className = "dot " + states[k]; });
  var wc = $("count-approvals"); wc.textContent = waiting.length ? String(waiting.length) : ""; wc.className = "count" + (waiting.length ? " hot" : "");
  $("count-ledger").textContent = L.length ? String(L.length) : "";

  $("verdict").innerHTML = esc(step.h);
  $("why").textContent = step.w || "";
  $("next").innerHTML = step.c ? '<span class="cmd mono">' + esc(step.c) + '<button data-copy="' + esc(step.c) + '">copy</button></span>' : "";

  function tie(a) { return a.verdict === "locked_out" || a.verdict === "still_entitled" ? '<span class="tie bad">&ne;</span>' : a.verdict === "no_conclusion" || a.verdict === "no_subscription" ? '<span class="tie none">?</span>' : '<span class="tie ok">=</span>'; }
  function stripePill(a) { return a.stripe == null ? '<span class="pill none">no subscription</span>' : '<span class="pill ' + (["active", "trialing", "past_due"].indexOf(a.stripe) >= 0 ? "ok" : a.stripe === "incomplete" || a.stripe === "paused" ? "none" : "bad") + '">' + esc(a.stripe) + '</span>'; }
  function appPill(a) { return a.app == null ? '<span class="pill none">unknown</span>' : a.app ? '<span class="pill ok">has access</span>' : '<span class="pill bad">no access</span>'; }
  function meaning(a) { return { locked_out: "paying, but locked out. Akeso restores this.", still_entitled: "not paying, still has access. Waits for your yes.", no_conclusion: "mid-flight; no verdict drawn.", no_subscription: "no Stripe subscription; reported, never acted on." }[a.verdict] || ""; }

  var rows = accounts.map(function (a) { return "<tr><td class=mono>" + esc(a.account) + "</td><td>" + stripePill(a) + "</td><td>" + tie(a) + "</td><td>" + appPill(a) + "</td><td>" + esc(meaning(a)) + "</td><td class='num mono'>" + esc(money(a.priceMonthly)) + "</td></tr>"; }).join("");
  if (sweep && matched > 0 && agreeing > 0) rows += '<tr class="agree"><td class="mono">' + agreeing + ' more</td><td><span class="pill ok">paying</span></td><td><span class="tie ok">=</span></td><td><span class="pill ok">has access</span></td><td>agree. Nothing to do.</td><td></td></tr>';
  $("accounts").innerHTML = rows || '<tr><td colspan="6" class="empty">' + (sweep ? "Nothing could be compared on the last sweep." : "No sweep has run yet. The monitor fills this in.") + "</td></tr>";
  $("accountsN").textContent = sweep ? (matched + " compared, " + accounts.filter(function (a) { return a.verdict === "locked_out" || a.verdict === "still_entitled"; }).length + " disagree") : "";
  $("accountsWhen").textContent = sweep ? when(sweep.at) : "";

  var ib = $("inbox");
  ib.innerHTML = waiting.length ? waiting.map(function (r) {
    return '<div class="item' + (r.ready ? " ready" : "") + '"><div class="who mono">' + esc(r.account) + '</div><div class="what">' + esc(r.reason || "") + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + " a month at list" : "") + '</div><div class="when">' + (r.ready ? "ready for your yes" : "opens " + esc(when(r.readyAt))) + '</div><span class="cmd mono">' + esc("npx akeso-check approvals --approve " + r.id) + "</span></div>";
  }).join("") + '<p class="note">Akeso never removes access on its own. Nothing here has happened.</p>' : '<div class="empty">Nothing is waiting for you. Akeso never removes access on its own, so this is the only place removals ever appear.</div>';

  /* check view */
  var sc = (check && check.scenarioResults) || [];
  $("scenarios").innerHTML = sc.length ? sc.map(function (r) { var o = r.outcome; return "<tr><td>" + esc(NAMES[r.id] || r.id) + "</td><td>" + (o === "pass" ? '<span class="pill ok">pass</span>' : o === "fail" ? '<span class="pill bad">fail</span>' : '<span class="pill none">' + esc(o) + "</span>") + "</td></tr>"; }).join("") : '<tr><td colspan="2" class="empty">' + (check ? "The code was read; the live test has not run." : "Not run yet.") + "</td></tr>";
  $("checkMeta").textContent = check ? (grade ? "grade " + grade + " · " : "") + when(check.at) : "";

  /* fix view */
  $("files").innerHTML = fix ? (fix.files || []).map(function (f) { return "<tr><td>" + esc(f.action || "") + '</td><td class="mono">' + esc(f.path || "") + "</td></tr>"; }).join("") : '<tr><td colspan="2" class="empty">' + (states.fix === "notneeded" ? "Nothing needed repairing." : "No repair has been written.") + "</td></tr>";
  $("fixMeta").textContent = fix ? when(fix.at) + " · " + ((fix.repairs || []).length) + " repairs: " + (fix.repairs || []).join(", ") : "";
  $("fixProof").textContent = provenFix ? "Proven: the same test was run again afterwards and passed." : (fix && !passing) ? "Not proven: the test still fails, so Akeso does not call this repaired." : fix ? "Applied, not yet re-tested." : "";

  /* monitor view */
  var sw = kinds("sweep");
  $("sweeps").innerHTML = sw.length ? sw.slice().reverse().map(function (e) { var c = e.comparison || {}; return "<tr><td class=mono>" + esc(when(e.at)) + "</td><td>" + (e.couldNotRun ? '<span class="pill bad">could not run</span>' : c.comparable === false ? '<span class="pill none">compared nothing</span>' : c.clean ? '<span class="pill ok">all matching</span>' : '<span class="pill bad">mismatches</span>') + "</td><td class='num mono'>" + esc(c.counts ? c.counts.matched : "") + "</td><td class='num mono'>" + esc(typeof c.monthlyExposure === "number" ? money(c.monthlyExposure) : "") + "</td></tr>"; }).join("") : '<tr><td colspan="4" class="empty">No sweep has run yet.</td></tr>';
  $("coverage").textContent = covered ? "Covered since " + when(cert.at) + " under rule version " + esc((cert.policy && cert.policy.ruleVersion) || "1") + "." : "Not covering this app yet. Coverage starts when you confirm the rules: npx akeso-check certify";

  /* approvals view */
  $("queue").innerHTML = waiting.length ? waiting.map(function (r) { return '<tr><td class="mono">' + esc(r.account) + "</td><td>" + esc(r.reason || "") + '</td><td class="num mono">' + esc(money(r.priceMonthly)) + "</td><td>" + (r.ready ? '<span class="pill wait">ready</span>' : "opens " + esc(when(r.readyAt))) + '</td><td><span class="cmd mono">' + esc("npx akeso-check approvals --approve " + r.id) + "</span></td></tr>"; }).join("") : '<tr><td colspan="5" class="empty">Nothing is waiting for you.</td></tr>';

  /* receipts view */
  $("rRestored").textContent = String(restored.length); $("rVerified").textContent = verified.length + " confirmed by reading back";
  $("rRemoved").textContent = String(removed.length);
  $("rExposure").textContent = sweeps.length ? money(exposure) + " / mo" : "not measured";
  $("restores").innerHTML = restores.length ? restores.slice().reverse().map(function (e) { return "<tr><td class=mono>" + esc(when(e.at)) + "</td><td class=mono>" + esc(e.account) + "</td><td>" + esc(e.direction) + "</td><td>" + (e.result === "applied" && e.verified ? '<span class="pill ok">applied, confirmed</span>' : '<span class="pill ' + (e.result === "applied" ? "wait" : "bad") + '">' + esc(e.result || "") + "</span>") + "</td></tr>"; }).join("") : '<tr><td colspan="4" class="empty">No changes have been made.</td></tr>';

  /* ledger view + chain */
  $("entries").innerHTML = L.length ? L.slice().reverse().map(function (e) {
    var sum = e.kind === "check" ? "grade " + (e.grade || "read only") : e.kind === "fix" ? ((e.files || []).length) + " files" : e.kind === "sweep" ? (e.couldNotRun ? "could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? e.direction + " " + e.account + " " + e.result : e.kind === "approval" ? e.state + " " + (e.account || "") : e.kind === "certify" ? "rules confirmed" : "";
    return "<tr><td class=mono>" + esc(e.seq) + "</td><td class=mono>" + esc(when(e.at)) + "</td><td>" + esc(e.kind) + "</td><td>" + esc(sum) + "</td></tr>";
  }).join("") : '<tr><td colspan="4" class="empty">The ledger is empty.</td></tr>';

  async function sha(s) { var b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
  var seal = $("seal"); seal.textContent = L.length ? "verifying chain" : "no ledger loaded";
  if (L.length && crypto.subtle) {
    var prev = null, broken = null;
    for (var i = 0; i < L.length; i++) {
      var e = L[i]; var rest = {}; Object.keys(e).forEach(function (k) { if (k !== "hash") rest[k] = e[k]; });
      if ((e.prev || null) !== prev) { broken = e.seq || i + 1; break; }
      var h = await sha((prev || "genesis") + "\n" + JSON.stringify(rest));
      if (h !== e.hash) { broken = e.seq || i + 1; break; }
      prev = e.hash;
    }
    seal.textContent = broken ? "chain BROKEN at entry " + broken : L.length + " entries · chain unbroken";
    seal.className = "seal" + (broken ? " bad" : "");
  } else if (L.length) { seal.textContent = L.length + " entries"; }

  /* nav + copy */
  function show(id) { document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("on", v.id === "v-" + id); }); document.querySelectorAll(".rail a[data-view]").forEach(function (a) { a.classList.toggle("on", a.dataset.view === id); }); $("crumbView").textContent = ({ overview: "Overview", check: "Check", fix: "Fix", monitor: "Monitor", approvals: "Approvals", receipts: "Receipts", ledger: "Ledger" })[id] || id; }
  function route() { var id = (location.hash || "#overview").slice(1); show(document.getElementById("v-" + id) ? id : "overview"); }
  window.addEventListener("hashchange", route); route();
  document.addEventListener("click", function (e) { var b = e.target.closest("[data-copy]"); if (!b) return; navigator.clipboard.writeText(b.dataset.copy).then(function () { b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1200); }); });

  /* site only: load a ledger file, run panel */
  var file = $("ledgerFile"); if (file) file.addEventListener("change", function () { var f = file.files[0]; if (!f) return; f.text().then(function (t) { var rows = t.split("\n").filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (x) { return { kind: "unreadable" }; } }); window.AKESO = Object.assign({}, D, { ledger: rows, appName: f.name.replace(/\.jsonl$/, "") }); document.body.innerHTML = D.shell; }); });
  var runBtn = $("runBtn"), panel = $("runPanel"); if (runBtn && panel) runBtn.addEventListener("click", function () { panel.classList.toggle("on"); });
  var tabs = $("tabs"); if (tabs) {
    var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English.";
    var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } };
    tabs.addEventListener("click", function (e) { var t = e.target.dataset.tool; if (!t) return; tabs.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === e.target); }); $("cmd").textContent = T[t].paste; $("cmdCopy").dataset.copy = T[t].paste; $("steps").hidden = !T[t].steps; $("stepsAfter").hidden = !T[t].steps; });
  }
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  const data = JSON.stringify({ ledger, appName, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");
  const fonts = hosted
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`
    : "";

  const runPanel = hosted ? `
  <div class="demo">${demo ? `<b>Demo ledger</b> from a real run on a test app.` : `<b>Your ledger.</b>`} <button class="btn primary" id="runBtn">Run on your app</button> <label class="btn">Load your ledger<input type="file" id="ledgerFile" accept=".jsonl,application/json,text/plain"></label> <span class="note" style="margin:0">Nothing is uploaded; the file is read in this tab.</span></div>
  <div class="panel" id="runPanel">
    <div class="tabs" id="tabs"><button class="on" data-tool="terminal">Terminal</button><button data-tool="claude">Claude Code</button><button data-tool="cursor">Cursor</button><button data-tool="codex">Codex</button><button data-tool="lovable">Lovable / Bolt / v0</button></div>
    <ol id="steps" hidden>
      <li>Open your project in your builder.</li><li>Click the GitHub button, usually at the top right, and follow its steps to put your project on GitHub. Lovable, Bolt and v0 all have this.</li><li>Go to github.com and open your new repository.</li><li>Click the green Code button.</li><li>Click Codespaces, then Create codespace on main.</li><li>A code editor opens in a new browser tab. Wait for it to finish loading.</li><li>If a box asks Do you trust the authors, click Trust Folder and Continue.</li><li>Click inside the terminal panel at the bottom of the screen, paste this, and press Enter:</li>
    </ol>
    <span class="cmd mono" id="cmdWrap"><span id="cmd">npx akeso-check</span><button id="cmdCopy" data-copy="npx akeso-check">copy</button></span>
    <p class="after" id="stepsAfter" hidden>When it finishes, your results print right there in the terminal, and .akeso/ledger.jsonl is written in your project. Load it above to see it here.</p>
    <p class="after">Free. Runs on your machine. Zero dependencies, plain JavaScript you can read first: <a href="https://github.com/jacekimmy/akeso-check">github.com/jacekimmy/akeso-check</a></p>
  </div>` : "";

  const shell = `<div class="app">
  <nav class="rail">
    <div class="brand"><b>Akeso</b><span>${hosted ? "dashboard" : "on your computer"}</span></div>
    <a href="#overview" data-view="overview">Overview</a>
    <div class="group">The loop</div>
    <a href="#check" data-view="check"><span class="dot" id="dot-check"></span>Check</a>
    <a href="#fix" data-view="fix"><span class="dot" id="dot-fix"></span>Fix</a>
    <a href="#monitor" data-view="monitor"><span class="dot" id="dot-monitor"></span>Monitor</a>
    <div class="group">For you</div>
    <a href="#approvals" data-view="approvals">Approvals<span class="count" id="count-approvals"></span></a>
    <a href="#receipts" data-view="receipts">Receipts</a>
    <a href="#ledger" data-view="ledger">Ledger<span class="count" id="count-ledger"></span></a>
    <div class="foot">${hosted ? "No account. No server. The ledger you load never leaves this browser." : escapeHtml(root ? `Read from ${root}/.akeso/ledger.jsonl` : "Read from .akeso/ledger.jsonl")}<br>Every action is a command; this page names it.</div>
  </nav>
  <main class="ws">
    <div class="top"><span class="crumb"><b id="crumbApp"></b> &nbsp;/&nbsp; <span id="crumbView">Overview</span></span><span class="seal mono" id="seal"></span></div>
    ${runPanel}

    <section class="view on" id="v-overview">
      <h1 class="verdict serif" id="verdict"></h1>
      <p class="why" id="why"></p>
      <div id="next"></div>
      <div class="cols">
        <div>
          <div class="h"><h2>Accounts</h2><span class="n" id="accountsN"></span><span class="r mono" id="accountsWhen"></span></div>
          <table><thead><tr><th>Account</th><th>Stripe says</th><th></th><th>App says</th><th>Meaning</th><th class="num">List price</th></tr></thead><tbody id="accounts"></tbody></table>
        </div>
        <aside class="inbox">
          <div class="h"><h2>Waiting for you</h2></div>
          <div id="inbox"></div>
          <div class="h" style="margin-top:26px"><h2>Receipts</h2></div>
          <div class="fig"><span class="l">Access restored</span><span class="v mono" id="rRestored"></span></div>
          <p class="note" id="rVerified"></p>
          <div class="fig"><span class="l">Access removed</span><span class="v mono" id="rRemoved"></span></div>
          <div class="fig"><span class="l">Exposure, per sweep</span><span class="v mono" id="rExposure"></span></div>
          <div class="fig total"><span class="l">Revenue recovered</span><span class="v mono">not measured</span></div>
          <p class="note">Akeso does not see your payouts, so it will not put a number here.</p>
        </aside>
      </div>
      <p class="rule-line">Akeso restores access on its own. It never removes access on its own.</p>
    </section>

    <section class="view" id="v-check">
      <div class="h"><h2>The ten billing situations</h2><span class="r mono" id="checkMeta"></span></div>
      <table><thead><tr><th>Scenario</th><th>Outcome</th></tr></thead><tbody id="scenarios"></tbody></table>
    </section>

    <section class="view" id="v-fix">
      <div class="h"><h2>What the fix wrote</h2><span class="r mono" id="fixMeta"></span></div>
      <table><thead><tr><th>Action</th><th>File</th></tr></thead><tbody id="files"></tbody></table>
      <p class="note" id="fixProof"></p>
    </section>

    <section class="view" id="v-monitor">
      <div class="h"><h2>Sweeps</h2></div>
      <table><thead><tr><th>When</th><th>Result</th><th class="num">Compared</th><th class="num">Exposure</th></tr></thead><tbody id="sweeps"></tbody></table>
      <p class="note" id="coverage"></p>
    </section>

    <section class="view" id="v-approvals">
      <div class="h"><h2>Removals waiting for your yes</h2></div>
      <table><thead><tr><th>Account</th><th>Why</th><th class="num">List price</th><th>State</th><th>Decide</th></tr></thead><tbody id="queue"></tbody></table>
      <p class="rule-line">Akeso never removes access on its own. Nothing above has happened.</p>
    </section>

    <section class="view" id="v-receipts">
      <div class="h"><h2>Every change Akeso made</h2></div>
      <table><thead><tr><th>When</th><th>Account</th><th>Direction</th><th>Result</th></tr></thead><tbody id="restores"></tbody></table>
    </section>

    <section class="view" id="v-ledger">
      <div class="h"><h2>The ledger, as written</h2></div>
      <table><thead><tr><th>#</th><th>When</th><th>Kind</th><th>Summary</th></tr></thead><tbody id="entries"></tbody></table>
      <p class="note">Append-only and hash-chained. The seal at the top recomputes every hash in this browser; an entry edited after the fact breaks it.</p>
    </section>
  </main>
</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
${fonts}
<style>${CSS}</style>
</head><body>
${shell}
<script>window.AKESO = ${data}; window.AKESO.shell = ${JSON.stringify(shell)};</script>
<script>${JS}</script>
</body></html>`;
}
