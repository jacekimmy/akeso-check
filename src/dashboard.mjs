/* The page: the one screen a founder lives in.
 *
 * One HTML file, no server, no account. The ledger is embedded (the local
 * `page` command) or loaded in the browser (the hosted copy). Nothing is
 * uploaded, so the privacy promise holds even for the hosted copy.
 *
 * It is one page, not a set of tabs, because the master doc allows exactly
 * one: status, what waits for a human, settings, receipts. A stranger on the
 * hosted copy sees step one (paste the command) and nothing else until they
 * load the ledger the command writes; then the page becomes their app's.
 * The demo sits behind a link and says so while it is showing.
 *
 * Every screen state opens with the same two things: a state mark and one
 * sentence. Detail lives behind disclosures. Every fact appears once.
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
  .wrap { max-width:720px; margin:0 auto; padding:0 24px; }
  [hidden] { display:none !important; }

  .nav { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter:saturate(180%) blur(20px); -webkit-backdrop-filter:saturate(180%) blur(20px); border-bottom:1px solid var(--line); }
  .nav .wrap { display:flex; align-items:center; gap:18px; height:48px; }
  .nav .brand { font-weight:600; letter-spacing:-.01em; }
  .nav .acts { margin-left:auto; display:flex; gap:14px; align-items:center; font-size:13px; white-space:nowrap; }
  .nav .acts button, .nav .acts label, .nav .acts a { color:var(--link); cursor:pointer; border:0; background:none; font:inherit; padding:0; }
  .nav .acts .status { color:var(--ink2); } .nav .acts .status.bad { color:var(--bad); }
  .nav .seal { font-size:12px; color:var(--ink2); white-space:nowrap; display:flex; align-items:center; gap:7px; }
  .nav .seal::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--ok); }
  .nav .seal.bad { color:var(--bad); } .nav .seal.bad::before { background:var(--bad); }
  .nav .seal.none::before { background:var(--ink3); }

  main { padding:34px 0 72px; }
  .app { margin:0; font-size:13px; color:var(--ink2); }
  .hero { display:flex; align-items:center; gap:18px; margin-top:10px; }
  .mark { width:56px; height:56px; border-radius:16px; flex:none; display:flex; align-items:center; justify-content:center; font-size:26px; font-weight:600; letter-spacing:-.02em; color:#fff; background:var(--ink3); }
  .mark.ok { background:var(--ok); } .mark.bad { background:var(--bad); } .mark.wait { background:var(--wait); }
  .mark svg { width:28px; height:28px; }
  h1 { margin:0; font-size:32px; line-height:1.15; font-weight:600; letter-spacing:-.022em; max-width:22ch; text-wrap:balance; }
  .lead { margin:12px 0 0; color:var(--ink2); max-width:56ch; }
  .cmd { display:flex; align-items:center; gap:10px; margin:18px 0 0; color:var(--ink2); flex-wrap:wrap; }
  .cmd code { color:var(--ink); }
  .cmd button, button.link { border:0; background:none; font:inherit; font-size:13px; color:var(--link); cursor:pointer; padding:6px 8px; margin:-6px -8px; border-radius:6px; }

  h2 { margin:38px 0 8px; padding:0 18px; font-size:13px; font-weight:400; color:var(--ink2); display:flex; gap:12px; align-items:baseline; }
  h2 .r { margin-left:auto; color:var(--ink3); font-size:12px; }
  .group { background:var(--group); border-radius:12px; overflow:hidden; margin-top:8px; }
  .group.first { margin-top:30px; }
  .row { display:flex; align-items:center; gap:14px; padding:12px 18px; min-height:46px; }
  .row + .row, details + .row, .row + details, details + details { border-top:1px solid var(--line); }
  .row .k { flex:1; min-width:0; }
  .row .sub { display:block; font-size:13px; color:var(--ink2); }
  .row .v { color:var(--ink2); text-align:right; white-space:nowrap; }
  .row .v .wait { color:var(--wait); } .row .v .big { font-size:17px; color:var(--ink); } .row .v .big.wait { color:var(--wait); }
  .row .chev { color:var(--ink3); font-size:18px; line-height:1; transition:transform .15s; }
  .row.empty { color:var(--ink2); }
  .row.cmdrow .k { overflow-wrap:anywhere; }
  .row .n { display:inline-flex; width:22px; height:22px; border-radius:50%; align-items:center; justify-content:center; background:var(--ink); color:var(--group); font-size:12px; font-weight:600; flex:none; }
  a.row:hover, a.row:focus-visible { background:color-mix(in srgb, var(--ink) 3%, var(--group)); outline-offset:-2px; }
  details summary { list-style:none; cursor:pointer; }
  details summary::-webkit-details-marker { display:none; }
  details[open] summary .chev { transform:rotate(90deg); }
  details .inner { border-top:1px solid var(--line); background:color-mix(in srgb, var(--ink) 2%, var(--group)); }
  details .inner .row { padding-left:18px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; background:transparent; border:1.5px solid var(--ink3); }
  .dot.ok { background:var(--ok); border-color:var(--ok); } .dot.bad { background:var(--bad); border-color:var(--bad); } .dot.wait { background:var(--wait); border-color:var(--wait); }

  .loop { display:grid; grid-template-columns:1fr 1fr 1fr; padding:20px 18px 18px; }
  .loop a { display:block; min-width:0; }
  .loop .m { display:flex; align-items:center; height:26px; margin-bottom:12px; }
  .loop .c { width:26px; height:26px; border-radius:50%; flex:none; border:2px solid var(--line); display:flex; align-items:center; justify-content:center; color:#fff; }
  .loop .c svg { width:14px; height:14px; }
  .loop .c.ok { background:var(--ok); border-color:var(--ok); } .loop .c.bad { background:var(--bad); border-color:var(--bad); } .loop .c.wait { background:var(--wait); border-color:var(--wait); }
  .loop .c.next { border-color:var(--ink); border-style:dashed; }
  .loop .l { flex:1; height:2px; background:var(--line); margin:0 8px; }
  .loop .l.ok { background:var(--ok); }
  .loop .name { font-weight:600; font-size:15px; }
  .loop .val { font-size:13px; color:var(--ink2); margin-top:1px; }
  .loop .val.ink { color:var(--ink); }
  .loop .val .sub { display:block; color:var(--ink2); }
  .loop a.todo .name { color:var(--ink2); font-weight:400; }

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

  .tabs { display:flex; gap:16px; font-size:13px; color:var(--ink2); padding:14px 18px 0; flex-wrap:wrap; }
  .tabs button { border:0; background:none; font:inherit; color:inherit; padding:0; cursor:pointer; }
  .tabs button[aria-selected="true"] { color:var(--ink); font-weight:600; }
  ol.steps { margin:0; padding:0 18px 14px 36px; color:var(--ink2); font-size:14px; }
  .seal2 { display:none; color:var(--ink3); } .seal2.bad { color:var(--bad); }

  @media (max-width:600px) {
    .wrap { padding:0 16px; }
    h1 { font-size:26px; }
    .mark { width:44px; height:44px; border-radius:13px; font-size:21px; } .mark svg { width:22px; height:22px; }
    .loop { padding:16px 14px 14px; } .loop .name { font-size:14px; } .loop .val { font-size:12px; }
    h2 { padding:0 14px; } .row { padding:12px 14px; }
    th:first-child, td:first-child { padding-left:14px; } th:last-child, td:last-child { padding-right:14px; }
    .hide-s, .nav .seal, h2 .r { display:none; }
    .nav .wrap { flex-wrap:wrap; height:auto; padding-top:10px; padding-bottom:10px; gap:8px 14px; }
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
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  var DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 12h10"/></svg>';
  function row(cls, dot, k, sub, v, href) {
    var inner = (dot ? '<span class="dot ' + dot + '" aria-hidden="true"></span>' : "") + '<span class="k">' + k + (sub ? '<span class="sub">' + sub + "</span>" : "") + "</span>" + (v != null ? '<span class="v">' + v + "</span>" : "") + (href ? '<span class="chev" aria-hidden="true">&rsaquo;</span>' : "");
    return href ? '<a class="row ' + cls + '" href="' + href + '">' + inner + "</a>" : '<div class="row ' + cls + '">' + inner + "</div>";
  }
  function disclosure(id, dot, k, sub, v, inner) {
    return '<details id="' + id + '"><summary class="row">' + (dot ? '<span class="dot ' + dot + '" aria-hidden="true"></span>' : "") + '<span class="k">' + k + (sub ? '<span class="sub">' + sub + "</span>" : "") + "</span>" + (v != null ? '<span class="v">' + v + "</span>" : "") + '<span class="chev" aria-hidden="true">&rsaquo;</span></summary><div class="inner">' + inner + "</div></details>";
  }
  function cmdRow(c) { return '<div class="row cmdrow"><span class="k"><code>' + esc(c) + '</code></span><button class="link" data-copy="' + esc(c) + '">Copy</button></div>'; }
  function empty(text) { return '<div class="row empty">' + esc(text) + "</div>"; }
  function hero(m, tone, text) { var mk = $("mark"); mk.className = "mark " + (tone || ""); mk.innerHTML = m; $("verdict").textContent = text; }

  function render() {
    var D = window.AKESO || {};
    var onboarding = !!D.onboarding;
    var st = $("start"); if (st) st.hidden = !onboarding; $("page").hidden = onboarding;
    var status = $("status"); if (status) { status.textContent = D.demo ? "Demo" : (D.fileName || ""); status.className = "status"; status.title = D.demo ? "A real run on a test app. Load your own ledger to replace it." : "Read in this tab. Never uploaded."; }
    var demoLink = $("demoLink"); if (demoLink) demoLink.hidden = !onboarding && !D.demo ? true : !!D.demo;
    var backLink = $("backLink"); if (backLink) backLink.hidden = onboarding;
    if (onboarding) { $("seal").textContent = "No ledger loaded"; $("seal").className = "seal none"; document.querySelectorAll(".appName").forEach(function (n) { n.textContent = "Your app"; }); document.title = "Akeso"; return; }

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
    var passed = scenarios.filter(function (r) { return r.outcome === "pass"; }).length;
    var notGraded = scenarios.length - passed - failed;

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

    function fixedSince(a) { var e = restoredFor[a.account]; return !!(e && sweep && Date.parse(e.at || "") >= Date.parse(sweep.at || "")); }
    var stillWrong = accounts.filter(function (a) { return (a.verdict === "locked_out" && !fixedSince(a)) || a.verdict === "still_entitled"; });
    var fixedNow = accounts.filter(function (a) { return a.verdict === "locked_out" && fixedSince(a); });
    var noVerdict = accounts.filter(function (a) { return a.verdict === "no_conclusion"; });
    var notInStripe = accounts.filter(function (a) { return a.verdict === "no_subscription"; });
    var agreeing = Math.max(0, matched - stillWrong.length - fixedNow.length);

    var states = {
      check: ranLive ? "done" : check ? "partial" : "todo",
      fix: provenFix ? "done" : (fix && !passing) ? "failed" : fix ? "partial" : (ranLive && !passing) ? "next" : (ranLive && passing) ? "notneeded" : "todo",
      monitor: (sweep && !sweep.couldNotRun && matched > 0) ? "done" : (sweep && !sweep.couldNotRun) ? "nothing" : sweep ? "failed" : (passing || provenFix) ? "next" : "todo"
    };
    var circle = {
      check: states.check === "done" ? (passing ? "ok" : grade === "?" ? "" : "bad") : states.check === "partial" ? "wait" : "",
      fix: states.fix === "done" ? "ok" : states.fix === "failed" ? "bad" : states.fix === "partial" ? "wait" : "",
      monitor: states.monitor === "done" ? (stillWrong.length ? "wait" : "ok") : states.monitor === "failed" ? "bad" : ""
    };

    /* ---- the next step: the same ladder as the terminal ---- */
    var step;
    if (!check) step = { h: "Not checked yet.", w: "", c: "npx akeso-check", m: DASH, tone: "" };
    else if (!ranLive) step = { h: "Code read. Not yet run.", w: "Only the live Check, where a pretend customer pays and cancels, produces a grade.", c: "npx akeso-check --lifecycle-url http://localhost:3000", m: DASH, tone: "" };
    else if (grade && grade !== "A" && grade !== "?") step = (fix && fix.seq > check.seq) ? { h: "Fix applied. Check still fails.", w: "A fix counts only when the Check passes afterwards.", c: "npx akeso-check fix --show", m: esc(grade), tone: "bad" } : { h: "Grade " + grade + ". " + failed + " of " + scenarios.length + " situations fail.", w: "Fix rewrites the webhook handler and the one file that touches your database, with backups.", c: "npx akeso-check fix", m: esc(grade), tone: "bad" };
    else if (grade === "?") step = { h: "The Check could not finish. No grade.", w: "The run failed, not your app. Start the app and run it again.", c: "npx akeso-check --lifecycle-url http://localhost:3000", m: "?", tone: "" };
    else if (sweep && sweep.couldNotRun) step = { h: "The last sweep could not run.", w: String(sweep.couldNotRun).replace(/\s+/g, " ").trim(), c: "npx akeso-check monitor", m: "?", tone: "" };
    else if (sweep && matched === 0) step = { h: "No account could be compared.", w: "Stripe and your app use different customer ids, so nothing lines up. Pass your account id to Stripe as client_reference_id at checkout, then sweep again.", c: "npx akeso-check monitor", m: "?", tone: "" };
    else if (sweep && waiting.length) step = { h: plural(waiting.length, "removal needs", "removals need") + " your approval.", w: "", c: "npx akeso-check approvals", m: String(waiting.length), tone: "wait" };
    else if (sweep) step = stillWrong.length === 0 ? { h: "Stripe and your app agree.", w: "Every paying customer has access, and nobody who stopped paying still has it.", c: "npx akeso-check statement", m: CHECK, tone: "ok" } : { h: plural(stillWrong.length, "account disagrees", "accounts disagree") + " with Stripe.", w: "", c: "npx akeso-check monitor", m: String(stillWrong.length), tone: "wait" };
    else step = { h: provenFix ? "The fix passed its re-test." : "Your billing code passes.", w: "Accounts that drifted before the fix are still wrong. Monitor compares them with Stripe.", c: "npx akeso-check monitor", m: esc(grade), tone: "ok" };

    /* ---- render ---- */
    var app = D.appName || "Your app";
    document.querySelectorAll(".appName").forEach(function (n) { n.textContent = app; });
    document.title = "Akeso · " + app;
    hero(step.m, step.tone, step.h);
    $("lead").textContent = step.w || ""; $("lead").hidden = !step.w;
    $("next").innerHTML = step.c ? '<code>' + esc(step.c) + '</code><button data-copy="' + esc(step.c) + '">Copy</button>' : ""; $("next").hidden = !step.c;

    /* the loop, with each step's detail behind it */
    var ICONS = { ok: CHECK, bad: CROSS, wait: DASH };
    function stepCell(id, name, state, val, ink, lastOne) {
      var tone = circle[id]; var icon = ICONS[tone] || (state === "notneeded" || state === "nothing" ? DASH : "");
      return '<a href="#d-' + id + '" data-open="d-' + id + '" class="' + (state === "todo" ? "todo" : "") + '"><div class="m"><span class="c ' + (tone || (state === "next" ? "next" : "")) + '" aria-hidden="true">' + icon + "</span>" + (lastOne ? "" : '<span class="l ' + (state === "done" || state === "notneeded" ? "ok" : "") + '"></span>') + '</div><div class="name">' + name + '</div><div class="val' + (ink ? " ink" : "") + '">' + val + "</div></a>";
    }
    var monVal = states.monitor === "done" ? (stillWrong.length ? plural(stillWrong.length, "disagrees", "disagree") : "All agree") : states.monitor === "failed" ? "Could not run" : states.monitor === "nothing" ? "Nothing to compare" : states.monitor === "next" ? "Next" : "Not yet";
    var monSub = states.monitor === "done" ? matched + " compared" + (fixedNow.length ? " · " + fixedNow.length + " restored" : "") : "";
    $("loop").innerHTML =
      stepCell("check", "Check", states.check, ranLive ? "Grade " + esc(grade || "?") : check ? "Read, not run" : "Not run", ranLive, false) +
      stepCell("fix", "Fix", states.fix, provenFix ? plural((fix.files || []).length, "file", "files") + " · re-test passed" : (fix && !passing) ? "Check still fails" : fix ? "Not re-tested" : states.fix === "notneeded" ? "Not needed" : states.fix === "next" ? "Next" : "Not yet", provenFix, false) +
      stepCell("monitor", "Monitor", states.monitor, monVal + (monSub ? '<span class="sub">' + monSub + "</span>" : ""), states.monitor === "done", true);

    var scenarioRows = scenarios.length ? scenarios.map(function (r) { var o = r.outcome; return row("", o === "pass" ? "ok" : o === "fail" ? "bad" : "", esc(NAMES[r.id] || r.id), null, o === "pass" ? "Passed" : o === "fail" ? "Failed" : o === "reported" ? "Not graded" : cap(o)); }).join("") : empty(check ? "Read, not run." : "Not run yet.");
    var fileRows = fix ? (fix.files || []).map(function (f) { return row("", null, '<span class="code">' + esc(f.path || "") + "</span>", null, cap(f.action || "")); }).join("") : empty(states.fix === "notneeded" ? "Nothing needed fixing." : "No fix written yet.");
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
    function accountRow(a) { var price = money(a.priceMonthly); return '<tr><td><span class="dot ' + dotFor(a) + '" aria-hidden="true"></span><span class="code">' + esc(a.account) + '</span><span class="sub">Stripe: ' + esc(stripeWord(a)) + " · App: " + esc(appWord(a)) + (price ? " · " + price + "/mo" : "") + "<br>" + esc(meaning(a)) + '</span></td><td class="hide-s">' + esc(stripeWord(a)) + '</td><td class="hide-s">' + esc(appWord(a)) + '</td><td class="mute hide-s">' + esc(meaning(a)) + '</td><td class="num hide-s">' + esc(price) + "</td></tr>"; }
    var shown = stillWrong.concat(fixedNow, noVerdict, notInStripe);
    var accountRows = shown.map(accountRow).join("");
    if (sweep && matched > 0 && agreeing > 0) accountRows += '<tr><td colspan="5" class="mute">' + agreeing + " agree</td></tr>";
    var table = '<table><thead><tr><th>Account</th><th class="hide-s">Stripe says</th><th class="hide-s">App says</th><th class="hide-s">Meaning</th><th class="num hide-s">Monthly</th></tr></thead><tbody>' + (accountRows || '<tr><td colspan="5" class="mute">' + (sweep ? "Nothing to compare on the last sweep." : "No sweep has run yet.") + "</td></tr>") + "</tbody></table>";
    var sw = kinds("sweep");
    var sweepRows = sw.length ? sw.slice().reverse().map(function (e) { var c = e.comparison || {}; return row("", e.couldNotRun ? "bad" : c.comparable === false ? "" : c.clean ? "ok" : "wait", esc(when(e.at)), null, e.couldNotRun ? "Could not run" : c.comparable === false ? "Nothing to compare" : (c.counts ? c.counts.matched + " compared · " : "") + (c.clean ? "all agree" : money(Number(c.monthlyExposure) || 0) + "/mo unpaid")); }).join("") : empty("No sweep has run yet.");

    $("details").innerHTML =
      disclosure("d-check", circle.check, "Ten situations", ranLive ? "Grade " + esc(grade) + (passing ? " · " + passed + " passed" + (notGraded ? ", " + notGraded + " not graded" : "") : " · " + failed + " fail") : (check ? "Read, not run" : "Not run"), check ? esc(when(check.at)) : "", scenarioRows) +
      disclosure("d-fix", circle.fix, "Files written", provenFix ? "Re-test passed" : (fix && !passing) ? "Re-test failed. Not counted as fixed." : fix ? "Not yet re-tested" : states.fix === "notneeded" ? "Nothing needed fixing" : "No fix yet", fix ? esc(when(fix.at)) : "", fileRows) +
      disclosure("d-monitor", circle.monitor, "Accounts, last sweep", sweep ? (matched + " compared" + (stillWrong.length ? " · " + plural(stillWrong.length, "disagrees", "disagree") : "")) : "No sweep yet", sweep ? esc(when(sweep.at)) : "", table + sweepRows);

    /* waiting for approval */
    function approvalRows(r) {
      return row("", r.ready ? "wait" : "", '<span class="code">' + esc(r.account) + "</span>", esc(r.reason || "") + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + "/mo" : ""), r.ready ? '<span class="wait">Ready to approve</span>' : "Held until " + esc(when(r.readyAt))) +
        cmdRow("npx akeso-check approvals --approve " + r.id);
    }
    $("inbox").innerHTML = waiting.length ? waiting.map(approvalRows).join("") : empty("No removals waiting.");

    /* settings: what is connected and under which rules */
    var fw = check && (check.framework || (check.detection && check.detection.framework));
    $("settings").innerHTML =
      row("", check ? "ok" : "", "Your app", fw ? esc(cap(String(fw).replace(/-/g, " "))) : null, check ? "Read" : "Not read") +
      row("", sweep && !sweep.couldNotRun ? "ok" : sweep ? "bad" : "", "Stripe", sweep ? (sweep.couldNotRun ? "Last sweep could not reach it" : "Read-only, from your project's env") : "Read-only key from your project's env", sweep && !sweep.couldNotRun ? "Connected" : sweep ? "Failed" : "Not yet") +
      row("", covered ? "ok" : "", "Access rules", covered ? "Version " + esc((cert.policy && cert.policy.ruleVersion) || "1") + " · confirmed " + esc(when(cert.at)) : "Confirm with: npx akeso-check certify", covered ? "Confirmed" : "Not yet") +
      row("", "ok", "Restore mode", "Grants are automatic. Removals wait for your approval.", "Safe");

    /* receipts */
    $("totals").innerHTML =
      row("", null, "Access restored", unconfirmed.length ? unconfirmed.length + " not yet confirmed" : null, '<span class="big">' + restored.length + "</span>") +
      row("", null, "Access removed", null, '<span class="big">' + removed.length + "</span>") +
      row("", null, "Unpaid access", null, lastGood ? '<span class="big' + ((Number(lastGood.comparison.monthlyExposure) || 0) > 0 ? " wait" : "") + '">' + money(Number(lastGood.comparison.monthlyExposure) || 0) + "/mo</span>" : "No sweep yet") +
      row("", null, "Revenue recovered", "Akeso does not see your payouts", "Not measured");
    var restoreRows = restores.length ? restores.slice().reverse().map(function (e) {
      var ok = e.result === "applied";
      var word = e.direction === "grant" ? (ok ? "Restored" : "Restore failed") : (ok ? "Removed" : "Removal failed");
      return row("", ok && e.verified ? "ok" : ok ? "wait" : "bad", '<span class="code">' + esc(e.account) + "</span>", esc(when(e.at)), esc(word) + (ok ? (e.verified ? " · confirmed" : " · not confirmed") : ""));
    }).join("") : empty("No changes yet.");
    var entryRows = L.length ? L.slice().reverse().map(function (e) {
      var sum = e.kind === "check" ? (e.grade ? "Grade " + e.grade : "Code read") : e.kind === "fix" ? plural((e.files || []).length, "file written", "files written") : e.kind === "sweep" ? (e.couldNotRun ? "Could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? (e.direction === "grant" ? "Restored " : "Removed ") + (e.account || "") + (e.result === "applied" ? "" : " · " + e.result) : e.kind === "approval" ? "Removal " + (e.state === "cancelled" ? "canceled" : e.state || "") + " " + (e.account || "") : e.kind === "certify" ? "Access rules confirmed" : e.kind === "unreadable" ? "Unreadable line" : "";
      return row("", null, '<span class="code">' + esc(e.seq || "") + "</span>&nbsp;&nbsp;" + esc(e.kind === "unreadable" ? "Line " + e.line : cap(e.kind)), esc(sum), esc(when(e.at)));
    }).join("") : empty("The ledger is empty.");
    $("history").innerHTML =
      disclosure("d-changes", null, "Changes made", plural(restores.length, "restore", "restores"), null, restoreRows) +
      disclosure("d-ledger", null, "Ledger", plural(L.length, "entry", "entries") + (D.root ? " · " + esc(D.root) + "/.akeso/ledger.jsonl" : ""), '<span id="sealWord"></span>', entryRows + '<p class="foot" style="margin:14px 18px 14px">Each entry is hashed with the one before it. This page recomputes every hash; an edited entry shows as not verified.</p>');

    /* chain */
    var seal = $("seal"); seal.className = "seal none"; seal.textContent = L.length ? "Verifying" : "No ledger";
    function setSeal(text, bad, none) { seal.textContent = text; seal.className = "seal" + (bad ? " bad" : none ? " none" : ""); document.querySelectorAll(".seal2").forEach(function (s2) { s2.textContent = " · " + text; s2.className = "seal2" + (bad ? " bad" : ""); }); var w = $("sealWord"); if (w) { w.textContent = bad ? "Not verified" : none ? "Not verified" : "Verified"; w.style.color = bad ? "var(--bad)" : ""; } }
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
        setSeal(broken ? "Entry " + broken + " does not verify" : plural(L.length, "entry", "entries") + " · verified", !!broken);
      })();
    } else if (L.length) { setSeal(plural(L.length, "entry", "entries") + " · not verified", false, true); }
  }

  /* things that live on the document, so they survive a re-render */
  function loadRows(text) {
    var n = 0;
    return text.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { n++; try { var o = JSON.parse(l); return (o && typeof o === "object") ? o : { kind: "unreadable", line: n }; } catch (x) { return { kind: "unreadable", line: n }; } });
  }
  document.addEventListener("change", function (e) {
    if (e.target.id !== "ledgerFile") return;
    var f = e.target.files[0]; if (!f) return;
    f.text().then(function (t) {
      var rows = loadRows(t); var D = window.AKESO || {};
      if (!rows.some(function (r) { return r.kind !== "unreadable" && r.hash; })) { var st = $("status"); if (st) { st.textContent = "Not an Akeso ledger"; st.className = "status bad"; st.title = "No entry in that file carries a hash."; } return; }
      var named = rows.find(function (r) { return r.appName || r.app; });
      window.AKESO = Object.assign({}, D, { ledger: rows, appName: (named && (named.appName || named.app)) || "Your app", demo: false, onboarding: false, fileName: f.name, root: null });
      render(); window.scrollTo(0, 0);
    });
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (b) {
      var done = function (t) { b.textContent = t; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(function () { done("Copied"); }, function () { done("Select and copy"); });
      else done("Select and copy");
      return;
    }
    var o = e.target.closest("[data-open]");
    if (o) { var d = $(o.dataset.open); if (d) { d.open = true; } return; }
    if (e.target.id === "demoLink") { e.preventDefault(); var D = window.AKESO || {}; window.AKESO = Object.assign({}, D, { ledger: D.demoLedger || [], appName: D.demoName || "Demo app", demo: true, onboarding: false, fileName: "" }); render(); window.scrollTo(0, 0); return; }
    if (e.target.id === "backLink") { e.preventDefault(); var D2 = window.AKESO || {}; window.AKESO = Object.assign({}, D2, { ledger: [], demo: false, onboarding: true, fileName: "" }); render(); window.scrollTo(0, 0); return; }
    var t = e.target.closest("[data-tool]");
    if (t) {
      var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English.";
      var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } };
      document.querySelectorAll("[data-tool]").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
      $("cmd").textContent = T[t.dataset.tool].paste; $("cmdCopy").dataset.copy = T[t.dataset.tool].paste; $("steps").hidden = !T[t.dataset.tool].steps;
    }
  });
  render();
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  /* On the hosted copy a demo ledger starts hidden behind a link; the first
     thing a stranger sees is step one. The local page always has its ledger. */
  const data = JSON.stringify(hosted && demo
    ? { ledger: [], demoLedger: ledger, demoName: appName, appName: "Your app", onboarding: true, demo: false, hosted: true, scenarioNames: SCENARIO_NAMES }
    : { ledger, appName, root, onboarding: false, demo: false, hosted, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");

  const acts = hosted
    ? `<span class="acts"><span class="status" id="status"></span><a href="#" id="backLink" hidden>Start over</a><a href="#" id="demoLink">See a demo</a><label title="Read in this tab. Never uploaded.">Load your ledger<input type="file" id="ledgerFile" class="sr" accept=".jsonl,application/json,text/plain"></label></span>`
    : `<span class="acts"></span>`;

  const start = hosted ? `
    <section id="start" hidden>
      <p class="app">Your app</p>
      <div class="hero"><div class="mark" aria-hidden="true">1</div><h1>Start with one command.</h1></div>
      <p class="lead">It reads your project, runs a pretend customer through ten billing situations, and grades what it finds. Nothing leaves your machine.</p>
      <div class="group first">
        <div class="tabs" id="tabs" role="tablist"><button role="tab" aria-selected="true" data-tool="terminal">Terminal</button><button role="tab" aria-selected="false" data-tool="claude">Claude Code</button><button role="tab" aria-selected="false" data-tool="cursor">Cursor</button><button role="tab" aria-selected="false" data-tool="codex">Codex</button><button role="tab" aria-selected="false" data-tool="lovable">Lovable / Bolt / v0</button></div>
        <ol class="steps" id="steps" hidden>
          <li>Open your project in your builder.</li><li>Click GitHub (top right) and follow its steps to put your project on GitHub.</li><li>Go to github.com and open your new repository.</li><li>Click the green Code button.</li><li>Click Codespaces, then Create codespace on main.</li><li>A code editor opens in a new tab. Wait for it to load.</li><li>If a box asks Do you trust the authors, click Trust Folder and Continue.</li><li>Click the terminal panel at the bottom, paste this, press Enter:</li>
        </ol>
        <div class="row"><span class="n" aria-hidden="true">1</span><span class="k">Paste this in your project's terminal<span class="sub">Free. No dependencies. Plain JavaScript you can read: <a href="https://github.com/jacekimmy/akeso-check" style="color:var(--link)">github.com/jacekimmy/akeso-check</a></span></span></div>
        <div class="row cmdrow"><span class="k"><code id="cmd">npx akeso-check</code></span><button class="link" id="cmdCopy" data-copy="npx akeso-check">Copy</button></div>
        <div class="row"><span class="n" aria-hidden="true">2</span><span class="k">Load the ledger it writes<span class="sub">.akeso/ledger.jsonl in your project. Read in this tab, never uploaded.</span></span><label class="v" style="color:var(--link);cursor:pointer" title="Read in this tab. Never uploaded.">Load your ledger<input type="file" class="sr" id="ledgerFile2" onchange="document.getElementById('ledgerFile').files=this.files;document.getElementById('ledgerFile').dispatchEvent(new Event('change',{bubbles:true}))"></label></div>
        <div class="row"><span class="n" aria-hidden="true">3</span><span class="k">This page becomes your app's<span class="sub">The grade, the fix, what is waiting for you, and the receipts. Every later command adds to it.</span></span></div>
      </div>
    </section>` : "";

  const shell = `<header class="nav"><div class="wrap">
    <span class="brand">Akeso</span>
    ${acts}
    <span class="seal" id="seal" aria-live="polite"></span>
  </div></header>
  <main class="wrap">
    ${start}
    <section id="page">
      <p class="app"><span class="appName"></span><span class="seal2"></span></p>
      <div class="hero"><div class="mark" id="mark" aria-hidden="true"></div><h1 id="verdict"></h1></div>
      <p class="lead" id="lead"></p>
      <div class="cmd" id="next"></div>

      <div class="group first loop" id="loop"></div>
      <div class="group" id="details"></div>

      <h2>Waiting for your approval</h2>
      <div class="group" id="inbox"></div>

      <h2>Settings</h2>
      <div class="group" id="settings"></div>

      <h2>Receipts</h2>
      <div class="group" id="totals"></div>
      <div class="group" id="history"></div>

      <p class="foot">Akeso restores access on its own. It never removes access on its own.</p>
    </section>
  </main>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
<style>${CSS}</style>
</head><body>
${shell}
<script>window.AKESO = ${data};</script>
<script>${JS}</script>
</body></html>`;
}
