/* The dashboard: the screen a founder lives in.
 *
 * One HTML file, no server, no account. The ledger is embedded (the local
 * `page` command) or dropped in (the site), and everything is folded in the
 * browser. Nothing is uploaded, so the privacy promise holds even for the
 * hosted copy.
 *
 * The design rule is the one a hardware designer would apply: one surface,
 * one typeface, one accent per state, and nothing on the screen that is not
 * a name, a value, or an action. Structure comes from grouped lists with a
 * small label above each, the way a phone's settings are laid out, because
 * a founder already knows how to read that. The three steps of the loop are
 * the first group, each row carrying its live state, so the connection
 * between them is the first thing on the page rather than a diagram.
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
    --bg:#f5f5f7; --group:#ffffff; --ink:#1d1d1f; --ink2:#6e6e73; --ink3:#aeaeb2; --line:#e8e8ed;
    --ok:#34c759; --bad:#ff3b30; --wait:#ff9f0a; --link:#0066cc;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#000000; --group:#1c1c1e; --ink:#f5f5f7; --ink2:#98989d; --ink3:#636366; --line:#2c2c2e;
    --ok:#30d158; --bad:#ff453a; --wait:#ffd60a; --link:#2997ff;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.47 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  code, .code { font-family:ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; font-size:13px; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px; }

  .nav { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter:saturate(180%) blur(20px); -webkit-backdrop-filter:saturate(180%) blur(20px); border-bottom:1px solid var(--line); }
  .nav .wrap { display:flex; align-items:center; gap:22px; height:48px; }
  .nav .brand { font-weight:600; letter-spacing:-.01em; }
  .nav nav { display:flex; gap:18px; overflow-x:auto; scrollbar-width:none; white-space:nowrap; font-size:13px; color:var(--ink2); }
  .nav nav::-webkit-scrollbar { display:none; }
  .nav nav a.on { color:var(--ink); }
  .nav nav a .n { color:var(--ink3); margin-left:4px; font-size:12px; }
  .nav .seal { margin-left:auto; font-size:12px; color:var(--ink3); white-space:nowrap; }
  .nav .seal.bad { color:var(--bad); }

  .demo { display:flex; gap:18px; align-items:center; flex-wrap:wrap; padding:14px 0 0; font-size:13px; color:var(--ink2); }
  .demo a, .demo label { color:var(--link); cursor:pointer; }
  .demo .faint { color:var(--ink3); margin-left:-8px; }
  .demo label input { display:none; }
  .panel { display:none; margin-top:14px; background:var(--group); border-radius:12px; padding:16px 18px; }
  .panel.on { display:block; }
  .panel .tabs { display:flex; gap:16px; font-size:13px; color:var(--ink2); margin-bottom:12px; flex-wrap:wrap; }
  .panel .tabs button { border:0; background:none; font:inherit; color:inherit; padding:0; cursor:pointer; }
  .panel .tabs button.on { color:var(--ink); font-weight:600; }
  .panel ol { margin:0 0 12px; padding-left:20px; color:var(--ink2); font-size:14px; }
  .panel .after { margin:10px 0 0; color:var(--ink2); font-size:13px; }
  .panel .after a { color:var(--link); }

  .view { display:none; padding:36px 0 72px; }
  .view.on { display:block; }
  .app { margin:0; font-size:13px; color:var(--ink2); }
  .seal2 { display:none; color:var(--ink3); } .seal2.bad { color:var(--bad); }
  h1 { margin:4px 0 0; font-size:32px; line-height:1.15; font-weight:600; letter-spacing:-.022em; max-width:22ch; }
  .lead { margin:8px 0 0; color:var(--ink2); max-width:56ch; }
  .cmd { display:flex; align-items:center; gap:14px; margin:18px 0 0; color:var(--ink2); }
  .cmd code { color:var(--ink); }
  .cmd button, button.link { border:0; background:none; font:inherit; font-size:13px; color:var(--link); cursor:pointer; padding:0; }

  .label { margin:34px 0 8px; padding:0 18px; font-size:13px; color:var(--ink2); display:flex; gap:12px; align-items:baseline; }
  .label .r { margin-left:auto; color:var(--ink3); font-size:12px; }
  .group { background:var(--group); border-radius:12px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:14px; padding:12px 18px; min-height:46px; }
  .row + .row { border-top:1px solid var(--line); }
  .row .k { flex:1; min-width:0; }
  .row .sub { display:block; font-size:13px; color:var(--ink2); }
  .row .v { color:var(--ink2); text-align:right; white-space:nowrap; }
  .row .v.ink { color:var(--ink); }
  .row .chev { color:var(--ink3); font-size:18px; line-height:1; }
  .row.empty { color:var(--ink2); }
  .row.faint .k, .row.faint .v { color:var(--ink2); }
  .row.total { border-top:1px solid var(--ink2); }
  .row.total .v { color:var(--ink); }
  a.row:hover { background:color-mix(in srgb, var(--ink) 3%, var(--group)); }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--ink3); }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--bad); } .dot.wait { background:var(--wait); }
  .dot.next { background:transparent; border:1.5px solid var(--ink2); }
  .dot.none { background:transparent; border:1.5px solid var(--ink3); }
  .dot.todo { background:var(--line); }

  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-weight:400; font-size:12px; color:var(--ink2); padding:10px 0 8px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { padding-left:18px; }
  th:last-child, td:last-child { padding-right:18px; }
  td { padding:11px 12px 11px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  td.num, th.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.mute { color:var(--ink2); width:100%; }
  td:not(.mute), th:not(.mute) { white-space:nowrap; }
  td[colspan] { white-space:normal; }
  td .dot { display:inline-block; vertical-align:middle; margin-right:10px; }
  .foot { margin:26px 18px 0; font-size:13px; color:var(--ink2); }

  @media (max-width:600px) {
    .wrap { padding:0 16px; }
    h1 { font-size:26px; }
    .label { padding:0 14px; } .row { padding:12px 14px; }
    th:first-child, td:first-child { padding-left:14px; } th:last-child, td:last-child { padding-right:14px; }
    .hide-s, .nav .seal, .label .r, .demo .faint { display:none; }
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
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function when(iso) { return iso ? String(iso).slice(0, 16).replace("T", " ") : ""; }
  function money(n) { return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(2) : ""; }
  function $(id) { return document.getElementById(id); }
  function cap(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function row(cls, dot, k, sub, v, href) {
    var inner = (dot ? '<span class="dot ' + dot + '"></span>' : "") + '<span class="k">' + k + (sub ? '<span class="sub">' + sub + "</span>" : "") + "</span>" + (v != null ? '<span class="v">' + v + "</span>" : "") + (href ? '<span class="chev">&rsaquo;</span>' : "");
    return href ? '<a class="row ' + cls + '" href="' + href + '">' + inner + "</a>" : '<div class="row ' + cls + '">' + inner + "</div>";
  }
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
    var disagree = accounts.filter(function (a) { return a.verdict === "locked_out" || a.verdict === "still_entitled"; });
    var agreeing = Math.max(0, matched - disagree.length);
    var scenarios = (check && check.scenarioResults) || [];
    var passed = scenarios.filter(function (r) { return r.outcome === "pass"; }).length;

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

    var restores = kinds("restore");
    var restored = restores.filter(function (e) { return e.direction === "grant" && e.result === "applied"; });
    var restoredFor = {}; restored.forEach(function (e) { restoredFor[e.account] = e; });
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
    var DOT = { done: "ok", failed: "bad", partial: "wait", next: "next", notneeded: "none", todo: "todo" };

    /* ---- the next step: the same ladder as the terminal ---- */
    var step;
    if (!check) step = { h: "Nothing has been checked yet.", w: "", c: "npx akeso-check" };
    else if (!ranLive) step = { h: "Your code was read. It has not been run.", w: "Only the live test, where a pretend customer pays and cancels, produces a grade.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (grade && grade !== "A" && grade !== "?") step = (fix && fix.seq > check.seq) ? { h: "The repair is in. The test still fails.", w: "Akeso will not call a repair successful when its own test disagrees.", c: "npx akeso-check fix --show" } : { h: "Grade " + grade + ". " + plural(scenarios.length - passed, "situation", "situations") + " handled wrong.", w: "The fix writes the corrected webhook handler and the one file that touches your database.", c: "npx akeso-check fix" };
    else if (grade === "?") step = { h: "The run had problems, so there is no verdict.", w: "This is about the run, not your app.", c: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (sweep && sweep.couldNotRun) step = { h: "The last sweep could not run.", w: String(sweep.couldNotRun), c: "npx akeso-check monitor" };
    else if (sweep && matched === 0) step = { h: "Nothing could be compared yet.", w: "No Stripe subscription matched any account your app reported. Stripe has to carry the account id your app uses.", c: null };
    else if (sweep && waiting.length) step = { h: plural(waiting.length, "removal is", "removals are") + " waiting for your yes.", w: "Akeso never takes access away without a person deciding.", c: "npx akeso-check approvals" };
    else if (sweep) step = sweep.comparison && sweep.comparison.clean ? { h: "Everything matches.", w: "Every paying customer has access, and nobody who stopped paying still has it.", c: "npx akeso-check statement" } : { h: "Accounts do not match.", w: "The list below names them.", c: "npx akeso-check approvals" };
    else step = { h: provenFix ? "The repair holds." : "Your billing code passes.", w: "Correct code from now on does not fix accounts that already drifted. The monitor compares today's real customers against Stripe.", c: "npx akeso-check monitor" };

    /* ---- render ---- */
    var app = D.appName || "this app";
    document.querySelectorAll(".appName").forEach(function (n) { n.textContent = app; });
    $("verdict").textContent = step.h;
    $("lead").textContent = step.w || "";
    $("lead").hidden = !step.w;
    $("next").innerHTML = step.c ? '<code>' + esc(step.c) + '</code><button data-copy="' + esc(step.c) + '">Copy</button>' : "";
    $("next").hidden = !step.c;

    var na = $("count-approvals"); na.textContent = waiting.length ? String(waiting.length) : "";
    $("count-ledger").textContent = L.length ? String(L.length) : "";

    /* the loop */
    var loopRows = [
      row("", DOT[states.check], "Check", null, ranLive ? "Grade " + esc(grade || "?") : check ? "Code read, not run" : "Not run", "#check"),
      row("", DOT[states.fix], "Fix", null, provenFix ? plural((fix.files || []).length, "file", "files") + " · proven by re-test" : (fix && !passing) ? "Applied · test still fails" : fix ? "Applied · not re-tested" : states.fix === "notneeded" ? "Not needed" : states.fix === "next" ? "Next" : "Not yet", "#fix"),
      row("", DOT[states.monitor], "Monitor", null, states.monitor === "done" ? matched + " compared · " + plural(disagree.length, "disagrees", "disagree") : sweep && sweep.couldNotRun ? "Could not run" : sweep ? "Compared nothing" : states.monitor === "next" ? "Next" : "Not yet", "#monitor")
    ];
    $("loop").innerHTML = loopRows.join("");

    /* waiting for you */
    $("inbox").innerHTML = waiting.length ? waiting.map(function (r) {
      return row("", r.ready ? "wait" : "none", '<span class="code">' + esc(r.account) + "</span>", esc(r.reason || ""), (typeof r.priceMonthly === "number" ? money(r.priceMonthly) + "/mo · " : "") + (r.ready ? "Ready" : "Opens " + esc(when(r.readyAt))), "#approvals");
    }).join("") : empty("Nothing. Akeso never removes access on its own, so removals only ever appear here.");

    /* accounts that disagree */
    function stripeWord(a) { return a.stripe == null ? "None" : cap(a.stripe); }
    function appWord(a) { return a.app == null ? "Unknown" : a.app ? "Has access" : "No access"; }
    function meaning(a) {
      if (a.verdict === "locked_out") return restoredFor[a.account] ? "Paying, was locked out. Restored." : "Paying, locked out. Akeso restores this.";
      if (a.verdict === "still_entitled") return queuedFor[a.account] ? "Not paying, still has access. Waiting for your yes." : "Not paying, still has access.";
      if (a.verdict === "no_conclusion") return "Mid-flight. No verdict.";
      if (a.verdict === "no_subscription") return "No Stripe subscription. Reported only.";
      return "";
    }
    function dotFor(a) { return a.verdict === "locked_out" ? (restoredFor[a.account] ? "ok" : "bad") : a.verdict === "still_entitled" ? "wait" : "none"; }
    function accountRow(a) { return '<tr><td><span class="dot ' + dotFor(a) + '"></span><span class="code">' + esc(a.account) + "</span></td><td>" + esc(stripeWord(a)) + "</td><td>" + esc(appWord(a)) + '</td><td class="mute hide-s">' + esc(meaning(a)) + '</td><td class="num">' + esc(money(a.priceMonthly)) + "</td></tr>"; }
    var rows = disagree.map(accountRow).join("");
    var rest = [];
    var mid = accounts.filter(function (a) { return a.verdict === "no_conclusion"; }).length;
    var nosub = accounts.filter(function (a) { return a.verdict === "no_subscription"; }).length;
    if (sweep && matched > 0) rest.push(agreeing + " agree");
    if (mid) rest.push(mid + " mid-flight");
    if (nosub) rest.push(nosub + " without a subscription");
    if (rest.length) rows += '<tr><td colspan="5" class="mute">' + esc(rest.join(" · ")) + "</td></tr>";
    $("accounts").innerHTML = rows || '<tr><td colspan="5" class="mute">' + (sweep ? "Nothing could be compared on the last sweep." : "No sweep has run yet.") + "</td></tr>";
    $("accountsN").textContent = sweep ? matched + " compared" : "";
    $("accountsWhen").textContent = sweep ? when(sweep.at) : "";

    /* receipts */
    $("receipts").innerHTML =
      row("", null, "Access restored", verified.length + " confirmed by reading back", '<span class="ink">' + restored.length + "</span>") +
      row("", null, "Access removed", null, '<span class="ink">' + removed.length + "</span>") +
      row("", null, "Exposure, per sweep", null, sweeps.length ? money(exposure) + "/mo" : "Not measured") +
      row("total", null, "Revenue recovered", "Akeso does not see your payouts", "Not measured");

    /* check view */
    $("scenarios").innerHTML = scenarios.length ? scenarios.map(function (r) { var o = r.outcome; return row("", o === "pass" ? "ok" : o === "fail" ? "bad" : "none", esc(NAMES[r.id] || r.id), null, o === "pass" ? "Passed" : o === "fail" ? "Failed" : cap(o)); }).join("") : empty(check ? "The code was read. The live test has not run." : "Not run yet.");
    $("checkMeta").textContent = check ? (grade ? "Grade " + grade + " · " : "") + when(check.at) : "";

    /* fix view */
    $("files").innerHTML = fix ? (fix.files || []).map(function (f) { return row("", null, '<span class="code">' + esc(f.path || "") + "</span>", null, cap(f.action || "")); }).join("") : empty(states.fix === "notneeded" ? "Nothing needed repairing." : "No repair has been written.");
    $("fixMeta").textContent = fix ? when(fix.at) : "";
    $("fixProof").textContent = provenFix ? "The same test was run again afterwards and passed." : (fix && !passing) ? "The test still fails, so Akeso does not call this repaired." : fix ? "Applied, not yet re-tested." : "";

    /* monitor view: every sweep, then the full account table */
    var sw = kinds("sweep");
    $("sweeps").innerHTML = sw.length ? sw.slice().reverse().map(function (e) { var c = e.comparison || {}; return row("", e.couldNotRun ? "bad" : c.comparable === false ? "none" : c.clean ? "ok" : "wait", esc(when(e.at)), null, e.couldNotRun ? "Could not run" : c.comparable === false ? "Compared nothing" : (c.counts ? c.counts.matched + " compared · " : "") + (c.clean ? "all match" : money(c.monthlyExposure) + "/mo exposed")); }).join("") : empty("No sweep has run yet.");
    $("allAccounts").innerHTML = accounts.length ? accounts.map(accountRow).join("") + (sweep && matched > 0 && agreeing > 0 ? '<tr><td colspan="5" class="mute">' + agreeing + " more agree</td></tr>" : "") : '<tr><td colspan="5" class="mute">No accounts to show.</td></tr>';
    $("coverage").textContent = covered ? "Covered since " + when(cert.at) + ", rule version " + ((cert.policy && cert.policy.ruleVersion) || "1") + "." : "Not covering this app yet. Coverage starts when you confirm the rules: npx akeso-check certify";

    /* approvals view */
    $("queue").innerHTML = waiting.length ? waiting.map(function (r) {
      var c = "npx akeso-check approvals --approve " + r.id;
      return row("", r.ready ? "wait" : "none", '<span class="code">' + esc(r.account) + "</span>", esc(r.reason || "") + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + "/mo" : ""), r.ready ? "Ready" : "Opens " + esc(when(r.readyAt))) +
        '<div class="row"><span class="k"><code>' + esc(c) + '</code></span><button class="link" data-copy="' + esc(c) + '">Copy</button></div>';
    }).join("") : empty("Nothing is waiting for you.");

    /* receipts view */
    $("restores").innerHTML = restores.length ? restores.slice().reverse().map(function (e) { return row("", e.result === "applied" && e.verified ? "ok" : e.result === "applied" ? "wait" : "bad", '<span class="code">' + esc(e.account) + "</span>", esc(when(e.at)), esc(cap(e.direction)) + " · " + (e.result === "applied" && e.verified ? "confirmed" : esc(e.result || ""))); }).join("") : empty("No changes have been made.");

    /* ledger view + chain */
    $("entries").innerHTML = L.length ? L.slice().reverse().map(function (e) {
      var sum = e.kind === "check" ? "Grade " + (e.grade || "read only") : e.kind === "fix" ? plural((e.files || []).length, "file", "files") : e.kind === "sweep" ? (e.couldNotRun ? "Could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? cap(e.direction) + " " + e.account + " · " + e.result : e.kind === "approval" ? cap(e.state) + " " + (e.account || "") : e.kind === "certify" ? "Rules confirmed" : "";
      return row("", null, '<span class="code">' + esc(e.seq) + "</span>&nbsp;&nbsp;" + esc(cap(e.kind)), esc(sum), esc(when(e.at)));
    }).join("") : empty("The ledger is empty.");

    var seal = $("seal"); seal.className = "seal"; seal.textContent = L.length ? "Verifying" : "No ledger";
    if (L.length && window.crypto && crypto.subtle) {
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
        seal.textContent = broken ? "Chain broken at entry " + broken : L.length + " entries · chain intact";
        seal.className = "seal" + (broken ? " bad" : "");
        var s2 = $("seal2"); if (s2) { s2.textContent = " · " + seal.textContent; s2.className = "seal2" + (broken ? " bad" : ""); }
      })();
    } else if (L.length) { seal.textContent = L.length + " entries"; }

    /* site only: load a ledger file, run panel */
    var file = $("ledgerFile"); if (file) file.addEventListener("change", function () { var f = file.files[0]; if (!f) return; f.text().then(function (t) { var rows = t.split("\n").filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (x) { return { kind: "unreadable" }; } }); window.AKESO = Object.assign({}, D, { ledger: rows, appName: f.name.replace(/\.jsonl$/, ""), demo: false }); document.body.innerHTML = D.shell; render(); route(); }); });
    var runBtn = $("runBtn"), panel = $("runPanel"); if (runBtn && panel) runBtn.addEventListener("click", function (e) { e.preventDefault(); panel.classList.toggle("on"); });
    var tabs = $("tabs"); if (tabs) {
      var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English.";
      var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } };
      tabs.addEventListener("click", function (e) { var t = e.target.dataset.tool; if (!t) return; tabs.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === e.target); }); $("cmd").textContent = T[t].paste; $("cmdCopy").dataset.copy = T[t].paste; $("steps").hidden = !T[t].steps; $("stepsAfter").hidden = !T[t].steps; });
    }
    var demoLine = $("demoLine"); if (demoLine && D.demo === false) demoLine.remove();
  }

  /* nav + copy live on the document, so they survive a re-render */
  var TITLES = { overview: "Overview", check: "Check", fix: "Fix", monitor: "Monitor", approvals: "Approvals", receipts: "Receipts", ledger: "Ledger" };
  function show(id) { document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("on", v.id === "v-" + id); }); document.querySelectorAll("[data-view]").forEach(function (a) { a.classList.toggle("on", a.dataset.view === id); }); window.scrollTo(0, 0); }
  function route() { var id = (location.hash || "#overview").slice(1); show(document.getElementById("v-" + id) ? id : "overview"); }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", function (e) { var b = e.target.closest("[data-copy]"); if (!b) return; navigator.clipboard.writeText(b.dataset.copy).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); }); });
  render(); route();
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  const data = JSON.stringify({ ledger, appName, demo, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");

  const runPanel = hosted ? `
    <div class="demo">${demo ? `<span id="demoLine">Demo ledger, from a real run on a test app.</span>` : ""}<a href="#" id="runBtn">Run on your app</a><label>Load your ledger<input type="file" id="ledgerFile" accept=".jsonl,application/json,text/plain"></label><span class="faint">read in this tab, never uploaded</span></div>
    <div class="panel" id="runPanel">
      <div class="tabs" id="tabs"><button class="on" data-tool="terminal">Terminal</button><button data-tool="claude">Claude Code</button><button data-tool="cursor">Cursor</button><button data-tool="codex">Codex</button><button data-tool="lovable">Lovable / Bolt / v0</button></div>
      <ol id="steps" hidden>
        <li>Open your project in your builder.</li><li>Click the GitHub button, usually at the top right, and follow its steps to put your project on GitHub. Lovable, Bolt and v0 all have this.</li><li>Go to github.com and open your new repository.</li><li>Click the green Code button.</li><li>Click Codespaces, then Create codespace on main.</li><li>A code editor opens in a new browser tab. Wait for it to finish loading.</li><li>If a box asks Do you trust the authors, click Trust Folder and Continue.</li><li>Click inside the terminal panel at the bottom of the screen, paste this, and press Enter:</li>
      </ol>
      <div class="cmd" style="margin:0"><code id="cmd">npx akeso-check</code><button id="cmdCopy" data-copy="npx akeso-check">Copy</button></div>
      <p class="after" id="stepsAfter" hidden>When it finishes, your results print in the terminal and .akeso/ledger.jsonl is written in your project. Load it above to see it here.</p>
      <p class="after">Free. Runs on your machine. Zero dependencies, plain JavaScript you can read first: <a href="https://github.com/jacekimmy/akeso-check">github.com/jacekimmy/akeso-check</a></p>
    </div>` : "";

  const table = (id) => `<div class="group"><table><thead><tr><th>Account</th><th>Stripe says</th><th>App says</th><th class="hide-s">Meaning</th><th class="num">List price</th></tr></thead><tbody id="${id}"></tbody></table></div>`;

  const shell = `<header class="nav"><div class="wrap">
    <span class="brand">Akeso</span>
    <nav>
      <a href="#overview" data-view="overview">Overview</a>
      <a href="#check" data-view="check">Check</a>
      <a href="#fix" data-view="fix">Fix</a>
      <a href="#monitor" data-view="monitor">Monitor</a>
      <a href="#approvals" data-view="approvals">Approvals<span class="n" id="count-approvals"></span></a>
      <a href="#receipts" data-view="receipts">Receipts</a>
      <a href="#ledger" data-view="ledger">Ledger<span class="n" id="count-ledger"></span></a>
    </nav>
    <span class="seal" id="seal"></span>
  </div></header>
  <main class="wrap">
    ${runPanel}

    <section class="view on" id="v-overview">
      <p class="app"><span class="appName"></span><span class="seal2" id="seal2"></span></p>
      <h1 id="verdict"></h1>
      <p class="lead" id="lead"></p>
      <div class="cmd" id="next"></div>

      <div class="label">The loop</div>
      <div class="group" id="loop"></div>

      <div class="label">Waiting for you</div>
      <div class="group" id="inbox"></div>

      <div class="label">Accounts that disagree<span class="r"><span id="accountsN"></span> &nbsp; <span id="accountsWhen"></span></span></div>
      ${table("accounts")}

      <div class="label">Receipts</div>
      <div class="group" id="receipts"></div>

      <p class="foot">Akeso restores access on its own. It never removes access on its own.</p>
    </section>

    <section class="view" id="v-check">
      <p class="app appName"></p>
      <h1>Check</h1>
      <div class="label">The ten billing situations<span class="r" id="checkMeta"></span></div>
      <div class="group" id="scenarios"></div>
    </section>

    <section class="view" id="v-fix">
      <p class="app appName"></p>
      <h1>Fix</h1>
      <div class="label">What the fix wrote<span class="r" id="fixMeta"></span></div>
      <div class="group" id="files"></div>
      <p class="foot" id="fixProof"></p>
    </section>

    <section class="view" id="v-monitor">
      <p class="app appName"></p>
      <h1>Monitor</h1>
      <div class="label">Sweeps</div>
      <div class="group" id="sweeps"></div>
      <div class="label">Every account, last sweep</div>
      ${table("allAccounts")}
      <p class="foot" id="coverage"></p>
    </section>

    <section class="view" id="v-approvals">
      <p class="app appName"></p>
      <h1>Approvals</h1>
      <div class="label">Removals waiting for your yes</div>
      <div class="group" id="queue"></div>
      <p class="foot">Akeso never removes access on its own. Nothing above has happened.</p>
    </section>

    <section class="view" id="v-receipts">
      <p class="app appName"></p>
      <h1>Receipts</h1>
      <div class="label">Every change Akeso made</div>
      <div class="group" id="restores"></div>
    </section>

    <section class="view" id="v-ledger">
      <p class="app appName"></p>
      <h1>Ledger</h1>
      <div class="label">As written${hosted ? "" : escapeHtml(root ? `, ${root}/.akeso/ledger.jsonl` : ", .akeso/ledger.jsonl")}</div>
      <div class="group" id="entries"></div>
      <p class="foot">Append-only and hash-chained. The seal at the top recomputes every hash in this browser; an entry edited after the fact breaks it.</p>
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
