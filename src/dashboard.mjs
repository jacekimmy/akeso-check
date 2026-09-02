/* The page: the one screen a founder lives in.
 *
 * One HTML file, no server, no account. The ledger is embedded (the local
 * `page` command) or loaded in the browser (the hosted copy). Nothing is
 * uploaded, so the privacy promise holds even for the hosted copy.
 *
 * Design: wide and unhurried, one warm surface, one calm accent, and every
 * visual element drawn from the data so it means something. The ring beside
 * the verdict is the state. The ten situations are ten tiles. The accounts
 * are a strip of dots, one per account, coloured by whether Stripe and the
 * app agree. The receipts are three large numbers. The boundary diagram
 * shows what Akeso can and cannot touch, which is the feeling of control the
 * page exists to give. The ledger is a timeline with a seal.
 *
 * A stranger on the hosted copy sees step one (paste the command) and
 * nothing else until they load the ledger the command writes. The demo sits
 * behind a link and says so while it is showing.
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
    --bg:#f6f5f1; --card:#ffffff; --ink:#17191d; --ink2:#5d636c; --ink3:#8a9099; --line:#e6e4dd; --tint:#eef4f1;
    --ok:#1e9a6a; --okSoft:#d7f0e4; --bad:#e5484d; --badSoft:#fbdcdd; --wait:#e0961a; --waitSoft:#fbecd0; --none:#c9cdd3; --link:#2f6fed;
    --shadow:0 1px 2px rgba(20,24,30,.04), 0 14px 40px -18px rgba(20,24,30,.14);
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0f1114; --card:#181b20; --ink:#f2f2ee; --ink2:#a4a9b1; --ink3:#6f757e; --line:#272b31; --tint:#182420;
    --ok:#3ccf8e; --okSoft:#123b2c; --bad:#ff6b6f; --badSoft:#4a1e21; --wait:#f0b13c; --waitSoft:#4a3413; --none:#3a3f47; --link:#6ea0ff;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 14px 40px -18px rgba(0,0,0,.6);
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  code, .code { font-family:ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; font-size:.92em; }
  :focus-visible { outline:2px solid var(--link); outline-offset:3px; border-radius:8px; }
  ::selection { background:color-mix(in srgb, var(--link) 22%, transparent); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  [hidden] { display:none !important; }
  .wrap { max-width:1120px; margin:0 auto; padding:0 40px; }
  button.link, a.link, label.link { border:0; background:none; font:inherit; color:var(--link); cursor:pointer; padding:0; font-weight:500; }

  .nav { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 84%, transparent); backdrop-filter:saturate(180%) blur(18px); -webkit-backdrop-filter:saturate(180%) blur(18px); }
  .nav .wrap { display:flex; align-items:center; gap:22px; height:64px; }
  .nav .brand { font-weight:700; letter-spacing:-.02em; font-size:17px; display:flex; align-items:center; gap:10px; }
  .nav .brand i { width:12px; height:12px; border-radius:50%; background:var(--ok); display:inline-block; }
  .nav .acts { margin-left:auto; display:flex; gap:22px; align-items:center; font-size:14px; white-space:nowrap; }
  .nav .acts .status { color:var(--ink2); } .nav .acts .status.bad { color:var(--bad); }
  .seal { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--ink2); padding:6px 12px 6px 8px; border-radius:999px; background:var(--card); box-shadow:var(--shadow); }
  .seal::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--ok); }
  .seal.bad { color:var(--bad); } .seal.bad::before { background:var(--bad); }
  .seal.none::before { background:var(--none); }

  main { padding:56px 0 120px; }
  section + section { margin-top:88px; }
  .eyebrow { margin:0 0 14px; font-size:14px; color:var(--ink2); letter-spacing:.01em; }
  .hero { display:grid; grid-template-columns:1fr 220px; gap:56px; align-items:center; }
  h1 { margin:0; font-size:48px; line-height:1.08; font-weight:700; letter-spacing:-.03em; max-width:18ch; text-wrap:balance; }
  .lead { margin:18px 0 0; color:var(--ink2); font-size:18px; max-width:52ch; line-height:1.5; }
  .cmd { display:inline-flex; align-items:center; gap:16px; margin:28px 0 0; padding:14px 18px; border-radius:14px; background:var(--card); box-shadow:var(--shadow); font-size:15px; }
  .cmd code { font-size:15px; }
  .cmd code::before { content:"$ "; color:var(--ink3); }
  .ring { position:relative; width:220px; height:220px; }
  .ring svg { width:100%; height:100%; transform:rotate(-90deg); }
  .ring circle { fill:none; stroke-width:12; stroke-linecap:round; }
  .ring .track { stroke:var(--line); }
  .ring .arc { stroke:var(--none); stroke-dasharray:var(--arc, 0) 1000; transition:stroke-dasharray .6s ease; }
  .ring.ok .arc { stroke:var(--ok); } .ring.bad .arc { stroke:var(--bad); } .ring.wait .arc { stroke:var(--wait); }
  .ring .center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:64px; font-weight:700; letter-spacing:-.04em; line-height:1; }
  .ring .center svg { width:64px; height:64px; transform:none; }
  .ring .center small { font-size:13px; font-weight:500; color:var(--ink2); letter-spacing:0; margin-top:8px; }
  .ring.ok .center { color:var(--ok); } .ring.bad .center { color:var(--bad); } .ring.wait .center { color:var(--wait); } .ring.none .center { color:var(--ink3); }

  h2 { margin:0 0 22px; font-size:15px; font-weight:600; color:var(--ink2); letter-spacing:.01em; display:flex; align-items:baseline; gap:14px; }
  h2 .r { margin-left:auto; font-weight:400; font-size:13px; color:var(--ink3); }
  .card { background:var(--card); border-radius:22px; box-shadow:var(--shadow); padding:28px; }

  /* the loop: three cards joined by a line */
  .loop { display:grid; grid-template-columns:1fr 1fr 1fr; gap:24px; position:relative; }
  .loop::before { content:""; position:absolute; left:8%; right:8%; top:52px; height:2px; background:var(--line); z-index:0; }
  .loop .step { position:relative; z-index:1; display:flex; flex-direction:column; gap:18px; min-height:250px; }
  .step .head { display:flex; align-items:center; gap:12px; }
  .step .node { width:48px; height:48px; border-radius:50%; background:var(--card); border:2px solid var(--line); display:flex; align-items:center; justify-content:center; color:#fff; flex:none; }
  .step .node svg { width:22px; height:22px; }
  .step .node.ok { background:var(--ok); border-color:var(--ok); } .step .node.bad { background:var(--bad); border-color:var(--bad); } .step .node.wait { background:var(--wait); border-color:var(--wait); }
  .step .node.next { border-color:var(--ink); border-style:dashed; color:var(--ink); }
  .step .title { font-size:22px; font-weight:700; letter-spacing:-.02em; }
  .step .state { font-size:14px; color:var(--ink2); }
  .step .vis { flex:1; display:flex; align-items:center; min-height:64px; }
  .step .more { font-size:14px; color:var(--link); font-weight:500; cursor:pointer; list-style:none; }
  .step .more::-webkit-details-marker { display:none; }
  .step details[open] .more { color:var(--ink2); }
  .tiles { display:grid; grid-template-columns:repeat(5, 30px); gap:8px; }
  .tile { width:30px; height:30px; border-radius:8px; background:var(--none); }
  .tile.ok { background:var(--ok); } .tile.bad { background:var(--bad); } .tile.none { background:var(--none); }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { font-family:ui-monospace, "SF Mono", Menlo, monospace; font-size:12px; padding:6px 10px; border-radius:8px; background:var(--tint); color:var(--ink); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip.replaced { background:var(--waitSoft); } .chip.created { background:var(--okSoft); }
  .dots { display:flex; flex-wrap:wrap; gap:6px; align-content:flex-start; }
  .dots i { width:12px; height:12px; border-radius:50%; background:var(--ok); display:block; }
  .dots i.bad { background:var(--bad); } .dots i.wait { background:var(--wait); } .dots i.none { background:var(--none); } .dots i.more { width:auto; height:auto; border-radius:0; background:none; font-style:normal; font-size:12px; color:var(--ink2); line-height:12px; }
  .legend { display:flex; gap:16px; flex-wrap:wrap; font-size:13px; color:var(--ink2); margin-top:4px; }
  .legend i { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:6px; background:var(--ok); }
  .legend i.bad { background:var(--bad); } .legend i.wait { background:var(--wait); } .legend i.none { background:var(--none); }
  .list { margin:12px 0 0; padding:0; list-style:none; font-size:14px; }
  .list li { display:flex; gap:12px; padding:9px 0; border-top:1px solid var(--line); align-items:baseline; }
  .list li span:first-child { flex:1; }
  .list li b { font-weight:500; color:var(--ink2); }
  .list li.ok b { color:var(--ok); } .list li.bad b { color:var(--bad); }

  /* two sides */
  .sides { display:grid; grid-template-columns:1.2fr 1fr; gap:24px; align-items:start; }
  .compare { display:grid; grid-template-columns:1fr 32px 1fr; gap:10px 14px; align-items:center; }
  .compare .side { padding:14px 16px; border-radius:14px; background:var(--tint); }
  .compare .side.bad { background:var(--badSoft); } .compare .side.wait { background:var(--waitSoft); } .compare .side.ok { background:var(--okSoft); }
  .compare .side small { display:block; font-size:12px; color:var(--ink2); margin-bottom:2px; }
  .compare .side b { font-weight:600; }
  .compare .tie { text-align:center; font-size:20px; color:var(--ink2); }
  .compare .tie.bad { color:var(--bad); } .compare .tie.wait { color:var(--wait); } .compare .tie.ok { color:var(--ok); }
  .compare .who { grid-column:1 / -1; display:flex; justify-content:space-between; align-items:baseline; margin-top:10px; font-size:14px; color:var(--ink2); }
  .compare .who:first-child { margin-top:0; }
  .compare .who .code { color:var(--ink); font-size:14px; }
  .approval { border-left:0; }
  .approval .big { font-size:28px; font-weight:700; letter-spacing:-.02em; margin:0 0 6px; }
  .approval .big.wait { color:var(--wait); }
  .approval .why { color:var(--ink2); font-size:15px; margin:0 0 18px; }
  .approval .cmd { margin:0; width:100%; justify-content:space-between; }
  .approval + .approval { margin-top:16px; }
  .quiet { color:var(--ink2); font-size:15px; }

  /* receipts */
  .figures { display:grid; grid-template-columns:repeat(3, 1fr); gap:24px; }
  .figure .n { font-size:56px; font-weight:700; letter-spacing:-.04em; line-height:1; }
  .figure .n.wait { color:var(--wait); } .figure .n.ok { color:var(--ok); }
  .figure .l { margin-top:10px; font-size:15px; color:var(--ink2); }
  .figure .s { margin-top:4px; font-size:13px; color:var(--ink3); }
  .note { margin:18px 0 0; font-size:14px; color:var(--ink3); }

  /* the boundary */
  .bound { display:grid; grid-template-columns:repeat(3, 1fr); gap:24px; }
  .bound .z { display:flex; flex-direction:column; gap:14px; }
  .bound .glyph { width:44px; height:44px; border-radius:12px; background:var(--tint); display:flex; align-items:center; justify-content:center; color:var(--ink); }
  .bound .glyph svg { width:22px; height:22px; }
  .bound .t { font-size:18px; font-weight:700; letter-spacing:-.01em; }
  .bound .d { font-size:14px; color:var(--ink2); line-height:1.5; }
  .bound .s { font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .bound .s i { width:9px; height:9px; border-radius:50%; background:var(--none); display:inline-block; }
  .bound .s i.ok { background:var(--ok); } .bound .s i.bad { background:var(--bad); } .bound .s i.wait { background:var(--wait); }

  /* the ledger */
  .timeline { position:relative; padding-left:28px; }
  .timeline::before { content:""; position:absolute; left:8px; top:10px; bottom:10px; width:2px; background:var(--line); }
  .entry { position:relative; display:flex; gap:16px; align-items:baseline; padding:10px 0; font-size:15px; }
  .entry::before { content:""; position:absolute; left:-25px; top:18px; width:12px; height:12px; border-radius:50%; background:var(--card); border:2px solid var(--ink3); }
  .entry.ok::before { border-color:var(--ok); background:var(--ok); } .entry.bad::before { border-color:var(--bad); background:var(--bad); } .entry.wait::before { border-color:var(--wait); background:var(--wait); }
  .entry .k { flex:1; }
  .entry .k b { font-weight:600; margin-right:8px; }
  .entry .k span { color:var(--ink2); }
  .entry .t { color:var(--ink3); font-size:13px; white-space:nowrap; }
  .entry.unread .k b { color:var(--bad); }
  .foot { margin:28px 0 0; font-size:14px; color:var(--ink3); max-width:60ch; }
  .doctrine { margin-top:88px; text-align:center; color:var(--ink2); font-size:15px; }

  /* onboarding */
  .steps3 { display:grid; grid-template-columns:repeat(3, 1fr); gap:24px; margin-top:48px; }
  .steps3 .card { display:flex; flex-direction:column; gap:14px; min-height:240px; }
  .steps3 .num { width:36px; height:36px; border-radius:50%; background:var(--ink); color:var(--card); display:flex; align-items:center; justify-content:center; font-weight:700; }
  .steps3 .t { font-size:20px; font-weight:700; letter-spacing:-.02em; }
  .steps3 .d { font-size:15px; color:var(--ink2); line-height:1.5; }
  .steps3 .fill { flex:1; }
  .tabs { display:flex; gap:14px; font-size:13px; color:var(--ink2); flex-wrap:wrap; }
  .tabs button { border:0; background:none; font:inherit; color:inherit; padding:0; cursor:pointer; }
  .tabs button[aria-selected="true"] { color:var(--ink); font-weight:600; }
  ol.how { margin:0; padding-left:20px; font-size:14px; color:var(--ink2); }
  .steps3 .cmd { margin:0; width:100%; justify-content:space-between; }

  @media (max-width:900px) {
    .wrap { padding:0 20px; }
    main { padding:28px 0 80px; } section + section { margin-top:56px; }
    .hero { grid-template-columns:1fr; gap:28px; } .ring { width:150px; height:150px; } .ring .center { font-size:44px; } .ring .center svg { width:44px; height:44px; }
    h1 { font-size:32px; } .lead { font-size:16px; }
    .loop { grid-template-columns:1fr; } .loop::before { display:none; } .loop .step { min-height:0; }
    .sides, .figures, .bound, .steps3 { grid-template-columns:1fr; }
    .figure .n { font-size:44px; }
    .nav .acts { gap:14px; font-size:13px; }
    h2 .r { display:none; }
    .nav .wrap { flex-wrap:wrap; height:auto; padding-top:12px; padding-bottom:12px; gap:10px 16px; }
  }
`;

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
  function cmd(c) { return '<div class="cmd"><code>' + esc(c) + '</code><button class="link" data-copy="' + esc(c) + '">Copy</button></div>'; }

  function render() {
    var D = window.AKESO || {};
    var onboarding = !!D.onboarding;
    var st = $("start"); if (st) st.hidden = !onboarding; $("page").hidden = onboarding;
    var status = $("status"); if (status) { status.textContent = D.demo ? "Demo" : (D.fileName || ""); status.className = "status"; status.title = D.demo ? "A real run on a test app. Load your own ledger to replace it." : "Read in this tab. Never uploaded."; }
    var demoLink = $("demoLink"); if (demoLink) demoLink.hidden = !onboarding;
    var backLink = $("backLink"); if (backLink) backLink.hidden = onboarding;
    if (onboarding) { $("seal").textContent = "No ledger loaded"; $("seal").className = "seal none"; document.title = "Akeso"; return; }

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
    var tone = {
      check: states.check === "done" ? (passing ? "ok" : grade === "?" ? "" : "bad") : states.check === "partial" ? "wait" : "",
      fix: states.fix === "done" ? "ok" : states.fix === "failed" ? "bad" : states.fix === "partial" ? "wait" : "",
      monitor: states.monitor === "done" ? (stillWrong.length ? "wait" : "ok") : states.monitor === "failed" ? "bad" : ""
    };

    /* ---- the next step, the same ladder as the terminal ---- */
    var step;
    if (!check) step = { h: "Not checked yet.", w: "", c: "npx akeso-check", m: DASH, tone: "", arc: 0, sub: "not run" };
    else if (!ranLive) step = { h: "Code read. Not yet run.", w: "Run it against your running app to get a grade.", c: "npx akeso-check --lifecycle-url http://localhost:3000", m: DASH, tone: "", arc: 0.15, sub: "read only" };
    else if (grade && grade !== "A" && grade !== "?") step = (fix && fix.seq > check.seq) ? { h: "Fix applied. The Check still fails.", w: "", c: "npx akeso-check fix --show", m: esc(grade), tone: "bad", arc: passed / Math.max(1, scenarios.length), sub: failed + " of " + scenarios.length + " fail" } : { h: "Grade " + grade + ". " + failed + " of " + scenarios.length + " situations fail.", w: "", c: "npx akeso-check fix", m: esc(grade), tone: "bad", arc: passed / Math.max(1, scenarios.length), sub: failed + " of " + scenarios.length + " fail" };
    else if (grade === "?") step = { h: "The Check could not finish. No grade.", w: "Start the app and run it again.", c: "npx akeso-check --lifecycle-url http://localhost:3000", m: "?", tone: "", arc: 0, sub: "no grade" };
    else if (sweep && sweep.couldNotRun) step = { h: "The last sweep could not run.", w: String(sweep.couldNotRun).replace(/\s+/g, " ").slice(0, 160), c: "npx akeso-check monitor", m: "?", tone: "", arc: 0, sub: "no verdict" };
    else if (sweep && matched === 0) step = { h: "No account could be compared.", w: "Stripe and your app use different customer ids. Pass your account id as client_reference_id at checkout.", c: "npx akeso-check monitor", m: "?", tone: "", arc: 0, sub: "0 compared" };
    else if (sweep && waiting.length) step = { h: plural(waiting.length, "removal needs", "removals need") + " your approval.", w: "", c: "npx akeso-check approvals", m: String(waiting.length), tone: "wait", arc: 1, sub: "waiting" };
    else if (sweep) step = stillWrong.length === 0 ? { h: "Stripe and your app agree.", w: "", c: "npx akeso-check statement", m: CHECK, tone: "ok", arc: 1, sub: matched + " agree" } : { h: plural(stillWrong.length, "account disagrees", "accounts disagree") + " with Stripe.", w: "", c: "npx akeso-check monitor", m: String(stillWrong.length), tone: "wait", arc: agreeing / Math.max(1, matched), sub: "of " + matched };
    else step = { h: provenFix ? "The fix passed its re-test." : "Your billing code passes.", w: "Now compare today's customers with Stripe.", c: "npx akeso-check monitor", m: esc(grade), tone: "ok", arc: 1, sub: "grade" };

    /* ---- render ---- */
    var app = D.appName || "Your app";
    document.querySelectorAll(".appName").forEach(function (n) { n.textContent = app; });
    document.title = "Akeso · " + app;
    $("verdict").textContent = step.h;
    $("lead").textContent = step.w || ""; $("lead").hidden = !step.w;
    $("next").innerHTML = step.c ? cmd(step.c) : ""; $("next").hidden = !step.c;
    var ring = $("ring"); ring.className = "ring " + (step.tone || "none"); ring.style.setProperty("--arc", String(Math.round(step.arc * 471)));
    $("ringCenter").innerHTML = step.m + (step.sub ? "<small>" + esc(step.sub) + "</small>" : "");

    /* ---- the loop ---- */
    var ICONS = { ok: CHECK, bad: CROSS, wait: DASH };
    function node(id, state) { var t = tone[id]; var icon = ICONS[t] || (state === "notneeded" || state === "nothing" ? DASH : ""); return '<span class="node ' + (t || (state === "next" ? "next" : "")) + '" aria-hidden="true">' + icon + "</span>"; }
    var tiles = scenarios.length ? '<div class="tiles">' + scenarios.map(function (r) { return '<span class="tile ' + (r.outcome === "pass" ? "ok" : r.outcome === "fail" ? "bad" : "none") + '" title="' + esc(NAMES[r.id] || r.id) + '"></span>'; }).join("") + "</div>" : '<div class="tiles">' + "<span class=tile></span>".repeat(10) + "</div>";
    var scenarioList = scenarios.length ? '<ul class="list">' + scenarios.map(function (r) { var o = r.outcome; return '<li class="' + (o === "pass" ? "ok" : o === "fail" ? "bad" : "") + '"><span>' + esc(NAMES[r.id] || r.id) + "</span><b>" + (o === "pass" ? "Passed" : o === "fail" ? "Failed" : o === "reported" ? "Not graded" : esc(cap(o))) + "</b></li>"; }).join("") + "</ul>" : "";
    var files = fix ? (fix.files || []) : [];
    var chips = files.length ? '<div class="chips">' + files.slice(0, 6).map(function (f) { return '<span class="chip ' + esc(f.action || "") + '" title="' + esc(f.path) + '">' + esc((f.path || "").split("/").pop()) + "</span>"; }).join("") + (files.length > 6 ? '<span class="chip">+' + (files.length - 6) + "</span>" : "") + "</div>" : '<div class="chips"><span class="chip" style="opacity:.5">webhook handler</span><span class="chip" style="opacity:.5">entitlement</span></div>';
    var fileList = files.length ? '<ul class="list">' + files.map(function (f) { return "<li><span class=code>" + esc(f.path || "") + "</span><b>" + esc(cap(f.action || "")) + "</b></li>"; }).join("") + "</ul>" : "";
    var dotList = [];
    stillWrong.forEach(function (a) { dotList.push(a.verdict === "locked_out" ? "bad" : "wait"); });
    fixedNow.forEach(function () { dotList.push("ok"); });
    for (var i = 0; i < Math.min(agreeing, 160); i++) dotList.push("ok");
    noVerdict.forEach(function () { dotList.push("none"); }); notInStripe.forEach(function () { dotList.push("none"); });
    var dots = sweep && matched > 0 ? '<div><div class="dots">' + dotList.map(function (d) { return '<i class="' + d + '"></i>'; }).join("") + (agreeing > 160 ? '<i class="more">+' + (agreeing - 160) + "</i>" : "") + '</div><div class="legend"><span><i></i>' + (agreeing + fixedNow.length) + " agree</span>" + (stillWrong.length ? '<span><i class="wait"></i>' + stillWrong.length + " disagree</span>" : "") + (noVerdict.length + notInStripe.length ? '<span><i class="none"></i>' + (noVerdict.length + notInStripe.length) + " no verdict</span>" : "") + "</div></div>" : '<div class="dots">' + '<i class="none"></i>'.repeat(24) + "</div>";
    $("loop").innerHTML =
      '<div class="card step"><div class="head">' + node("check", states.check) + '<div><div class="title">Check</div><div class="state">' + (ranLive ? (grade === "?" ? "No grade" : "Grade " + esc(grade) + " · " + passed + " of " + scenarios.length + " passed") : check ? "Code read, not run" : "Not run") + '</div></div></div><div class="vis">' + tiles + "</div>" + (scenarioList ? "<details><summary class=more>Ten situations</summary>" + scenarioList + "</details>" : "") + "</div>" +
      '<div class="card step"><div class="head">' + node("fix", states.fix) + '<div><div class="title">Fix</div><div class="state">' + (provenFix ? plural(files.length, "file", "files") + " · re-test passed" : (fix && !passing) ? "Applied · re-test failed" : fix ? "Applied · not re-tested" : states.fix === "notneeded" ? "Not needed" : states.fix === "next" ? "Next" : "Not yet") + '</div></div></div><div class="vis">' + chips + "</div>" + (fileList ? "<details><summary class=more>Files</summary>" + fileList + "</details>" : "") + "</div>" +
      '<div class="card step"><div class="head">' + node("monitor", states.monitor) + '<div><div class="title">Monitor</div><div class="state">' + (states.monitor === "done" ? matched + " compared · " + (stillWrong.length ? plural(stillWrong.length, "disagrees", "disagree") : "all agree") : states.monitor === "failed" ? "Could not run" : states.monitor === "nothing" ? "Nothing to compare" : states.monitor === "next" ? "Next" : "Not yet") + '</div></div></div><div class="vis">' + dots + "</div>" + "</div>";

    /* ---- what needs you, and where the two sides disagree ---- */
    $("inbox").innerHTML = waiting.length ? waiting.map(function (r) {
      return '<div class="approval"><p class="big wait">' + esc(r.account) + '</p><p class="why">Canceled in Stripe, still has access' + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + "/mo" : "") + (r.ready ? "" : " · held until " + esc(when(r.readyAt))) + "</p>" + cmd("npx akeso-check approvals --approve " + r.id) + "</div>";
    }).join("") : '<p class="quiet">Nothing waiting.</p>';
    function stripeWord(a) { return a.stripe == null ? "No subscription" : a.stripe === "incomplete_expired" ? "Expired" : cap(a.stripe); }
    function appWord(a) { return fixedSince(a) ? "Has access" : a.app == null ? "Unknown" : a.app ? "Has access" : "No access"; }
    function meaning(a) {
      if (a.verdict === "locked_out") return fixedSince(a) ? "Restored" : "Locked out";
      if (a.verdict === "still_entitled") return queuedFor[a.account] ? "Awaiting your approval" : "Still has access";
      if (a.verdict === "no_conclusion") return "No verdict";
      return "Left alone";
    }
    function toneFor(a) { return a.verdict === "locked_out" ? (fixedSince(a) ? "ok" : "bad") : a.verdict === "still_entitled" ? "wait" : "none"; }
    var shown = stillWrong.concat(fixedNow, noVerdict);
    $("compare").innerHTML = shown.length ? '<div class="compare">' + shown.map(function (a) {
      var t = toneFor(a); var price = money(a.priceMonthly);
      return '<div class="who"><span class="code">' + esc(a.account) + "</span><span>" + esc(meaning(a)) + (price ? " · " + price + "/mo" : "") + '</span></div><div class="side ' + (t === "ok" ? "ok" : t === "none" ? "" : t) + '"><small>Stripe says</small><b>' + esc(stripeWord(a)) + '</b></div><div class="tie ' + t + '" aria-hidden="true">' + (t === "ok" ? "=" : t === "none" ? "?" : "&ne;") + '</div><div class="side ' + (t === "ok" ? "ok" : t === "none" ? "" : t) + '"><small>App says</small><b>' + esc(appWord(a)) + "</b></div>";
    }).join("") + "</div>" + (notInStripe.length ? '<p class="note">' + notInStripe.length + " without a subscription, left alone.</p>" : "") : '<p class="quiet">' + (sweep && matched > 0 ? "All agree." : sweep ? "Nothing to compare." : "No sweep yet.") + "</p>";
    $("compareN").textContent = sweep && matched > 0 ? matched + " compared · " + esc(when(sweep.at)) : "";

    /* ---- receipts ---- */
    var unpaid = lastGood ? (Number(lastGood.comparison.monthlyExposure) || 0) : null;
    $("figures").innerHTML =
      '<div class="card figure"><div class="n' + (restored.length ? " ok" : "") + '">' + restored.length + '</div><div class="l">Access restored</div>' + (unconfirmed.length ? '<div class="s">' + unconfirmed.length + " not yet confirmed</div>" : "") + "</div>" +
      '<div class="card figure"><div class="n">' + removed.length + '</div><div class="l">Access removed</div></div>' +
      '<div class="card figure"><div class="n' + (unpaid > 0 ? " wait" : "") + '">' + (unpaid == null ? "–" : money(unpaid)) + '</div><div class="l">Unpaid access, per month</div>' + (unpaid == null ? '<div class="s">no sweep yet</div>' : "") + "</div>";

    /* ---- the boundary ---- */
    var fw = check && (check.framework || (check.detection && check.detection.framework));
    $("bound").innerHTML =
      '<div class="card z"><div class="glyph">' + LOCK + '</div><div class="t">Your machine</div><div class="d">Code, keys and ledger stay here.</div><div class="s"><i class="ok"></i>Nothing leaves</div></div>' +
      '<div class="card z"><div class="glyph">' + EYE + '</div><div class="t">Stripe</div><div class="d">Read-only key. Never written to, never stored.</div><div class="s"><i class="' + (sweep && !sweep.couldNotRun ? "ok" : sweep ? "bad" : "") + '"></i>' + (sweep && !sweep.couldNotRun ? "Connected" : sweep ? "Last read failed" : "Not yet read") + "</div></div>" +
      '<div class="card z"><div class="glyph">' + KEY + '</div><div class="t">Your app' + (fw ? ' <span style="font-weight:400;color:var(--ink3);font-size:14px">' + esc(cap(String(fw).replace(/-/g, " "))) + "</span>" : "") + '</div><div class="d">Two signed endpoints. Delete one file to revoke.</div><div class="s"><i class="' + (covered ? "ok" : fix ? "wait" : "") + '"></i>' + (covered ? "Rules confirmed" : fix ? "Rules not confirmed" : "Not connected") + "</div></div>";

    /* ---- the ledger ---- */
    $("timeline").innerHTML = L.length ? L.slice().reverse().map(function (e) {
      var t = e.kind === "check" ? (e.grade === "A" ? "ok" : e.grade && e.grade !== "?" ? "bad" : "") : e.kind === "fix" ? "wait" : e.kind === "sweep" ? (e.couldNotRun ? "bad" : e.comparison && e.comparison.clean ? "ok" : "wait") : e.kind === "restore" ? (e.result === "applied" ? "ok" : "bad") : e.kind === "approval" ? "wait" : e.kind === "certify" ? "ok" : e.kind === "unreadable" ? "bad" : "";
      var sum = e.kind === "check" ? (e.grade ? "Grade " + e.grade : "Code read") : e.kind === "fix" ? plural((e.files || []).length, "file written", "files written") : e.kind === "sweep" ? (e.couldNotRun ? "Could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? (e.direction === "grant" ? "Restored " : "Removed ") + (e.account || "") + (e.result === "applied" ? "" : " · " + e.result) : e.kind === "approval" ? "Removal " + (e.state === "cancelled" ? "canceled" : e.state || "") + " " + (e.account || "") : e.kind === "certify" ? "Access rules confirmed" : e.kind === "unreadable" ? "Unreadable line" : "";
      return '<div class="entry ' + t + (e.kind === "unreadable" ? " unread" : "") + '"><div class="k"><b>' + esc(e.kind === "unreadable" ? "Line " + e.line : cap(e.kind)) + "</b><span>" + esc(sum) + '</span></div><div class="t">' + esc(when(e.at)) + "</div></div>";
    }).join("") : '<p class="quiet">The ledger is empty.</p>';
    $("ledgerWhere").textContent = D.root ? D.root + "/.akeso/ledger.jsonl" : (D.fileName || "");

    /* ---- chain ---- */
    var seal = $("seal"); seal.className = "seal none"; seal.textContent = L.length ? "Verifying" : "No ledger";
    function setSeal(text, bad, none) { seal.textContent = text; seal.className = "seal" + (bad ? " bad" : none ? " none" : ""); var s2 = $("seal2"); if (s2) { s2.textContent = text; s2.className = "seal" + (bad ? " bad" : none ? " none" : ""); } }
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

  var LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M15 7l3 3M18 4l2 2"/></svg>';

  function loadRows(text) {
    var n = 0;
    return text.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { n++; try { var o = JSON.parse(l); return (o && typeof o === "object") ? o : { kind: "unreadable", line: n }; } catch (x) { return { kind: "unreadable", line: n }; } });
  }
  document.addEventListener("change", function (e) {
    if (!e.target.matches("input[type=file]")) return;
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
    if (e.target.id === "demoLink") { e.preventDefault(); var D = window.AKESO || {}; window.AKESO = Object.assign({}, D, { ledger: D.demoLedger || [], appName: D.demoName || "Demo app", demo: true, onboarding: false, fileName: "" }); render(); window.scrollTo(0, 0); return; }
    if (e.target.id === "backLink") { e.preventDefault(); var D2 = window.AKESO || {}; window.AKESO = Object.assign({}, D2, { ledger: [], demo: false, onboarding: true, fileName: "" }); render(); window.scrollTo(0, 0); return; }
    var t = e.target.closest("[data-tool]");
    if (t) {
      var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English.";
      var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } };
      document.querySelectorAll("[data-tool]").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
      $("cmd").textContent = T[t.dataset.tool].paste; $("cmdCopy").dataset.copy = T[t.dataset.tool].paste; $("how").hidden = !T[t.dataset.tool].steps;
    }
  });
  render();
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  const data = JSON.stringify(hosted && demo
    ? { ledger: [], demoLedger: ledger, demoName: appName, appName: "Your app", onboarding: true, demo: false, hosted: true, scenarioNames: SCENARIO_NAMES }
    : { ledger, appName, root, onboarding: false, demo: false, hosted, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");

  const acts = hosted
    ? `<span class="acts"><span class="status" id="status"></span><a href="#" class="link" id="backLink" hidden>Start over</a><a href="#" class="link" id="demoLink">See a demo</a><label class="link" title="Read in this tab. Never uploaded.">Load your ledger<input type="file" id="ledgerFile" class="sr" accept=".jsonl,application/json,text/plain"></label></span>`
    : `<span class="acts"></span>`;

  const start = hosted ? `
    <section id="start" hidden>
      <div class="hero">
        <div>
          <h1>Does your app give paid access to exactly the people paying for it?</h1>
          <p class="lead">One command. Runs on your machine. Nothing leaves it.</p>
        </div>
        <div class="ring none" style="--arc:0"><svg viewBox="0 0 160 160"><circle class="track" cx="80" cy="80" r="70"/><circle class="arc" cx="80" cy="80" r="70"/></svg><div class="center">?<small>not yet run</small></div></div>
      </div>
      <div class="steps3">
        <div class="card"><div class="num">1</div><div class="t">Paste one command</div><div class="tabs" id="tabs" role="tablist"><button role="tab" aria-selected="true" data-tool="terminal">Terminal</button><button role="tab" aria-selected="false" data-tool="claude">Claude Code</button><button role="tab" aria-selected="false" data-tool="cursor">Cursor</button><button role="tab" aria-selected="false" data-tool="codex">Codex</button><button role="tab" aria-selected="false" data-tool="lovable">Lovable / Bolt / v0</button></div><ol class="how" id="how" hidden><li>Put your project on GitHub (the GitHub button in your builder).</li><li>On github.com: Code, Codespaces, Create codespace.</li><li>In the terminal at the bottom, paste this and press Enter.</li></ol><div class="fill"></div><div class="cmd"><code id="cmd">npx akeso-check</code><button class="link" id="cmdCopy" data-copy="npx akeso-check">Copy</button></div><div class="d">Free and <a class="link" href="https://github.com/jacekimmy/akeso-check">open source</a>.</div></div>
        <div class="card"><div class="num">2</div><div class="t">Load the ledger it writes</div><div class="d"><span class="code">.akeso/ledger.jsonl</span> in your project. Read in this tab, never uploaded.</div><div class="fill"></div><label class="link">Load your ledger<input type="file" class="sr" accept=".jsonl,application/json,text/plain"></label></div>
        <div class="card"><div class="num">3</div><div class="t">This page becomes your app's</div><div class="d">Grade, fix, accounts, approvals, receipts.</div><div class="fill"></div><a href="#" class="link" id="demoLink2" onclick="document.getElementById('demoLink').click();return false;">See it with a demo ledger</a></div>
      </div>
    </section>` : "";

  const shell = `<header class="nav"><div class="wrap">
    <span class="brand"><i aria-hidden="true"></i>Akeso</span>
    ${acts}
    <span class="seal" id="seal" aria-live="polite"></span>
  </div></header>
  <main class="wrap">
    ${start}
    <div id="page">
      <section>
        <p class="eyebrow appName"></p>
        <div class="hero">
          <div>
            <h1 id="verdict"></h1>
            <p class="lead" id="lead"></p>
            <div id="next"></div>
          </div>
          <div class="ring" id="ring"><svg viewBox="0 0 160 160"><circle class="track" cx="80" cy="80" r="70"/><circle class="arc" cx="80" cy="80" r="70"/></svg><div class="center" id="ringCenter"></div></div>
        </div>
      </section>

      <section>
        <h2 class="sr">The loop</h2>
        <div class="loop" id="loop"></div>
      </section>

      <section>
        <div class="sides">
          <div><h2>Accounts<span class="r" id="compareN"></span></h2><div class="card" id="compare"></div></div>
          <div><h2>Waiting for your approval</h2><div class="card" id="inbox"></div></div>
        </div>
      </section>

      <section>
        <h2>Receipts</h2>
        <div class="figures" id="figures"></div>
        <p class="note">Revenue recovered: not measured.</p>
      </section>

      <section>
        <h2>What Akeso can touch</h2>
        <div class="bound" id="bound"></div>
      </section>

      <section>
        <h2>Ledger<span class="r" id="ledgerWhere"></span><span class="seal none" id="seal2" style="margin-left:14px"></span></h2>
        <div class="card"><div class="timeline" id="timeline"></div></div>
      </section>

      <p class="doctrine">Akeso restores access on its own. It never removes access on its own.</p>
    </div>
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
