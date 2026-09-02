/* The dashboard: the screen a founder lives in.
 *
 * One HTML file, no server, no account. The ledger is embedded (the local
 * `page` command) or dropped in (the site), and everything is folded in the
 * browser. Nothing is uploaded, so the privacy promise holds even for the
 * hosted copy.
 *
 * The design rule is the one a hardware designer would apply: one surface,
 * one typeface, one accent per state, and nothing on the screen that is not
 * a name, a value, or an action. The overview answers one question and names
 * one command. Everything else is a grouped list under a small heading, the
 * way a phone's settings are laid out, because a founder already knows how
 * to read that. Every fact appears once; the doctrine appears once.
 *
 * Doctrine carries into the browser unchanged: a step is lit only when it
 * executed, no number is invented, revenue recovered is never a figure, the
 * chain is verified here with the same hash the ledger wrote, and every action
 * is a command the page names rather than a button that does it.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/* Scenario ids the ledger stores, back into plain sentences with an outcome. */
const SCENARIO_NAMES = {
  "checkout-grants": "New payment: access starts",
  "trial-converts": "Trial ends and converts: access stays",
  "renewal-succeeds": "Renewal paid: access stays",
  "payment-fails": "Card fails after every retry: access ends",
  "cancel-at-period-end": "Customer cancels, period ends: access ends",
  "immediate-cancel": "Customer cancels immediately: access ends",
  reactivation: "Customer un-cancels in time: access stays",
  refund: "Charge refunded: follows your refund rule",
  "duplicate-delivery": "Stripe sends the same update twice: nothing changes",
  "out-of-order": "An old 'active' update arrives after a cancel: access stays ended",
};

const CSS = `
  :root {
    --bg:#f5f5f7; --group:#ffffff; --ink:#1d1d1f; --ink2:#6e6e73; --ink3:#86868b; --line:#e8e8ed;
    --ok:#34c759; --bad:#ff3b30; --wait:#ff9f0a; --link:#0066cc;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#000000; --group:#1c1c1e; --ink:#f5f5f7; --ink2:#a1a1a6; --ink3:#8e8e93; --line:#2c2c2e;
    --ok:#30d158; --bad:#ff453a; --wait:#ff9f0a; --link:#2997ff;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.47 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  code, .code { font-family:ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; font-size:13px; }
  :focus-visible { outline:2px solid var(--link); outline-offset:2px; border-radius:6px; }
  ::selection { background:color-mix(in srgb, var(--link) 22%, transparent); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px; }

  .nav { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter:saturate(180%) blur(20px); -webkit-backdrop-filter:saturate(180%) blur(20px); border-bottom:1px solid var(--line); }
  .nav .wrap { display:flex; align-items:center; gap:22px; height:48px; }
  .nav .brand { font-weight:600; letter-spacing:-.01em; }
  .nav nav { display:flex; gap:18px; overflow-x:auto; scrollbar-width:none; white-space:nowrap; font-size:13px; color:var(--ink2); padding:6px 0; }
  .nav nav::-webkit-scrollbar { display:none; }
  .nav nav a[aria-current] { color:var(--ink); }
  .nav nav a .n { color:var(--ink3); margin-left:4px; font-size:12px; }
  .nav .seal { margin-left:auto; font-size:12px; color:var(--ink2); white-space:nowrap; }
  .nav .seal.bad { color:var(--bad); }

  .demo { display:flex; gap:18px; align-items:center; flex-wrap:wrap; padding:14px 0 0; font-size:13px; color:var(--ink2); }
  .demo button, .demo label { color:var(--link); cursor:pointer; border:0; background:none; font:inherit; padding:0; }
  .demo .faint { color:var(--ink3); margin-left:-8px; }
  .demo .status.bad { color:var(--bad); }
  .panel { display:none; margin-top:14px; background:var(--group); border-radius:12px; padding:16px 18px; }
  .panel.on { display:block; }
  .panel .tabs { display:flex; gap:16px; font-size:13px; color:var(--ink2); margin-bottom:12px; flex-wrap:wrap; }
  .panel .tabs button { border:0; background:none; font:inherit; color:inherit; padding:0; cursor:pointer; }
  .panel .tabs button[aria-selected="true"] { color:var(--ink); font-weight:600; }
  .panel ol { margin:0 0 12px; padding-left:20px; color:var(--ink2); font-size:14px; }
  .panel .after { margin:10px 0 0; color:var(--ink2); font-size:13px; }
  .panel .after a { color:var(--link); }

  .view { display:none; padding:36px 0 72px; }
  .view.on { display:block; }
  .app { margin:0; font-size:13px; color:var(--ink2); }
  h1 { margin:4px 0 0; font-size:32px; line-height:1.15; font-weight:600; letter-spacing:-.022em; max-width:22ch; text-wrap:balance; }
  .lead { margin:8px 0 0; color:var(--ink2); max-width:56ch; }
  .cmd { display:flex; align-items:center; gap:10px; margin:18px 0 0; color:var(--ink2); flex-wrap:wrap; }
  .cmd code { color:var(--ink); }
  .cmd button, button.link { border:0; background:none; font:inherit; font-size:13px; color:var(--link); cursor:pointer; padding:6px 8px; margin:-6px -8px; border-radius:6px; }

  h2.label { margin:34px 0 8px; padding:0 18px; font-size:13px; font-weight:400; color:var(--ink2); display:flex; gap:12px; align-items:baseline; }
  h2.label .r { margin-left:auto; color:var(--ink3); font-size:12px; }
  .group { background:var(--group); border-radius:12px; overflow:hidden; margin-top:8px; }
  .group.first { margin-top:30px; }
  .row { display:flex; align-items:center; gap:14px; padding:12px 18px; min-height:46px; }
  .row + .row { border-top:1px solid var(--line); }
  .row .k { flex:1; min-width:0; }
  .row .sub { display:block; font-size:13px; color:var(--ink2); }
  .row .v { color:var(--ink2); text-align:right; white-space:nowrap; }
  .row .chev { color:var(--ink3); font-size:18px; line-height:1; }
  .row.empty { color:var(--ink2); }
  .row.cmdrow .k { overflow-wrap:anywhere; }
  a.row:hover, a.row:focus-visible { background:color-mix(in srgb, var(--ink) 3%, var(--group)); outline-offset:-2px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; background:transparent; border:1.5px solid var(--ink3); }
  .dot.ok { background:var(--ok); border-color:var(--ok); } .dot.bad { background:var(--bad); border-color:var(--bad); } .dot.wait { background:var(--wait); border-color:var(--wait); }

  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-weight:400; font-size:12px; color:var(--ink2); padding:10px 0 8px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { padding-left:18px; }
  th:last-child, td:last-child { padding-right:18px; }
  td { padding:11px 12px 11px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  td.mute { color:var(--ink2); width:100%; }
  td:not(.mute), th:not(.mute) { white-space:nowrap; }
  td[colspan] { white-space:normal; }
  td .dot { display:inline-block; vertical-align:middle; margin-right:10px; }
  td .sub { display:none; font-size:13px; color:var(--ink2); white-space:normal; }
  .foot { margin:26px 18px 0; font-size:13px; color:var(--ink2); }
  .seal2 { display:none; color:var(--ink3); } .seal2.bad { color:var(--bad); }

  @media (max-width:600px) {
    .wrap { padding:0 16px; }
    h1 { font-size:26px; }
    .nav nav { mask-image:linear-gradient(90deg, #000 85%, transparent); -webkit-mask-image:linear-gradient(90deg, #000 85%, transparent); }
    h2.label { padding:0 14px; } .row { padding:12px 14px; }
    th:first-child, td:first-child { padding-left:14px; } th:last-child, td:last-child { padding-right:14px; }
    .hide-s, .nav .seal, h2.label .r, .demo .faint { display:none; }
    td .sub { display:block; }
    .row .v { white-space:normal; max-width:58%; }
    .seal2 { display:inline; }
  }
`;

/* All of the folding happens here, in the browser. Kept deliberately close
   to the Node modules it mirrors, and kept free of template literals so it
   can live inside one. */
const JS = String.raw`
(function () {
  var NAMES = (window.AKESO && window.AKESO.scenarioNames) || {};
  var NOW = Date.now();
  var FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function when(iso) { var t = Date.parse(iso || ""); return isFinite(t) ? FMT.format(t) : ""; }
  function money(n) { return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(2) : ""; }
  function $(id) { return document.getElementById(id); }
  function cap(s) { s = String(s || "").replace(/_/g, " "); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function row(cls, dot, k, sub, v, href) {
    var inner = (dot ? '<span class="dot ' + dot + '" aria-hidden="true"></span>' : "") + '<span class="k">' + k + (sub ? '<span class="sub">' + sub + "</span>" : "") + "</span>" + (v != null ? '<span class="v">' + v + "</span>" : "") + (href ? '<span class="chev" aria-hidden="true">&rsaquo;</span>' : "");
    return href ? '<a class="row ' + cls + '" href="' + href + '">' + inner + "</a>" : '<div class="row ' + cls + '">' + inner + "</div>";
  }
  function cmdRow(c) { return '<div class="row cmdrow"><span class="k"><code>' + esc(c) + '</code></span><button class="link" data-copy="' + esc(c) + '">Copy</button></div>'; }
  function empty(text) { return '<div class="row empty">' + esc(text) + "</div>"; }

  function render() {
    var D = window.AKESO || {};
    var L = Array.isArray(D.ledger) ? D.ledger.filter(function (e) { return e && typeof e === "object"; }) : [];
    function kinds(k) { return L.filter(function (e) { return e.kind === k; }); }
    function last(k) { var a = kinds(k); return a.length ? a[a.length - 1] : null; }

    /* ---- fold ---- */
    var check = last("check"), fix = last("fix"), sweep = last("sweep"), cert = last("certify");
    var ranLive = !!(check && (check.lifecycleGrade || check.sandboxGrade));
    var grade = check ? (check.grade || null) : null;
    var passing = grade === "A";
    var provenFix = !!(fix && check && check.seq > fix.seq && passing);
    var accounts = (sweep && Array.isArray(sweep.accounts)) ? sweep.accounts : [];
    var matched = sweep && sweep.comparison && sweep.comparison.counts ? (sweep.comparison.counts.matched || 0) : 0;
    var scenarios = (check && check.scenarioResults) || [];
    var failed = scenarios.filter(function (r) { return r.outcome === "fail"; }).length;

    var restores = kinds("restore");
    var restored = restores.filter(function (e) { return e.direction === "grant" && e.result === "applied"; });
    var restoredFor = {}; restored.forEach(function (e) { if (e.verified) restoredFor[e.account] = e; });
    var removed = restores.filter(function (e) { return e.direction === "remove" && e.result === "applied"; });
    var unconfirmed = restores.filter(function (e) { return e.result === "applied" && !e.verified; });
    var sweeps = kinds("sweep").filter(function (e) { return e.comparison && !e.couldNotRun; });
    var lastGood = sweeps.length ? sweeps[sweeps.length - 1] : null;
    var covered = !!(cert && cert.policy);

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
    var queuedFor = {}; waiting.forEach(function (r) { queuedFor[r.account] = r; });

    /* an account restored and read back after the sweep no longer disagrees */
    function fixedSince(a) { var e = restoredFor[a.account]; return !!(e && sweep && Date.parse(e.at || "") >= Date.parse(sweep.at || "")); }
    var stillWrong = accounts.filter(function (a) { return (a.verdict === "locked_out" && !fixedSince(a)) || a.verdict === "still_entitled"; });
    var fixedNow = accounts.filter(function (a) { return a.verdict === "locked_out" && fixedSince(a); });
    var noVerdict = accounts.filter(function (a) { return a.verdict === "no_conclusion"; });
    var notInStripe = accounts.filter(function (a) { return a.verdict === "no_subscription"; });
    var agreeing = Math.max(0, matched - stillWrong.length - fixedNow.length);

    var states = {
      check: ranLive ? "done" : check ? "partial" : "todo",
      fix: provenFix ? "done" : (fix && !passing) ? "failed" : fix ? "partial" : (ranLive && !passing) ? "next" : (ranLive && passing) ? "notneeded" : "todo",
      monitor: (sweep && !sweep.couldNotRun && matched > 0) ? "done" : sweep ? "failed" : (passing || provenFix) ? "next" : "todo"
    };
    var DOT = { done: "ok", failed: "bad", partial: "wait", next: "", notneeded: "", todo: "" };

    /* ---- the next step: the same ladder as the terminal ---- */
    var step;
    if (!check) step = { h: "Not checked yet.", w: "", c: "npx akeso-check" };
    else if (!ranLive) step = { h: "Code read. Not yet run.", w: "Only the live Check, where a pretend customer pays and cancels, produces a grade.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (grade && grade !== "A" && grade !== "?") step = (fix && fix.seq > check.seq) ? { h: "Fix applied. Check still fails.", w: "A fix counts only when the Check passes afterwards.", c: "npx akeso-check fix --show" } : { h: "Grade " + grade + ". " + failed + " of " + scenarios.length + " situations fail.", w: "Fix rewrites the webhook handler and the one file that touches your database, with backups.", c: "npx akeso-check fix" };
    else if (grade === "?") step = { h: "The Check could not finish. No grade.", w: "The run failed, not your app. Start the app and run it again.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (sweep && sweep.couldNotRun) step = { h: "The last sweep could not run.", w: String(sweep.couldNotRun).replace(/\s+/g, " ").trim(), c: "npx akeso-check monitor" };
    else if (sweep && matched === 0) step = { h: "No account could be compared.", w: "Stripe and your app use different customer ids, so nothing lines up. Pass your account id to Stripe as client_reference_id at checkout, then sweep again.", c: "npx akeso-check monitor" };
    else if (sweep && waiting.length) step = { h: plural(waiting.length, "removal needs", "removals need") + " your approval.", w: "", c: "npx akeso-check approvals" };
    else if (sweep) step = stillWrong.length === 0 ? { h: "Stripe and your app agree.", w: "Every paying customer has access, and nobody who stopped paying still has it.", c: "npx akeso-check statement" } : { h: plural(stillWrong.length, "account disagrees", "accounts disagree") + " with Stripe.", w: "", c: "npx akeso-check monitor" };
    else step = { h: provenFix ? "The fix passed its re-test." : "Your billing code passes.", w: "Accounts that drifted before the fix are still wrong. Monitor compares them with Stripe.", c: "npx akeso-check monitor" };

    /* ---- render ---- */
    var app = D.appName || "Your app";
    document.querySelectorAll(".appName").forEach(function (n) { n.textContent = app; });
    document.title = "Akeso · " + app;
    $("verdict").textContent = step.h;
    $("lead").textContent = step.w || "";
    $("lead").hidden = !step.w;
    $("next").innerHTML = step.c ? '<code>' + esc(step.c) + '</code><button data-copy="' + esc(step.c) + '">Copy</button>' : "";
    $("next").hidden = !step.c;

    var na = $("count-approvals"); na.textContent = waiting.length ? String(waiting.length) : "";
    na.parentNode.setAttribute("aria-label", waiting.length ? "Approvals, " + waiting.length + " waiting" : "Approvals");
    var nl = $("count-ledger"); nl.textContent = L.length ? String(L.length) : "";
    nl.parentNode.setAttribute("aria-label", L.length ? "Ledger, " + L.length + " entries" : "Ledger");

    /* the loop */
    $("loop").innerHTML = [
      row("", DOT[states.check], "Check", null, ranLive ? "Grade " + esc(grade || "?") : check ? "Read, not run" : "Not run", "#check"),
      row("", DOT[states.fix], "Fix", null, provenFix ? plural((fix.files || []).length, "file", "files") + " · re-test passed" : (fix && !passing) ? "Applied · Check still fails" : fix ? "Applied · not re-tested" : states.fix === "notneeded" ? "Not needed" : states.fix === "next" ? "Next" : "Not yet", "#fix"),
      row("", DOT[states.monitor], "Monitor", null, states.monitor === "done" ? matched + " compared · " + plural(stillWrong.length, "disagrees", "disagree") + (fixedNow.length ? " · " + fixedNow.length + " restored" : "") : sweep && sweep.couldNotRun ? "Could not run" : sweep ? "Nothing to compare" : states.monitor === "next" ? "Next" : "Not yet", "#monitor")
    ].join("");

    /* waiting for approval: the row and its command, together */
    function approvalRows(r) {
      return row("", r.ready ? "wait" : "", '<span class="code">' + esc(r.account) + "</span>", esc(r.reason || "") + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + "/mo" : ""), r.ready ? "Ready to approve" : "Held until " + esc(when(r.readyAt))) +
        cmdRow("npx akeso-check approvals --approve " + r.id);
    }
    $("inbox").innerHTML = waiting.length ? waiting.map(approvalRows).join("") : empty("No removals waiting.");
    $("queue").innerHTML = waiting.length ? waiting.map(approvalRows).join("") : empty("No removals waiting.");

    /* totals */
    $("totals").innerHTML =
      row("", null, "Access restored", unconfirmed.length ? unconfirmed.length + " not yet confirmed" : null, String(restored.length)) +
      row("", null, "Access removed", null, String(removed.length)) +
      row("", null, "Unpaid access", null, lastGood ? money(Number(lastGood.comparison.monthlyExposure) || 0) + "/mo" : "No sweep yet");

    /* accounts, on Monitor */
    function stripeWord(a) { return a.stripe == null ? "No subscription" : a.stripe === "incomplete_expired" ? "Expired" : cap(a.stripe); }
    function appWord(a) { return fixedSince(a) ? "Has access" : a.app == null ? "Unknown" : a.app ? "Has access" : "No access"; }
    function meaning(a) {
      if (a.verdict === "locked_out") return fixedSince(a) ? "Restored by Akeso." : "Paying, locked out. Not yet restored.";
      if (a.verdict === "still_entitled") return queuedFor[a.account] ? "Not paying, still has access. Awaiting your approval." : "Not paying, still has access.";
      if (a.verdict === "no_conclusion") return "Payment not finished. No verdict.";
      if (a.verdict === "no_subscription") return "Not in Stripe. Left alone.";
      return "";
    }
    function dotFor(a) { return a.verdict === "locked_out" ? (fixedSince(a) ? "ok" : "bad") : a.verdict === "still_entitled" ? "wait" : ""; }
    function accountRow(a) { return '<tr><td><span class="dot ' + dotFor(a) + '" aria-hidden="true"></span><span class="code">' + esc(a.account) + '</span><span class="sub">' + esc(meaning(a)) + "</span></td><td>" + esc(stripeWord(a)) + "</td><td>" + esc(appWord(a)) + '</td><td class="mute hide-s">' + esc(meaning(a)) + '</td><td class="num">' + esc(money(a.priceMonthly)) + "</td></tr>"; }
    var shown = stillWrong.concat(fixedNow, noVerdict, notInStripe);
    var rows = shown.map(accountRow).join("");
    if (sweep && matched > 0 && agreeing > 0) rows += '<tr><td colspan="5" class="mute">' + agreeing + " agree</td></tr>";
    $("accounts").innerHTML = rows || '<tr><td colspan="5" class="mute">' + (sweep ? "Nothing to compare on the last sweep." : "No sweep has run yet.") + "</td></tr>";
    $("accountsN").textContent = sweep ? matched + " compared" : "";
    $("accountsWhen").textContent = sweep ? when(sweep.at) : "";

    /* check view */
    $("scenarios").innerHTML = scenarios.length ? scenarios.map(function (r) { var o = r.outcome; return row("", o === "pass" ? "ok" : o === "fail" ? "bad" : "", esc(NAMES[r.id] || r.id), null, o === "pass" ? "Passed" : o === "fail" ? "Failed" : o === "reported" ? "Not graded" : cap(o)); }).join("") : empty(check ? "Read, not run." : "Not run yet.");
    $("checkMeta").textContent = check ? (grade ? "Grade " + grade + " · " : "") + when(check.at) : "";

    /* fix view */
    $("files").innerHTML = fix ? (fix.files || []).map(function (f) { return row("", null, '<span class="code">' + esc(f.path || "") + "</span>", null, cap(f.action || "")); }).join("") : empty(states.fix === "notneeded" ? "Nothing needed fixing." : "No fix written yet.");
    $("fixMeta").textContent = fix ? when(fix.at) : "";
    $("fixProof").textContent = provenFix ? "Re-test passed." : (fix && !passing) ? "Re-test failed. Not counted as fixed." : fix ? "Applied, not yet re-tested." : "";

    /* monitor view */
    var sw = kinds("sweep");
    $("sweeps").innerHTML = sw.length ? sw.slice().reverse().map(function (e) { var c = e.comparison || {}; return row("", e.couldNotRun ? "bad" : c.comparable === false ? "" : c.clean ? "ok" : "wait", esc(when(e.at)), null, e.couldNotRun ? "Could not run" : c.comparable === false ? "Nothing to compare" : (c.counts ? c.counts.matched + " compared · " : "") + (c.clean ? "all agree" : money(Number(c.monthlyExposure) || 0) + "/mo unpaid")); }).join("") : empty("No sweep has run yet.");
    $("coverage").innerHTML = covered ? '<p class="foot">Access rules confirmed ' + esc(when(cert.at)) + ", version " + esc((cert.policy && cert.policy.ruleVersion) || "1") + ".</p>" : '<p class="foot">Access rules not confirmed yet.</p><div class="group">' + cmdRow("npx akeso-check certify") + "</div>";

    /* receipts view */
    $("restores").innerHTML = restores.length ? restores.slice().reverse().map(function (e) {
      var ok = e.result === "applied";
      var word = e.direction === "grant" ? (ok ? "Restored" : "Restore failed") : (ok ? "Removed" : "Removal failed");
      return row("", ok && e.verified ? "ok" : ok ? "wait" : "bad", '<span class="code">' + esc(e.account) + "</span>", esc(when(e.at)), esc(word) + (ok ? (e.verified ? " · confirmed" : " · not confirmed") : ""));
    }).join("") : empty("No changes yet.");

    /* ledger view + chain */
    $("entries").innerHTML = L.length ? L.slice().reverse().map(function (e) {
      var sum = e.kind === "check" ? (e.grade ? "Grade " + e.grade : "Code read") : e.kind === "fix" ? plural((e.files || []).length, "file written", "files written") : e.kind === "sweep" ? (e.couldNotRun ? "Could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? (e.direction === "grant" ? "Restored " : "Removed ") + (e.account || "") + (e.result === "applied" ? "" : " · " + e.result) : e.kind === "approval" ? "Removal " + (e.state === "cancelled" ? "canceled" : e.state || "") + " " + (e.account || "") : e.kind === "certify" ? "Access rules confirmed" : e.kind === "unreadable" ? "Unreadable line" : "";
      return row("", null, '<span class="code">' + esc(e.seq || "") + "</span>&nbsp;&nbsp;" + esc(e.kind === "unreadable" ? "Line " + e.line : cap(e.kind)), esc(sum), esc(when(e.at)));
    }).join("") : empty("The ledger is empty.");

    var seal = $("seal"); seal.className = "seal"; seal.textContent = L.length ? "Verifying" : "No ledger";
    function setSeal(text, bad) { seal.textContent = text; seal.className = "seal" + (bad ? " bad" : ""); var s2 = $("seal2"); if (s2) { s2.textContent = " · " + text; s2.className = "seal2" + (bad ? " bad" : ""); } }
    var badLine = L.find(function (e) { return e.kind === "unreadable"; });
    if (badLine) setSeal("Line " + badLine.line + " unreadable", true);
    else if (L.length && window.crypto && crypto.subtle) {
      (async function () {
        function sha(s) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (b) { return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }); }
        var prev = null, broken = null;
        for (var i = 0; i < L.length; i++) {
          var e = L[i]; var rest = {}; Object.keys(e).forEach(function (k) { if (k !== "hash") rest[k] = e[k]; });
          if ((e.prev || null) !== prev) { broken = e.seq || i + 1; break; }
          var h = await sha((prev || "genesis") + "\n" + JSON.stringify(rest));
          if (h !== e.hash) { broken = e.seq || i + 1; break; }
          prev = e.hash;
        }
        setSeal(broken ? "Entry " + broken + " does not verify" : L.length + " entries · verified", !!broken);
      })();
    } else if (L.length) { setSeal(L.length + " entries · not verified", false); }

    /* site only: load a ledger file, run panel */
    var file = $("ledgerFile"); if (file) file.addEventListener("change", function () {
      var f = file.files[0]; if (!f) return;
      f.text().then(function (t) {
        var n = 0, rows = t.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { n++; try { var o = JSON.parse(l); return (o && typeof o === "object") ? o : { kind: "unreadable", line: n }; } catch (x) { return { kind: "unreadable", line: n }; } });
        var real = rows.filter(function (e) { return e.kind !== "unreadable" && e.hash; });
        var status = $("status");
        if (!real.length) { if (status) { status.textContent = "That file is not an Akeso ledger. Showing the demo."; status.className = "status bad"; } return; }
        var named = rows.find(function (e) { return e.appName || e.app; });
        window.AKESO = Object.assign({}, D, { ledger: rows, appName: (named && (named.appName || named.app)) || "Your app", demo: false, fileName: f.name });
        document.body.innerHTML = D.shell; render(); route();
      });
    });
    var status0 = $("status"); if (status0 && D.demo === false) { status0.textContent = esc(D.fileName || "Your ledger") + " · " + plural(L.length, "entry", "entries"); status0.className = "status"; }
    var runBtn = $("runBtn"), panel = $("runPanel"); if (runBtn && panel) runBtn.addEventListener("click", function () { var open = !panel.classList.contains("on"); panel.classList.toggle("on", open); runBtn.setAttribute("aria-expanded", String(open)); });
    var tabs = $("tabs"); if (tabs) {
      var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English.";
      var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } };
      tabs.addEventListener("click", function (e) { var t = e.target.dataset.tool; if (!t) return; tabs.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-selected", String(b === e.target)); }); $("cmd").textContent = T[t].paste; $("cmdCopy").dataset.copy = T[t].paste; $("steps").hidden = !T[t].steps; $("stepsAfter").hidden = !T[t].steps; });
    }
  }

  /* nav + copy live on the document, so they survive a re-render */
  function show(id) { document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("on", v.id === "v-" + id); }); document.querySelectorAll("[data-view]").forEach(function (a) { if (a.dataset.view === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }); window.scrollTo(0, 0); }
  function route() { var id = (location.hash || "#overview").slice(1); show(document.getElementById("v-" + id) ? id : "overview"); }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]"); if (!b) return;
    var done = function (t) { b.textContent = t; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(function () { done("Copied"); }, function () { done("Select and copy"); });
    else done("Select and copy");
  });
  render(); route();
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  const data = JSON.stringify({ ledger, appName, demo, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");

  const runPanel = hosted ? `
    <div class="demo"><span class="status" id="status">${demo ? "Demo: a real run on a test app." : ""}</span><button type="button" id="runBtn" aria-expanded="false" aria-controls="runPanel">How to run it</button><label>Load your ledger<input type="file" id="ledgerFile" class="sr" accept=".jsonl,application/json,text/plain"></label><span class="faint">Never uploaded.</span></div>
    <div class="panel" id="runPanel">
      <div class="tabs" id="tabs" role="tablist"><button role="tab" aria-selected="true" data-tool="terminal">Terminal</button><button role="tab" aria-selected="false" data-tool="claude">Claude Code</button><button role="tab" aria-selected="false" data-tool="cursor">Cursor</button><button role="tab" aria-selected="false" data-tool="codex">Codex</button><button role="tab" aria-selected="false" data-tool="lovable">Lovable / Bolt / v0</button></div>
      <ol id="steps" hidden>
        <li>Open your project in your builder.</li><li>Click GitHub (top right) and follow its steps to put your project on GitHub.</li><li>Go to github.com and open your new repository.</li><li>Click the green Code button.</li><li>Click Codespaces, then Create codespace on main.</li><li>A code editor opens in a new tab. Wait for it to load.</li><li>If a box asks Do you trust the authors, click Trust Folder and Continue.</li><li>Click the terminal panel at the bottom, paste this, press Enter:</li>
      </ol>
      <div class="cmd" style="margin:0"><code id="cmd">npx akeso-check</code><button id="cmdCopy" data-copy="npx akeso-check">Copy</button></div>
      <p class="after" id="stepsAfter" hidden>When it finishes, .akeso/ledger.jsonl is in your project. Load it above.</p>
      <p class="after">Free, runs on your machine, no dependencies. Source: <a href="https://github.com/jacekimmy/akeso-check">github.com/jacekimmy/akeso-check</a></p>
    </div>` : "";

  const eyebrow = `<p class="app"><span class="appName"></span><span class="seal2" id="seal2"></span></p>`;

  const shell = `<header class="nav"><div class="wrap">
    <span class="brand">Akeso</span>
    <nav aria-label="Views">
      <a href="#overview" data-view="overview">Overview</a>
      <a href="#check" data-view="check">Check</a>
      <a href="#fix" data-view="fix">Fix</a>
      <a href="#monitor" data-view="monitor">Monitor</a>
      <a href="#approvals" data-view="approvals">Approvals<span class="n" id="count-approvals" aria-hidden="true"></span></a>
      <a href="#receipts" data-view="receipts">Receipts</a>
      <a href="#ledger" data-view="ledger">Ledger<span class="n" id="count-ledger" aria-hidden="true"></span></a>
    </nav>
    <span class="seal" id="seal" aria-live="polite"></span>
  </div></header>
  <main class="wrap">
    ${runPanel}

    <section class="view on" id="v-overview">
      ${eyebrow}
      <h1 id="verdict"></h1>
      <p class="lead" id="lead"></p>
      <div class="cmd" id="next"></div>

      <div class="group first" id="loop"></div>

      <h2 class="label">Waiting for your approval</h2>
      <div class="group" id="inbox"></div>

      <h2 class="label">Totals</h2>
      <div class="group" id="totals"></div>

      <p class="foot">Akeso restores access on its own. It never removes access on its own.</p>
    </section>

    <section class="view" id="v-check">
      ${eyebrow}
      <h1>Check</h1>
      <h2 class="label">Ten billing situations<span class="r" id="checkMeta"></span></h2>
      <div class="group" id="scenarios"></div>
    </section>

    <section class="view" id="v-fix">
      ${eyebrow}
      <h1>Fix</h1>
      <h2 class="label">Files written<span class="r" id="fixMeta"></span></h2>
      <div class="group" id="files"></div>
      <p class="foot" id="fixProof"></p>
    </section>

    <section class="view" id="v-monitor">
      ${eyebrow}
      <h1>Monitor</h1>
      <h2 class="label">Sweeps</h2>
      <div class="group" id="sweeps"></div>
      <h2 class="label">Accounts, last sweep<span class="r"><span id="accountsN"></span> &nbsp; <span id="accountsWhen"></span></span></h2>
      <div class="group"><table><thead><tr><th>Account</th><th>Stripe says</th><th>App says</th><th class="hide-s">Meaning</th><th class="num">Monthly</th></tr></thead><tbody id="accounts"></tbody></table></div>
      <div id="coverage"></div>
    </section>

    <section class="view" id="v-approvals">
      ${eyebrow}
      <h1>Approvals</h1>
      <h2 class="label">Waiting for your approval</h2>
      <div class="group" id="queue"></div>
      <p class="foot">Nothing here is removed until you approve it.</p>
    </section>

    <section class="view" id="v-receipts">
      ${eyebrow}
      <h1>Receipts</h1>
      <h2 class="label">Changes made</h2>
      <div class="group" id="restores"></div>
      <h2 class="label">Not counted</h2>
      <div class="group"><div class="row"><span class="k">Revenue recovered<span class="sub">Akeso does not see your payouts</span></span><span class="v">Not measured</span></div></div>
    </section>

    <section class="view" id="v-ledger">
      ${eyebrow}
      <h1>Ledger</h1>
      <h2 class="label">${hosted ? "Entries" : escapeHtml(root ? `${root}/.akeso/ledger.jsonl` : ".akeso/ledger.jsonl")}</h2>
      <div class="group" id="entries"></div>
      <p class="foot">Each entry is hashed with the one before it. This page recomputes every hash; an edited entry shows as not verified.</p>
    </section>
  </main>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
<style>${CSS}</style>
</head><body>
${shell}
<script>window.AKESO = ${data}; window.AKESO.shell = ${JSON.stringify(shell)};</script>
<script>${JS}</script>
</body></html>`;
}
