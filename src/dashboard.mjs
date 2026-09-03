/* The page: the lock screen a stranger meets, and the tool page a founder
 * lives in after Grant. Built to DESIGN_SPEC.md (Sep 2, 2026).
 *
 * One HTML file. The ledger is embedded (the local `page` command) or loaded
 * in the browser (the hosted copy). Nothing is uploaded.
 *
 * Foundations: Geist (hosted only; the local copy makes no network requests),
 * warm off-white ground, white surfaces with hairlines, 8px radius on cards,
 * pills on buttons, one accent green, amber and red only for state. One
 * authored motion per screen. A sentence stays only if removing it would make
 * a new person act wrongly.
 *
 * Doctrine carries in unchanged: a step is lit only when it executed, no
 * number is invented, revenue recovered is never a figure, the chain is
 * verified here with the same hash the ledger wrote, and Akeso never removes
 * access on its own.
 */

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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
    --bg:#f6f5f1; --card:#ffffff; --ink:#17191d; --ink2:#5d636c; --ink3:#8a9099; --line:#e6e4dd; --tint:#f1f0eb;
    --g1:#22c3de; --g2:#1fd1c4; --g3:#3ae8b3; --glass:linear-gradient(100deg, #22c3de, #1fd1c4 50%, #3ae8b3); --accent:#0e9c95; --ok:#1e9a6a; --okSoft:#e3f4ec; --bad:#e5484d; --badSoft:#fbdcdd; --wait:#e0961a; --waitSoft:#fbecd0; --none:#c9cdd3; --link:#0e9c95;
    --frame:#0b0c0e;
  }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0f1114; --card:#16181c; --ink:#f2f2ee; --ink2:#a4a9b1; --ink3:#6f757e; --line:#262a30; --tint:#1c1f24;
    --g1:#3fd3ee; --g2:#3fe2d5; --g3:#5cf2c4; --glass:linear-gradient(100deg, #3fd3ee, #3fe2d5 50%, #5cf2c4); --accent:#3fe2d5; --ok:#3ccf8e; --okSoft:#123b2c; --bad:#ff6b6f; --badSoft:#4a1e21; --wait:#f0b13c; --waitSoft:#4a3413; --none:#3a3f47; --link:#3fe2d5;
    --frame:#141619;
  } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 Geist, "Geist Fallback", -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; }
  code, .mono { font-family:"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; font-size:.92em; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:8px; }
  ::selection { background:color-mix(in srgb, var(--accent) 22%, transparent); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  [hidden] { display:none !important; }
  button { font:inherit; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; height:40px; padding:0 18px; border-radius:999px; background:var(--glass); color:#06100f; font-size:14px; font-weight:500; border:0; cursor:pointer; white-space:nowrap; transition:transform .18s ease-out, opacity .18s; }
  .btn:hover { opacity:.92; } .btn:active { transform:scale(.98); }
  .btn.big { height:48px; padding:0 26px; font-size:16px; }
  .btn.sec { background:var(--card); color:var(--ink); border:1px solid var(--line); }
  .btn.danger { background:var(--card); color:var(--bad); border:1px solid var(--line); }
  .btn.danger:hover { border-color:var(--bad); opacity:1; }
  .link { border:0; background:none; padding:0; color:var(--link); font-weight:500; cursor:pointer; font-size:inherit; }
  .quiet { color:var(--ink2); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; }
  .wrap { max-width:1080px; margin:0 auto; padding:0 32px; }

  /* ---------- lock screen: paper ---------- */
  #lock { height:100vh; height:100dvh; display:flex; flex-direction:column; position:relative; overflow:hidden; background:#f3ecdd; color:#1c1a16; }
  #lock::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:.55; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.35 0 0 0 0 0.3 0 0 0 0 0.22 0 0 0 .09 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
  #lock::after { content:""; position:absolute; inset:0; pointer-events:none; background:radial-gradient(120% 80% at 50% 0%, rgba(255,250,236,.55), transparent 60%); }
  #lock canvas.field, #lock .stage { display:none; }
  #lock .paper { position:relative; z-index:1; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; }
  #lock .lines { position:relative; width:min(880px, 100%); display:grid; }
  #lock .lines h1 { grid-area:1 / 1; margin:0; font-family:Newsreader, "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-weight:400; font-size:clamp(40px, 5.2vw, 72px); line-height:1.06; letter-spacing:-.012em; text-wrap:balance; opacity:0; transition:opacity 1.6s ease; color:#1c1a16; }
  #lock .lines h1.on { opacity:1; }
  #lock .paper .btn.big { margin-top:44px; background:#1c1a16; color:#f3ecdd; font-family:Geist, system-ui, sans-serif; letter-spacing:0; text-transform:none; font-size:16px; padding:0 30px; }
  #lock .paper .btn.big .sat { box-shadow:0 0 0 3px #f3ecdd; }
  @media (prefers-color-scheme: dark) { #lock { background:#1a1815; color:#ece4d2; } #lock .lines h1 { color:#ece4d2; } #lock::after { background:radial-gradient(120% 80% at 50% 0%, rgba(255,240,210,.06), transparent 60%); } #lock .paper .btn.big { background:#ece4d2; color:#1a1815; } #lock .paper .btn.big .sat { box-shadow:0 0 0 3px #1a1815; } }
  #lock canvas.field { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  #lock .top, #lock .body { position:relative; }
  #lock .top { display:flex; align-items:center; justify-content:space-between; padding:22px 24px; font-size:13px; color:var(--ink2); }
  #lock .top .acts a { margin-left:22px; }
  .brand { font-weight:600; font-size:15px; color:var(--ink); display:inline-flex; align-items:center; gap:9px; }
  .brand i { width:10px; height:10px; border-radius:50%; background:var(--accent); display:inline-block; }
  #lock .body { flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px 24px; gap:0; }
  .board { margin:0; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-weight:600; text-transform:uppercase; letter-spacing:0; font-size:min(44px, calc((100vw - 48px) / 26 / .62)); line-height:1.18; }
  .board .row { display:block; white-space:pre; }
  .board .cell { display:inline-block; width:.62em; text-align:center; perspective:300px; }
  .board .cell span { display:inline-block; transform-origin:50% 50%; backface-visibility:hidden; }
  .board .cell.go span { animation:flap 90ms linear; }
  @keyframes flap { 0% { transform:rotateX(0); } 49% { transform:rotateX(-90deg); } 51% { transform:rotateX(90deg); } 100% { transform:rotateX(0); } }
  .stage { margin-top:28px; perspective:1400px; position:relative; }
  .frame .glow { position:absolute; inset:-9px; border-radius:16px; pointer-events:none; z-index:3; padding:1.5px; opacity:0; transition:opacity .2s;
    background:radial-gradient(150px circle at var(--mx, -999px) var(--my, -999px), #ffffff 0%, #dcfff7 5%, var(--g3) 13%, var(--g2) 24%, color-mix(in srgb, var(--g1) 60%, transparent) 38%, transparent 54%);
    -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite:exclude; }
  .frame .glow.on { opacity:1; }
  .frame { height:min(50vh, 440px); aspect-ratio:96 / 44; max-width:100%; width:auto; position:relative; z-index:1; opacity:0; transform-style:preserve-3d; transform:translateY(22px) rotateX(10deg); transition:opacity .7s ease-out, transform .7s ease-out; }
  .frame .screen { position:absolute; inset:0; background:#0f0e0c; background-image:radial-gradient(rgba(63,226,213,.14) 1px, transparent 1.3px); background-size:28px 28px; background-position:14px 14px; border-radius:10px; border:1px solid rgba(255,255,255,.14); box-shadow:0 36px 70px -34px rgba(0,0,0,.7); overflow:hidden; }
  .frame .mrail { background:#050505; }
  .frame .chrome { background:#0e0d0b; }
  .frame .mcontent { background:#100f0d; }
  .frame.in { opacity:1; transform:rotateX(var(--rx, 6deg)) rotateY(var(--ry, 0deg)); transition:opacity .7s ease-out, transform 0s; will-change:transform; }
  .frame.in.settle { transition:opacity .7s ease-out, transform .6s cubic-bezier(.2,.8,.2,1); }
  .frame .chrome { height:36px; display:flex; align-items:center; gap:14px; padding:0 22px; border-bottom:1px solid rgba(255,255,255,.14); font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#8a9099; position:relative; z-index:2; }
  .frame .chrome b { color:#f2f2ee; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:inline-flex; align-items:center; gap:9px; }
  .frame .chrome b i { width:8px; height:8px; border-radius:50%; background:var(--glass); display:inline-block; }
  .frame .chrome .crumb { color:#8a9099; } .frame .chrome .crumb::before { content:"›"; margin:0 8px; color:#5d636c; }
  .frame .chrome .seal { margin-left:auto; background:none; border:0; padding:0; color:#8a9099; font:inherit; letter-spacing:inherit; text-transform:inherit; }
  .frame .chrome .seal::before { background:var(--ok); }
  .frame .fbody { position:relative; z-index:2; display:grid; grid-template-columns:1fr 220px; border-bottom:1px solid rgba(255,255,255,.14); }
  .frame .panel { padding:24px 22px 22px; }
  .frame .panel + .panel { border-left:1px solid rgba(255,255,255,.14); }
  .frame .panel .eyebrow { margin:0 0 8px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.08em; color:#8a9099; text-transform:uppercase; }
  .frame .panel .verdict { font-size:30px; }
  .frame .panel .act { margin-top:16px; }
  .frame .panel .btn { height:34px; padding:0 14px; font-size:13px; }
  .frame .panel .meta { margin-top:14px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.04em; color:#8a9099; display:flex; align-items:center; gap:8px; }
  .frame .panel .meta i { width:6px; height:6px; border-radius:50%; background:var(--ok); display:inline-block; animation:pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity:.4; } 50% { opacity:1; } }
  .frame .panel.gauge { display:flex; align-items:center; justify-content:center; padding:18px; }
  .frame .gauge .ring { width:150px; height:150px; }
  .frame .gauge .ring::before { content:""; position:absolute; inset:-12px; border-radius:50%; background:repeating-conic-gradient(from 0deg, rgba(255,255,255,.3) 0 0.8deg, transparent 0.8deg 6deg); -webkit-mask:radial-gradient(circle, transparent 78px, #000 79px, #000 86px, transparent 87px); mask:radial-gradient(circle, transparent 78px, #000 79px, #000 86px, transparent 87px); }
  .frame .gauge .ring .center { font-size:44px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; }
  .frame .gauge .ring .center small { font-family:"Geist Mono", ui-monospace, Menlo, monospace; letter-spacing:.08em; text-transform:uppercase; font-size:10px; }
  .frame .inner .loop { margin:0; display:grid; gap:0; background:none; border:0; position:relative; z-index:2; }
  .frame .inner .loop::before { display:none; }
  .frame .inner .loop .cell { background:none; border:0 !important; border-radius:0; box-shadow:none; padding:18px 22px 16px; }
  .frame .inner .loop .cell + .cell { border-left:1px solid rgba(255,255,255,.14) !important; }
  .frame .inner .loop .head { margin-bottom:12px; } .frame .inner .loop .name { font-size:15px; } .frame .inner .loop .state { font-size:12px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; letter-spacing:.02em; }
  .frame .inner .loop .vis { min-height:48px; }
  .frame .inner .node { box-shadow:none; }
  .frame .inner .tile { width:22px; height:22px; border-radius:3px; }
  .frame .inner .chip { background:none; border:1px solid rgba(255,255,255,.18); color:#f2f2ee; border-radius:3px; }
  .frame .inner .chip.replaced { border-color:rgba(224,150,26,.7); color:#f0b13c; } .frame .inner .chip.created { border-color:rgba(60,207,142,.6); color:#3ccf8e; }
  .frame .inner .dots i { width:9px; height:9px; border-radius:2px; }
  .frame .inner .legend { font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.02em; }
  .frame .tool { display:grid; grid-template-columns:150px 1fr; height:404px; }
  .frame .mrail { border-right:1px solid rgba(255,255,255,.14); padding:16px 0; display:flex; flex-direction:column; gap:2px; font-size:12px; color:#8a9099; }
  .frame .mrail span { padding:7px 18px; display:flex; align-items:center; gap:8px; cursor:pointer; }
  .frame .mrail span:hover { color:#f2f2ee; }
  .frame .mrail span i { opacity:0; } .frame .mrail span.on i { opacity:1; }
  .frame .mhead .link { text-transform:none; letter-spacing:.02em; cursor:pointer; }
  .frame .mcard { display:flex; align-items:center; gap:16px; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:16px 18px; }
  .frame .mcard > div:first-child { flex:1; }
  .frame .macts { display:flex; gap:8px; } .frame .macts .btn { height:32px; padding:0 14px; font-size:12px; }
  .frame .macts .btn.sec { background:transparent; color:#f2f2ee; border:1px solid rgba(255,255,255,.2); } .frame .macts .btn.danger { background:transparent; color:var(--bad); border:1px solid rgba(255,255,255,.2); }
  .frame .mfigs { display:grid; grid-template-columns:1fr 1fr 1fr; border:1px solid rgba(255,255,255,.14); border-radius:8px; }
  .frame .mfigs > div { padding:18px; } .frame .mfigs > div + div { border-left:1px solid rgba(255,255,255,.14); }
  .frame .mfigs b { display:block; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:34px; font-weight:600; line-height:1; color:#f2f2ee; } .frame .mfigs b.ok { color:var(--ok); } .frame .mfigs b.wait { color:var(--wait); }
  .frame .mfigs span { display:block; margin-top:8px; font-size:12px; color:#8a9099; }
  .frame .dim { color:#8a9099; }
  .frame .mrail span.on { color:#f2f2ee; }
  .frame .mrail span i { width:6px; height:6px; border-radius:50%; background:var(--glass); display:inline-block; }
  .frame .mcontent { padding:18px 22px 0; display:flex; flex-direction:column; gap:12px; min-width:0; margin:0; }
  .frame .mtotals { margin:0 -22px; padding:14px 22px 0; background:#171614; border-top:1px solid rgba(255,255,255,.1); flex:1; }
  .frame .event { font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.04em; color:var(--g3); min-height:16px; opacity:0; transition:opacity .35s; margin:-6px 0 0; }
  .frame .event.on { opacity:1; }
  .frame .mcontent > * { animation:rise .45s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(var(--i, 0) * 60ms); }
  @keyframes rise { from { opacity:0; transform:translateY(8px); } }
  .frame .mrow { animation:wipe .5s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(var(--i, 0) * 45ms + 120ms); }
  @keyframes wipe { from { clip-path:inset(0 100% 0 0); } to { clip-path:inset(0 0 0 0); } }
  .frame .mrow i { animation:pop .35s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(var(--i, 0) * 45ms + 60ms); }
  @keyframes pop { from { transform:scale(0); } }
  .frame .mtop .verdict { font-size:28px; }
  .frame .bridge { margin:-4px 0 0; }
  .frame .bridge .rails { display:flex; justify-content:space-between; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#8a9099; margin-bottom:6px; }
  .frame .bridge svg { width:100%; height:auto; display:block; overflow:visible; }
  .frame .bridge .ln { fill:none; stroke-width:1.2; stroke:rgba(58,232,179,.42); stroke-dasharray:1000; stroke-dashoffset:1000; animation:draw .9s cubic-bezier(.2,.8,.2,1) forwards; animation-delay:calc(var(--i, 0) * 30ms); transition:stroke .5s; }
  .frame .bridge .ln.wait { stroke:var(--wait); stroke-width:1.6; stroke-dasharray:6 5; stroke-dashoffset:0; animation:none; }
  .frame .bridge .ln.bad { stroke:var(--bad); stroke-width:1.6; }
  .frame .bridge .ln.restored { stroke:rgba(58,232,179,.9); stroke-width:1.5; }
  .frame .bridge .ln.just { stroke:#dcfff7; filter:drop-shadow(0 0 4px rgba(58,232,179,.9)); }
  @keyframes draw { to { stroke-dashoffset:0; } }
  .frame .bridge .pt { fill:var(--ok); transition:fill .4s; }
  .frame .bridge .pt.off { fill:none; stroke:var(--none); stroke-width:1.2; }
  .frame .bridge .pt.l.off { fill:none; stroke:var(--wait); }
  .frame .bridge .pulse { fill:#fff; opacity:0; filter:drop-shadow(0 0 6px #3ae8b3); transition:opacity .2s; }
  .frame .mtotals b.bump { animation:bump .5s cubic-bezier(.2,.8,.2,1); }
  @keyframes bump { 30% { transform:translateY(-4px) scale(1.15); } }
  .frame .mtotals b { display:inline-block; }
  @media (prefers-reduced-motion: reduce) { .frame .bridge .ln { animation:none; stroke-dashoffset:0; } }
  .frame .mtop { grid-template-columns:1fr; }
  @media (prefers-reduced-motion: reduce) { .frame .mcontent > *, .frame .mrow, .frame .mrow i { animation:none; } }
  .frame .mtop { display:grid; grid-template-columns:1fr 130px; gap:16px; align-items:center; }
  .frame .mtop .verdict { font-size:26px; }
  .frame .mtop .act { margin-top:12px; } .frame .mtop .btn { height:32px; padding:0 14px; font-size:13px; }
  .frame .mtop .meta { margin-top:10px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.04em; color:#8a9099; display:flex; align-items:center; gap:8px; }
  .frame .mtop .meta i { width:6px; height:6px; border-radius:50%; background:var(--ok); display:inline-block; animation:pulse 2.4s ease-in-out infinite; }
  .frame .mtop .gauge .ring { width:120px; height:120px; } .frame .mtop .gauge .ring .center { font-size:34px; } .frame .mtop .gauge .ring::before { inset:-9px; -webkit-mask:radial-gradient(circle, transparent 62px, #000 63px, #000 69px, transparent 70px); mask:radial-gradient(circle, transparent 62px, #000 63px, #000 69px, transparent 70px); }
  .frame .mhead { display:flex; align-items:center; justify-content:space-between; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8a9099; border-top:1px solid rgba(255,255,255,.14); padding-top:12px; }
  .frame .mhead .legend { display:flex; gap:12px; text-transform:none; letter-spacing:.02em; margin:0; }
  .frame .mhead .legend i { width:7px; height:7px; border-radius:2px; }
  .frame .mrows { display:flex; flex-direction:column; }
  .frame .mrow { display:grid; grid-template-columns:8px 92px 84px 14px 92px 1fr 70px; gap:10px; align-items:center; font-size:12px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.07); color:#f2f2ee; }
  .frame .mrow i { width:8px; height:8px; border-radius:2px; background:var(--none); display:inline-block; }
  .frame .mrow.ok i { background:var(--ok); } .frame .mrow.wait i { background:var(--wait); } .frame .mrow.bad i { background:var(--bad); }
  .frame .mrow .dim { color:#8a9099; } .frame .mrow .r { text-align:right; }
  .frame .mrow .tie { text-align:center; font-weight:600; color:#8a9099; } .frame .mrow.wait .tie, .frame .mrow.bad .tie { color:var(--wait); } .frame .mrow.bad .tie { color:var(--bad); } .frame .mrow.ok .tie { color:var(--ok); }
  .frame .mrow .word { font-weight:500; } .frame .mrow.ok .word { color:var(--ok); } .frame .mrow.wait .word { color:var(--wait); } .frame .mrow.bad .word { color:var(--bad); } .frame .mrow.none .word { color:#8a9099; }
  .frame .mrow.dimrow { color:#8a9099; } .frame .mrow.dimrow .word { color:#8a9099; }
  .frame .mtotals { display:flex; gap:26px; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:11px; letter-spacing:.04em; color:#8a9099; padding:8px 0 0; }
  .frame .mtotals b { font-size:15px; color:#f2f2ee; margin-right:6px; } .frame .mtotals b.ok { color:var(--ok); } .frame .mtotals b.wait { color:var(--wait); }
  .frame .mtotals { padding:14px 22px 0; align-items:baseline; }
  .frame .inner .big { font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:40px; font-weight:600; line-height:1; color:var(--ok); display:flex; align-items:baseline; gap:12px; }
  .frame .inner .big small { font-family:Geist, system-ui, sans-serif; font-size:12px; font-weight:400; color:#8a9099; max-width:12ch; line-height:1.3; }
  .frame .inner { position:absolute; left:0; top:0; width:960px; height:440px; transform-origin:0 0; transform:scale(var(--s, 1)); padding:0; color:#f2f2ee; text-align:left; --card:#131518; --line:#24272c; --ink:#f2f2ee; --ink2:#a4a9b1; --ink3:#6f757e; --bg:#0b0c0e; --tint:#1a1d22; --okSoft:#123b2c; --waitSoft:#4a3413; --none:#3a3f47; }
  .frame .inner .status { margin:0; }
  .frame .inner .loop { margin-top:36px; }
  #lock .btn.big { margin-top:44px; }
  .btn.orbit { position:relative; background:var(--ink); color:var(--bg); background-image:none; font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:14px; letter-spacing:.12em; text-transform:uppercase; padding:0 30px; overflow:visible; }
  .btn.orbit .lbl { display:inline-flex; }
  .btn.orbit .lbl .c { display:inline-block; width:.62em; text-align:center; perspective:200px; }
  .btn.orbit .lbl .c span { display:inline-block; backface-visibility:hidden; }
  .btn.orbit .lbl .c.go span { animation:flap 90ms linear; }
  .btn.orbit .sat { position:absolute; width:8px; height:8px; border-radius:50%; background:var(--glass); box-shadow:0 0 0 3px var(--bg); offset-path:inset(-4px round 999px); offset-distance:0%; }
  .btn.orbit:active { transform:scale(.97); }

  /* ---------- connect ---------- */
  #connect, #paste { padding:88px 0 96px; }
  .eyebrow { margin:0 0 12px; font-size:13px; font-weight:500; color:var(--ink2); }
  h1.big { margin:0; font-size:44px; line-height:1.05; letter-spacing:-.035em; font-weight:600; max-width:20ch; text-wrap:balance; }
  .lead { margin:14px 0 0; color:var(--ink2); font-size:17px; max-width:52ch; }
  .rows { margin-top:36px; }
  .rows .row { display:flex; align-items:center; gap:16px; padding:18px 20px; }
  .rows .row + .row { border-top:1px solid var(--line); }
  .rows .mark { width:36px; height:36px; border-radius:8px; background:var(--tint); display:flex; align-items:center; justify-content:center; flex:none; }
  .rows .mark svg { width:18px; height:18px; }
  .rows .k { flex:1; min-width:0; }
  .rows .k b { font-weight:500; font-size:16px; display:block; }
  .rows .k span { font-size:13px; color:var(--ink2); }
  .rows .st { font-size:13px; color:var(--ink2); display:flex; align-items:center; gap:8px; margin-right:6px; white-space:nowrap; }
  .rows .st i { width:8px; height:8px; border-radius:50%; background:var(--none); display:inline-block; }
  .rows .st i.ok { background:var(--ok); } .rows .st i.wait { background:var(--wait); }
  .rows .spin { width:14px; height:14px; border-radius:50%; border:2px solid var(--line); border-top-color:var(--ink); animation:spin 1s linear infinite; display:inline-block; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .alt { margin-top:28px; font-size:14px; color:var(--ink2); }
  .tabs { display:flex; gap:14px; font-size:13px; color:var(--ink2); flex-wrap:wrap; margin:28px 0 12px; }
  .tabs button { border:0; background:none; color:inherit; padding:0 0 4px; cursor:pointer; }
  .tabs button[aria-selected="true"] { color:var(--ink); font-weight:500; border-bottom:2px solid var(--ink); }
  .cmd { display:inline-flex; align-items:center; gap:14px; padding:12px 16px; border-radius:8px; background:var(--card); border:1px solid var(--line); font-size:14px; }
  .cmd code::before { content:"$ "; color:var(--ink3); }
  ol.how { margin:12px 0 0; padding-left:20px; font-size:14px; color:var(--ink2); }

  /* ---------- tool page ---------- */
  .bar { position:sticky; top:0; z-index:5; height:56px; background:var(--card); border-bottom:1px solid var(--line); }
  .bar .wrap { display:flex; align-items:center; gap:18px; height:56px; }
  .bar .app { font-weight:600; font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:38%; }
  .bar .seal { margin-left:auto; }
  .seal { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--ink2); padding:5px 12px 5px 9px; border-radius:999px; background:var(--card); border:1px solid var(--line); white-space:nowrap; }
  .seal::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--ok); }
  .seal.bad { color:var(--bad); } .seal.bad::before { background:var(--bad); } .seal.none::before { background:var(--none); }
  .bar .acts { display:flex; align-items:center; gap:16px; font-size:13px; color:var(--ink2); }
  .bar .who { width:28px; height:28px; border-radius:50%; background:var(--ink); color:var(--bg); display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; }
  .bar .status.bad { color:var(--bad); }
  .layout { display:grid; grid-template-columns:200px 1fr; gap:40px; padding:40px 0 80px; }
  .index { position:sticky; top:88px; align-self:start; font-size:13px; color:var(--ink2); display:flex; flex-direction:column; gap:10px; }
  .index a.on { color:var(--ink); font-weight:500; }
  .sections > section + section { margin-top:56px; }
  h2 { margin:0 0 12px; font-size:13px; font-weight:500; color:var(--ink2); display:flex; align-items:center; gap:12px; }
  h2 .r { margin-left:auto; font-weight:400; color:var(--ink3); }

  .status { display:grid; grid-template-columns:1fr 180px; gap:40px; align-items:center; }
  .verdict { margin:0; font-size:40px; line-height:1.05; letter-spacing:-.03em; font-weight:600; max-width:20ch; text-wrap:balance; }
  .status .lead { font-size:16px; margin-top:10px; }
  .status .act { margin-top:22px; display:flex; gap:12px; align-items:center; }
  .status .meta { margin:16px 0 0; font-size:12px; color:var(--ink3); }
  .ring { position:relative; width:180px; height:180px; }
  .ring svg { width:100%; height:100%; transform:rotate(-90deg); }
  .ring circle { fill:none; stroke-width:12; stroke-linecap:round; }
  .ring .track { stroke:var(--line); }
  .ring .arc { stroke:var(--none); stroke-dasharray:var(--arc, 0) 1000; transition:stroke-dasharray .8s ease; }
  .ring.ok .arc { stroke:var(--ok); } .ring.bad .arc { stroke:var(--bad); } .ring.wait .arc { stroke:var(--wait); }
  .ring.busy .arc { stroke:var(--none); stroke-dasharray:14 12; animation:spin 6s linear infinite; transform-origin:center; }
  .ring .center { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; font-size:52px; font-weight:600; letter-spacing:-.04em; line-height:1; }
  .ring .center svg { width:52px; height:52px; transform:none; }
  .ring .center small { font-size:12px; font-weight:500; color:var(--ink2); letter-spacing:0; margin-top:6px; }
  .ring.ok .center { color:var(--ok); } .ring.bad .center { color:var(--bad); } .ring.wait .center { color:var(--wait); } .ring.none .center, .ring.busy .center { color:var(--ink3); }

  .loop { display:grid; grid-template-columns:1fr 1fr 1fr; position:relative; }
  .loop::before { content:""; position:absolute; left:14%; right:14%; top:36px; height:2px; background:var(--line); }
  .loop .cell { padding:22px 22px 18px; position:relative; }
  .loop .cell + .cell { border-left:1px solid var(--line); }
  .loop .cell.open::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px; background:var(--ok); }
  .loop .head { display:flex; align-items:center; gap:12px; margin-bottom:16px; position:relative; }
  .loop .node { width:28px; height:28px; border-radius:50%; background:var(--card); border:2px solid var(--line); display:flex; align-items:center; justify-content:center; color:#fff; flex:none; }
  .loop .node svg { width:14px; height:14px; }
  .loop .node.ok { background:var(--ok); border-color:var(--ok); } .loop .node.bad { background:var(--bad); border-color:var(--bad); } .loop .node.wait { background:var(--wait); border-color:var(--wait); }
  .loop .node.next { border-color:var(--ink); border-style:dashed; }
  .loop .node.busy { border-color:var(--ink); border-style:dashed; animation:spin 2s linear infinite; }
  .loop .name { font-size:16px; font-weight:600; }
  .loop .state { font-size:13px; color:var(--ink2); }
  .loop .vis { min-height:56px; display:flex; align-items:center; }
  .loop .more { margin-top:14px; font-size:13px; }
  .lineok { --l:var(--ok); }
  .tiles { display:grid; grid-template-columns:repeat(5, 24px); gap:6px; }
  .tile { width:24px; height:24px; border-radius:6px; background:var(--none); }
  .tile.ok { background:var(--ok); } .tile.bad { background:var(--bad); }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { font-family:"Geist Mono", ui-monospace, Menlo, monospace; font-size:12px; padding:5px 9px; border-radius:6px; background:var(--tint); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip.replaced { background:var(--waitSoft); } .chip.created { background:var(--okSoft); }
  .dots { display:flex; flex-wrap:wrap; gap:5px; }
  .dots i { width:10px; height:10px; border-radius:50%; background:var(--ok); display:block; }
  .dots i.bad { background:var(--bad); } .dots i.wait { background:var(--wait); } .dots i.none { background:var(--none); }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--ink2); margin-top:8px; }
  .legend i { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:5px; background:var(--ok); }
  .legend i.bad { background:var(--bad); } .legend i.wait { background:var(--wait); } .legend i.none { background:var(--none); }
  .drawer { border-top:1px solid var(--line); padding:6px 22px 12px; }
  .drawer ul { margin:0; padding:0; list-style:none; font-size:14px; }
  .drawer li { display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
  .drawer li:last-child { border-bottom:0; }
  .drawer li span:first-child { flex:1; }
  .drawer li b { font-weight:500; color:var(--ink2); }
  .drawer li.ok b { color:var(--ok); } .drawer li.bad b { color:var(--bad); }

  .filters { display:flex; gap:18px; padding:14px 20px; border-bottom:1px solid var(--line); font-size:13px; color:var(--ink2); }
  .filters button { border:0; background:none; color:inherit; padding:0 0 3px; cursor:pointer; border-bottom:2px solid transparent; }
  .filters button.on { color:var(--ink); font-weight:500; border-bottom-color:var(--ink); }
  .crow { display:grid; grid-template-columns:150px 1fr 1fr auto; gap:16px; align-items:center; padding:0 20px; height:48px; border-bottom:1px solid var(--line); font-size:14px; position:relative; }
  .crow:last-child { border-bottom:0; }
  .crow::before { content:""; position:absolute; left:0; top:14px; bottom:14px; width:3px; border-radius:2px; background:transparent; }
  .crow.ok::before { background:var(--ok); } .crow.bad::before { background:var(--bad); } .crow.wait::before { background:var(--wait); }
  .crow.dim { color:var(--ink3); }
  .crow .sides { color:var(--ink2); }
  .crow .sides b { font-weight:500; color:var(--ink); }
  .crow .tie { font-weight:600; margin:0 8px; }
  .crow .tie.bad { color:var(--bad); } .crow .tie.wait { color:var(--wait); } .crow .tie.ok { color:var(--ok); }
  .crow .price { color:var(--ink2); }
  .empty { padding:18px 20px; font-size:14px; color:var(--ink2); }

  .ok-card { padding:22px 20px; display:flex; align-items:center; gap:20px; }
  .ok-card + .ok-card { margin-top:12px; }
  .ok-card .k { flex:1; }
  .ok-card .id { font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .ok-card .why { margin:4px 0 0; font-size:14px; color:var(--ink2); }
  .ok-card .acts { display:flex; gap:10px; align-items:center; }
  .ok-card .confirm { font-size:14px; display:flex; gap:12px; align-items:center; }
  .ok-card .done { font-size:14px; color:var(--ink2); }

  .figures { display:grid; grid-template-columns:1fr 1fr 1fr; }
  .figure { padding:22px 20px; }
  .figure + .figure { border-left:1px solid var(--line); }
  .figure .n { font-size:40px; font-weight:600; letter-spacing:-.04em; line-height:1; }
  .figure .n.ok { color:var(--ok); } .figure .n.wait { color:var(--wait); }
  .figure .l { margin-top:8px; font-size:13px; color:var(--ink2); }
  .note { margin:10px 0 0; font-size:12px; color:var(--ink3); }

  .arow { display:flex; align-items:center; gap:16px; padding:16px 20px; }
  .arow + .arow { border-top:1px solid var(--line); }
  .arow .g { width:36px; height:36px; border-radius:8px; background:var(--tint); display:flex; align-items:center; justify-content:center; flex:none; }
  .arow .g svg { width:18px; height:18px; }
  .arow .k { flex:1; min-width:0; }
  .arow .k b { font-weight:500; display:block; }
  .arow .k span { font-size:13px; color:var(--ink2); }
  .arow .st { font-size:13px; display:flex; align-items:center; gap:8px; white-space:nowrap; }
  .arow .st i { width:8px; height:8px; border-radius:50%; background:var(--none); display:inline-block; }
  .arow .st i.ok { background:var(--ok); } .arow .st i.bad { background:var(--bad); } .arow .st i.wait { background:var(--wait); }
  .arow .dis { font-size:13px; color:var(--ink3); background:none; border:0; cursor:pointer; padding:4px 0; }
  .arow .dis:hover { color:var(--bad); }

  .timeline { position:relative; padding:8px 20px 8px 44px; }
  .timeline::before { content:""; position:absolute; left:25px; top:18px; bottom:18px; width:2px; background:var(--line); }
  .entry { position:relative; display:flex; gap:14px; align-items:baseline; padding:9px 0; font-size:14px; }
  .entry::before { content:""; position:absolute; left:-24px; top:15px; width:10px; height:10px; border-radius:50%; background:var(--card); border:2px solid var(--ink3); }
  .entry.ok::before { border-color:var(--ok); background:var(--ok); } .entry.bad::before { border-color:var(--bad); background:var(--bad); } .entry.wait::before { border-color:var(--wait); background:var(--wait); }
  .entry .k { flex:1; } .entry .k b { font-weight:500; margin-right:8px; } .entry .k span { color:var(--ink2); }
  .entry .t { color:var(--ink3); font-size:12px; white-space:nowrap; }
  .dl { padding:12px 20px 16px; font-size:13px; border-top:1px solid var(--line); }
  .doctrine { margin:48px 0 0; text-align:center; font-size:13px; color:var(--ink2); }

  @media (max-width:1100px) { .layout { grid-template-columns:1fr; } .index { display:none; } }
  @media (max-width:720px) {
    .wrap { padding:0 20px; }
    #lock .body { padding:0 20px 100px; justify-content:flex-start; padding-top:24px; }
    .stage { perspective:none; width:100%; } .stage::before { display:none; } .frame { height:auto; aspect-ratio:auto; width:100%; transform:none !important; box-shadow:0 24px 60px -30px rgba(0,0,0,.5); } .frame .inner .loop, .frame .panel { transform:none; } .frame .tool { grid-template-columns:1fr; height:auto; } .frame .mrail, .frame .mhead, .frame .mrows, .frame .mtotals, .frame .mtop .gauge { display:none; } .frame .mtop { grid-template-columns:1fr; padding-bottom:16px; } .frame .mtop .verdict { font-size:22px; } .frame .screen { position:relative; } .frame .inner { position:relative; width:auto; height:auto; transform:none; padding:0; } .frame .inner .loop { display:none; } .frame .inner .status { grid-template-columns:1fr; gap:18px; } .frame .inner .ring { width:110px; height:110px; margin:0 auto; } .frame .inner .ring .center { font-size:32px; } .frame .inner .verdict { font-size:26px; } .frame .inner .meta { display:none; }
    .arow { display:grid; grid-template-columns:36px 1fr auto; row-gap:6px; } .arow .st { grid-column:2 / -1; } .arow .dis { grid-column:2 / -1; text-align:left; }
    #lock .btn.big { position:fixed; left:20px; right:20px; bottom:24px; height:52px; margin:0; } .frame .glow { display:none; } .frame .mhead, .frame .mrows, .frame .mtotals, .frame .bridge { display:none; }
    h1.big { font-size:32px; } .verdict { font-size:30px; }
    .status { grid-template-columns:1fr; gap:24px; } .ring { width:140px; height:140px; margin:0 auto; } .ring .center { font-size:40px; }
    .loop { grid-template-columns:1fr; } .loop::before { display:none; } .loop .cell + .cell { border-left:0; border-top:1px solid var(--line); }
    .crow { grid-template-columns:1fr auto; height:auto; padding:12px 20px; row-gap:4px; } .crow .sides { grid-column:1 / -1; font-size:13px; }
    .ok-card { flex-direction:column; align-items:stretch; } .ok-card .acts { flex-direction:column-reverse; } .ok-card .acts .btn { width:100%; }
    .figures { grid-template-columns:1fr; } .figure + .figure { border-left:0; border-top:1px solid var(--line); }
    .bar .acts .txt { display:none; }
  }
`;

const JS = String.raw`
(function () {
  var NAMES = (window.AKESO && window.AKESO.scenarioNames) || {};
  var NOW = Date.now();
  var FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function when(iso) { var t = Date.parse(iso || ""); return isFinite(t) ? FMT.format(t) : ""; }
  function ago(iso) { var t = Date.parse(iso || ""); if (!isFinite(t)) return ""; var m = Math.round((NOW - t) / 60000); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; var h = Math.round(m / 60); if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago"); return Math.round(h / 24) + " days ago"; }
  function money(n) { return typeof n === "number" && isFinite(n) ? "$" + n.toFixed(2) : ""; }
  function $(id) { return document.getElementById(id); }
  function cap(s) { s = String(s || "").replace(/_/g, " "); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  var DASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 12h10"/></svg>';
  var LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M15 7l3 3M18 4l2 2"/></svg>';
  var ICONS = { ok: CHECK, bad: CROSS, wait: DASH };

  /* ---------------- fold a ledger into what the page needs ---------------- */
  function fold(L) {
    function kinds(k) { return L.filter(function (e) { return e.kind === k; }); }
    function last(k) { var a = kinds(k); return a.length ? a[a.length - 1] : null; }
    var f = {};
    f.check = last("check"); f.fix = last("fix"); f.sweep = last("sweep"); f.cert = last("certify");
    f.ranLive = !!(f.check && (f.check.lifecycleGrade || f.check.sandboxGrade));
    f.grade = f.check ? (f.check.grade || null) : null;
    f.passing = f.grade === "A";
    f.provenFix = !!(f.fix && f.check && f.check.seq > f.fix.seq && f.passing);
    f.accounts = (f.sweep && Array.isArray(f.sweep.accounts)) ? f.sweep.accounts : [];
    f.matched = f.sweep && f.sweep.comparison && f.sweep.comparison.counts ? (f.sweep.comparison.counts.matched || 0) : 0;
    f.scenarios = (f.check && f.check.scenarioResults) || [];
    f.failed = f.scenarios.filter(function (r) { return r.outcome === "fail"; }).length;
    f.passed = f.scenarios.filter(function (r) { return r.outcome === "pass"; }).length;
    f.notGraded = f.scenarios.length - f.passed - f.failed;
    f.restores = kinds("restore");
    f.restored = f.restores.filter(function (e) { return e.direction === "grant" && e.result === "applied"; });
    f.restoredFor = {}; f.restored.forEach(function (e) { if (e.verified) f.restoredFor[e.account] = e; });
    f.removed = f.restores.filter(function (e) { return e.direction === "remove" && e.result === "applied"; });
    f.unconfirmed = f.restores.filter(function (e) { return e.result === "applied" && !e.verified; });
    var sweeps = kinds("sweep").filter(function (e) { return e.comparison && !e.couldNotRun; });
    f.lastGood = sweeps.length ? sweeps[sweeps.length - 1] : null;
    f.covered = !!(f.cert && f.cert.policy);
    var appr = {};
    kinds("approval").forEach(function (e) {
      if (!e.id) return;
      var r = appr[e.id] || (appr[e.id] = { id: e.id, state: "queued" });
      if (e.state === "queued") { Object.assign(r, e, { state: r.state === "queued" ? "queued" : r.state }); }
      else if (e.state === "approved" || e.state === "cancelled") { if (r.state === "queued") r.state = e.state; }
    });
    f.waiting = Object.values(appr).filter(function (r) { if (r.state !== "queued") return false; var q = Date.parse(r.queuedAt || ""); return !(isFinite(q) && NOW - q > 7 * 86400000); }).map(function (r) { var ready = Date.parse(r.readyAt || ""); r.ready = isFinite(ready) && NOW >= ready; return r; });
    f.queuedFor = {}; f.waiting.forEach(function (r) { f.queuedFor[r.account] = r; });
    f.fixedSince = function (a) { var e = f.restoredFor[a.account]; return !!(e && f.sweep && Date.parse(e.at || "") >= Date.parse(f.sweep.at || "")); };
    f.stillWrong = f.accounts.filter(function (a) { return (a.verdict === "locked_out" && !f.fixedSince(a)) || a.verdict === "still_entitled"; });
    f.fixedNow = f.accounts.filter(function (a) { return a.verdict === "locked_out" && f.fixedSince(a); });
    f.noVerdict = f.accounts.filter(function (a) { return a.verdict === "no_conclusion"; });
    f.notInStripe = f.accounts.filter(function (a) { return a.verdict === "no_subscription"; });
    f.agreeing = Math.max(0, f.matched - f.stillWrong.length - f.fixedNow.length);
    f.states = {
      check: f.ranLive ? "done" : f.check ? "partial" : "todo",
      fix: f.provenFix ? "done" : (f.fix && !f.passing) ? "failed" : f.fix ? "partial" : (f.ranLive && !f.passing) ? "next" : (f.ranLive && f.passing) ? "notneeded" : "todo",
      monitor: (f.sweep && !f.sweep.couldNotRun && f.matched > 0) ? "done" : (f.sweep && !f.sweep.couldNotRun) ? "nothing" : f.sweep ? "failed" : (f.passing || f.provenFix) ? "next" : "todo"
    };
    f.tone = {
      check: f.states.check === "done" ? (f.passing ? "ok" : f.grade === "?" ? "" : "bad") : f.states.check === "partial" ? "wait" : "",
      fix: f.states.fix === "done" ? "ok" : f.states.fix === "failed" ? "bad" : f.states.fix === "partial" ? "wait" : "",
      monitor: f.states.monitor === "done" ? (f.stillWrong.length ? "wait" : "ok") : f.states.monitor === "failed" ? "bad" : ""
    };
    f.lastAt = L.length ? L[L.length - 1].at : null;
    var s = f, g = s.grade, n = s.scenarios.length;
    if (!s.check) f.step = { h: "Not checked yet.", w: "", m: DASH, tone: "", arc: 0, sub: "not run", action: null };
    else if (!s.ranLive) f.step = { h: "Code read. Not yet run.", w: "Run it against your running app to get a grade.", m: DASH, tone: "", arc: .15, sub: "read only", action: null, cmd: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (g && g !== "A" && g !== "?") f.step = (s.fix && s.fix.seq > s.check.seq) ? { h: "Fix applied. The Check still fails.", w: "", m: esc(g), tone: "bad", arc: s.passed / Math.max(1, n), sub: s.failed + " of " + n + " fail", cmd: "npx akeso-check fix --show" } : { h: "Grade " + g + ". " + s.failed + " of " + n + " situations fail.", w: "", m: esc(g), tone: "bad", arc: s.passed / Math.max(1, n), sub: s.failed + " of " + n + " fail", cmd: "npx akeso-check fix" };
    else if (g === "?") f.step = { h: "The Check could not finish. No grade.", w: "Start the app and run it again.", m: "?", tone: "", arc: 0, sub: "no grade", cmd: "npx akeso-check --lifecycle-url http://localhost:3000" };
    else if (s.sweep && s.sweep.couldNotRun) f.step = { h: "The last customer check could not run.", w: String(s.sweep.couldNotRun).replace(/\s+/g, " ").slice(0, 140), m: "?", tone: "", arc: 0, sub: "no verdict", cmd: "npx akeso-check monitor" };
    else if (s.sweep && s.matched === 0) f.step = { h: "No account could be compared.", w: "Stripe and your app use different customer ids. Pass your account id as client_reference_id at checkout.", m: "?", tone: "", arc: 0, sub: "0 compared", cmd: "npx akeso-check monitor" };
    else if (s.sweep && s.waiting.length) f.step = { h: plural(s.waiting.length, "removal needs", "removals need") + " your OK.", w: "", m: String(s.waiting.length), tone: "wait", arc: 1, sub: "waiting", action: { label: s.waiting.length === 1 ? "Review the removal" : "Review the removals", href: "#ok" }, cmd: "npx akeso-check approvals" };
    else if (s.sweep) f.step = s.stillWrong.length === 0 ? { h: "Stripe and your app agree.", w: "", m: CHECK, tone: "ok", arc: 1, sub: s.matched + " agree", cmd: "npx akeso-check statement" } : { h: plural(s.stillWrong.length, "account disagrees", "accounts disagree") + " with Stripe.", w: "", m: String(s.stillWrong.length), tone: "wait", arc: s.agreeing / Math.max(1, s.matched), sub: "of " + s.matched, cmd: "npx akeso-check monitor" };
    else f.step = { h: s.provenFix ? "The fix passed its re-test." : "Your billing code passes.", w: "Now compare today's customers with Stripe.", m: esc(g), tone: "ok", arc: 1, sub: "grade", cmd: "npx akeso-check monitor" };
    return f;
  }

  /* ---------------- pieces ---------------- */
  function ringHTML(id, step, busy) {
    return '<div class="ring ' + (busy ? "busy" : (step.tone || "none")) + '" id="' + id + '" style="--arc:' + Math.round((step.arc || 0) * 471) + '"><svg viewBox="0 0 160 160"><circle class="track" cx="80" cy="80" r="70"/><circle class="arc" cx="80" cy="80" r="70"/></svg><div class="center">' + (busy ? "" : step.m + (step.sub ? "<small>" + esc(step.sub) + "</small>" : "")) + "</div></div>";
  }
  function statusHTML(f, opts) {
    var st = f.step, hosted = opts.hosted, busy = opts.busy;
    var act = "";
    if (!busy) {
      if (st.action) act = '<div class="act"><a class="btn" href="' + st.action.href + '">' + esc(st.action.label) + "</a></div>";
      else if (!hosted && st.cmd) act = '<div class="act"><span class="cmd"><code>' + esc(st.cmd) + '</code><button class="link" data-copy="' + esc(st.cmd) + '">Copy</button></span></div>';
    }
    return '<div class="status"><div><p class="eyebrow">Right now</p><h1 class="verdict" id="verdict">' + esc(busy ? "Checking " + opts.app + "." : st.h) + "</h1>" + (busy ? '<p class="lead">About a minute.</p>' : st.w ? '<p class="lead">' + esc(st.w) + "</p>" : "") + act + (f.lastAt && !busy ? '<p class="meta">Last checked ' + esc(ago(f.lastAt)) + "</p>" : "") + "</div>" + ringHTML(opts.ringId || "ring", st, busy) + "</div>";
  }
  function loopHTML(f, busy, plain) {
    function node(id) { var t = f.tone[id]; var s = f.states[id]; var icon = ICONS[t] || (s === "notneeded" || s === "nothing" ? DASH : ""); var cls = t || (s === "next" ? "next" : ""); if (busy && id === "check") cls = "busy", icon = ""; return '<span class="node ' + cls + '" aria-hidden="true">' + icon + "</span>"; }
    var tiles = '<div class="tiles">' + (f.scenarios.length ? f.scenarios.map(function (r) { return '<span class="tile ' + (r.outcome === "pass" ? "ok" : r.outcome === "fail" ? "bad" : "") + '" title="' + esc(NAMES[r.id] || r.id) + '"></span>'; }).join("") : "<span class=tile></span>".repeat(10)) + "</div>";
    var files = f.fix ? (f.fix.files || []) : [];
    var chips = '<div class="chips">' + (files.length ? files.slice(0, 6).map(function (x) { return '<span class="chip ' + esc(x.action || "") + '" title="' + esc(x.path) + '">' + esc((x.path || "").split("/").pop()) + "</span>"; }).join("") + (files.length > 6 ? '<span class="chip">+' + (files.length - 6) + "</span>" : "") : '<span class="chip" style="opacity:.45">webhook handler</span><span class="chip" style="opacity:.45">entitlement</span>') + "</div>";
    var dl = [];
    f.stillWrong.forEach(function (a) { dl.push(a.verdict === "locked_out" ? "bad" : "wait"); });
    f.fixedNow.forEach(function () { dl.push("ok"); });
    for (var i = 0; i < Math.min(f.agreeing, 120); i++) dl.push("ok");
    f.noVerdict.forEach(function () { dl.push("none"); }); f.notInStripe.forEach(function () { dl.push("none"); });
    var dots = f.sweep && f.matched > 0 ? '<div><div class="dots">' + dl.map(function (d) { return '<i class="' + d + '"></i>'; }).join("") + '</div><div class="legend"><span><i></i>' + (f.agreeing + f.fixedNow.length) + " agree</span>" + (f.stillWrong.length ? '<span><i class="wait"></i>' + f.stillWrong.length + " disagree</span>" : "") + (f.noVerdict.length + f.notInStripe.length ? '<span><i class="none"></i>' + (f.noVerdict.length + f.notInStripe.length) + " no verdict</span>" : "") + "</div></div>" : '<div class="dots">' + '<i class="none"></i>'.repeat(20) + "</div>";
    var checkState = busy ? "Running" : f.ranLive ? (f.grade === "?" ? "No grade" : "Grade " + esc(f.grade) + " · " + f.passed + " of " + f.scenarios.length + " passed") : f.check ? "Code read, not run" : "Not run";
    var fixState = f.provenFix ? plural(files.length, "file", "files") + " · re-test passed" : (f.fix && !f.passing) ? "Applied · re-test failed" : f.fix ? "Applied · not re-tested" : f.states.fix === "notneeded" ? "Not needed" : f.states.fix === "next" ? "Next" : "Not yet";
    var monState = f.states.monitor === "done" ? f.matched + " compared · " + (f.stillWrong.length ? plural(f.stillWrong.length, "disagrees", "disagree") : "all agree") : f.states.monitor === "failed" ? "Could not run" : f.states.monitor === "nothing" ? "Nothing to compare" : f.states.monitor === "next" ? "Next" : "Not yet";
    return '<div class="card loop" id="loop">' +
      '<div class="cell" data-cell="check"><div class="head">' + node("check") + '<div><div class="name">Check</div><div class="state">' + checkState + '</div></div></div><div class="vis">' + tiles + "</div>" + (f.scenarios.length && !plain ? '<div class="more"><button class="link" data-drawer="check">Details</button></div>' : "") + "</div>" +
      '<div class="cell" data-cell="fix"><div class="head">' + node("fix") + '<div><div class="name">Fix</div><div class="state">' + fixState + '</div></div></div><div class="vis">' + chips + "</div>" + (files.length && !plain ? '<div class="more"><button class="link" data-drawer="fix">Details</button></div>' : "") + "</div>" +
      '<div class="cell" data-cell="monitor"><div class="head">' + node("monitor") + '<div><div class="name">Monitor</div><div class="state">' + monState + '</div></div></div><div class="vis">' + dots + "</div>" + (f.accounts.length && !plain ? '<div class="more"><button class="link" data-drawer="monitor">Details</button></div>' : "") + "</div>" +
      "</div>";
  }
  function drawerHTML(f, which) {
    if (which === "check") return "<ul>" + f.scenarios.map(function (r) { var o = r.outcome; return '<li class="' + (o === "pass" ? "ok" : o === "fail" ? "bad" : "") + '"><span>' + esc(NAMES[r.id] || r.id) + "</span><b>" + (o === "pass" ? "Passed" : o === "fail" ? "Failed" : o === "reported" ? "Not graded" : esc(cap(o))) + "</b></li>"; }).join("") + "</ul>";
    if (which === "fix") return "<ul>" + (f.fix.files || []).map(function (x) { return "<li><span class=mono>" + esc(x.path || "") + "</span><b>" + esc(cap(x.action || "")) + "</b></li>"; }).join("") + "</ul>";
    return "<ul>" + f.accounts.map(function (a) { return "<li><span class=mono>" + esc(a.account) + "</span><span>Stripe: " + esc(stripeWord(a)) + " · App: " + esc(appWord(f, a)) + "</span><b>" + esc(meaning(f, a)) + "</b></li>"; }).join("") + "</ul>";
  }
  function stripeWord(a) { return a.stripe == null ? "No subscription" : a.stripe === "incomplete_expired" ? "Expired" : cap(a.stripe); }
  function appWord(f, a) { return f.fixedSince(a) ? "Has access" : a.app == null ? "Unknown" : a.app ? "Has access" : "No access"; }
  function meaning(f, a) {
    if (a.verdict === "locked_out") return f.fixedSince(a) ? "Restored" : "Locked out";
    if (a.verdict === "still_entitled") return f.queuedFor[a.account] ? "Needs your OK" : "Still has access";
    if (a.verdict === "no_conclusion") return "No verdict";
    if (a.verdict === "no_subscription") return "Left alone";
    return "Agree";
  }
  function toneFor(f, a) { return a.verdict === "locked_out" ? (f.fixedSince(a) ? "ok" : "bad") : a.verdict === "still_entitled" ? "wait" : a.verdict === "agree" ? "ok" : ""; }
  function customersHTML(f, filter) {
    var groups = { disagree: f.stillWrong, restored: f.fixedNow, noverdict: f.noVerdict.concat(f.notInStripe) };
    var all = f.stillWrong.concat(f.fixedNow, f.noVerdict, f.notInStripe);
    var list = filter === "all" ? all : (groups[filter] || all);
    var filters = '<div class="filters">' + [["disagree", "Disagree", f.stillWrong.length], ["restored", "Restored", f.fixedNow.length], ["noverdict", "No verdict", f.noVerdict.length + f.notInStripe.length], ["all", "All", f.matched]].map(function (x) { return '<button data-filter="' + x[0] + '"' + (filter === x[0] ? ' class="on"' : "") + ">" + x[1] + " " + x[2] + "</button>"; }).join("") + "</div>";
    var rows = list.map(function (a) { var t = toneFor(f, a); var price = money(a.priceMonthly); return '<div class="crow ' + t + '"><span class="mono">' + esc(a.account) + '</span><span class="sides"><b>Stripe: ' + esc(stripeWord(a)) + '</b><span class="tie ' + (t === "ok" ? "ok" : t ? t : "") + '">' + (t === "ok" ? "=" : t ? "&ne;" : "?") + "</span><b>App: " + esc(appWord(f, a)) + "</b></span><span>" + esc(meaning(f, a)) + '</span><span class="price">' + (price ? price + "/mo" : "") + "</span></div>"; }).join("");
    if (filter === "all" && f.agreeing > 0) rows += '<div class="crow dim"><span>' + f.agreeing + " more</span><span class=\"sides\">Stripe and your app agree</span><span></span><span></span></div>";
    if (!rows) rows = '<div class="empty">' + (f.sweep && f.matched > 0 ? "Nothing here." : f.sweep ? "Nothing to compare." : "No customer check yet.") + "</div>";
    return filters + rows;
  }
  function okHTML(f, hosted) {
    if (!f.waiting.length) return '<p class="quiet">Nothing needs your OK.</p>';
    return f.waiting.map(function (r) {
      return '<div class="card ok-card" data-ok="' + esc(r.id) + '"><div class="k"><div class="id mono">' + esc(r.account) + '</div><p class="why">Canceled in Stripe, still has access' + (typeof r.priceMonthly === "number" ? " · " + money(r.priceMonthly) + "/mo" : "") + (r.ready ? "" : " · held until " + esc(when(r.readyAt))) + '</p></div><div class="acts">' + (hosted ? '<button class="btn sec" data-keep>Keep access</button><button class="btn danger" data-remove>Remove access</button>' : '<span class="cmd"><code>' + esc("npx akeso-check approvals --approve " + r.id) + '</code><button class="link" data-copy="' + esc("npx akeso-check approvals --approve " + r.id) + '">Copy</button></span>') + "</div></div>";
    }).join("");
  }
  function figuresHTML(f) {
    var unpaid = f.lastGood ? (Number(f.lastGood.comparison.monthlyExposure) || 0) : null;
    return '<div class="card figures">' +
      '<div class="figure"><div class="n' + (f.restored.length ? " ok" : "") + '">' + f.restored.length + '</div><div class="l">Access restored' + (f.unconfirmed.length ? " · " + f.unconfirmed.length + " not yet confirmed" : "") + "</div></div>" +
      '<div class="figure"><div class="n">' + f.removed.length + '</div><div class="l">Access removed</div></div>' +
      '<div class="figure"><div class="n' + (unpaid > 0 ? " wait" : "") + '">' + (unpaid == null ? "–" : money(unpaid)) + '</div><div class="l">Unpaid access, per month' + (unpaid == null ? " · no check yet" : "") + "</div></div>" +
      '</div><p class="note">Revenue recovered: not measured.</p>';
  }
  function accessHTML(f, D) {
    var hosted = D.hosted, c = D.connections || {};
    var fw = f.check && (f.check.framework || (f.check.detection && f.check.detection.framework));
    function row(g, name, sub, tone, state, prov) { return '<div class="arow"><div class="g">' + g + '</div><div class="k"><b>' + name + "</b><span>" + sub + '</span></div><div class="st"><i class="' + tone + '"></i>' + state + "</div>" + (hosted && prov ? '<button class="dis" data-disconnect="' + prov + '">Disconnect</button>' : "") + "</div>"; }
    if (hosted && !D.demo) {
      return '<div class="card">' +
        row(EYE, "Stripe", "Akeso reads your subscriptions. It never changes anything in Stripe.", c.stripe ? "ok" : "", c.stripe ? (c.stripe === "preview" ? "Connected (preview)" : "Connected") : "Not connected", "stripe") +
        row(KEY, "Your code", "Read on GitHub. Fixes arrive as a pull request you approve.", c.github ? "ok" : "", c.github ? (c.github === "preview" ? "Connected (preview)" : "Connected") : "Not connected", "github") +
        row(LOCK, "Your customers", "Which accounts have paid access, read from Supabase.", c.supabase ? "ok" : "", c.supabase ? (c.supabase === "preview" ? "Connected (preview)" : "Connected") : "Not connected", "supabase") + "</div>";
    }
    return '<div class="card">' +
      row(LOCK, "Your computer", "Your code, keys and results stay here.", "ok", "Nothing leaves") +
      row(EYE, "Stripe", "Akeso reads your subscriptions. It never changes anything in Stripe.", f.sweep && !f.sweep.couldNotRun ? "ok" : f.sweep ? "bad" : "", f.sweep && !f.sweep.couldNotRun ? "Connected" : f.sweep ? "Last read failed" : "Not yet read") +
      row(KEY, "Your app" + (fw ? ' <span style="font-weight:400;color:var(--ink3)">' + esc(cap(String(fw).replace(/-/g, " "))) + "</span>" : ""), "Two signed endpoints. Delete one file to revoke.", f.covered ? "ok" : f.fix ? "wait" : "", f.covered ? "Rules confirmed" : f.fix ? "Rules not confirmed" : "Not connected") + "</div>";
  }
  function historyHTML(L, D) {
    var rows = L.length ? L.slice().reverse().map(function (e) {
      var t = e.kind === "check" ? (e.grade === "A" ? "ok" : e.grade && e.grade !== "?" ? "bad" : "") : e.kind === "fix" ? "wait" : e.kind === "sweep" ? (e.couldNotRun ? "bad" : e.comparison && e.comparison.clean ? "ok" : "wait") : e.kind === "restore" ? (e.result === "applied" ? "ok" : "bad") : e.kind === "approval" ? "wait" : e.kind === "certify" ? "ok" : e.kind === "unreadable" ? "bad" : "";
      var word = { check: "Checked", fix: "Fixed", sweep: "Compared customers", restore: e.direction === "grant" ? "Access restored" : "Access removed", approval: e.state === "queued" ? "Needs your OK" : e.state === "approved" ? "Removal approved" : "Removal canceled", certify: "Rules confirmed", unreadable: "Line " + e.line }[e.kind] || cap(e.kind);
      var sum = e.kind === "check" ? (e.grade ? "Grade " + e.grade : "Code read") : e.kind === "fix" ? plural((e.files || []).length, "file", "files") : e.kind === "sweep" ? (e.couldNotRun ? "Could not run" : (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "")) : e.kind === "restore" ? (e.account || "") + (e.result === "applied" ? "" : " · " + e.result) : e.kind === "approval" ? (e.account || "") : e.kind === "unreadable" ? "Could not read" : "";
      return '<div class="entry ' + t + '"><div class="k"><b>' + esc(word) + "</b><span>" + esc(sum) + '</span></div><div class="t">' + esc(when(e.at)) + "</div></div>";
    }).join("") : '<div class="entry"><div class="k"><span>Nothing yet.</span></div></div>';
    return '<div class="card"><div class="timeline">' + rows + '</div><div class="dl">' + (D.root ? '<span class="quiet">' + esc(D.root) + "/.akeso/ledger.jsonl</span>" : L.length ? '<button class="link" id="download">Download the results file</button>' : "") + "</div></div>";
  }

  /* ---------------- render ---------------- */
  var drawerOpen = null, filter = "disagree";
  function render() {
    var D = window.AKESO || {};
    var onboarding = !!D.onboarding;
    var screen = onboarding ? (D.screen || "lock") : "page";
    ["lock", "connect", "paste"].forEach(function (id) { var el = $(id); if (el) el.hidden = screen !== id; });
    $("page").hidden = onboarding;
    var L = Array.isArray(D.ledger) ? D.ledger.filter(function (e) { return e && typeof e === "object"; }) : [];
    var conns = D.connections || {};
    var nConn = ["stripe", "github", "supabase"].filter(function (k) { return conns[k] && conns[k] !== "waiting"; }).length;

    /* lock: the frame shows the product, from the demo ledger, live */
    var frame = $("frameInner");
    if (frame && !frame.dataset.done) {
      var df = fold(D.demoLedger || []), st0 = df.step;
      var tiles0 = '<div class="tiles">' + df.scenarios.map(function (r) { return '<span class="tile ' + (r.outcome === "pass" ? "ok" : r.outcome === "fail" ? "bad" : "") + '"></span>'; }).join("") + "</div>";
      var dl0 = []; df.stillWrong.forEach(function (a) { dl0.push(a.verdict === "locked_out" ? "bad" : "wait"); }); df.fixedNow.forEach(function () { dl0.push("ok"); }); for (var q = 0; q < Math.min(df.agreeing, 120); q++) dl0.push("ok"); df.noVerdict.forEach(function () { dl0.push("none"); }); df.notInStripe.forEach(function () { dl0.push("none"); });
      var dots0 = '<div class="dots">' + dl0.map(function (d) { return '<i class="' + d + '"></i>'; }).join("") + '</div><div class="legend"><span><i></i>' + (df.agreeing + df.fixedNow.length) + " agree</span>" + (df.stillWrong.length ? '<span><i class="wait"></i>' + df.stillWrong.length + " disagree</span>" : "") + "</div>";
      function mrow(a) { var t = toneFor(df, a) || "none"; return '<div class="mrow ' + t + '"><i></i><span class="mono">' + esc(a.account) + '</span><span class="mono dim">' + esc(a.stripe == null ? "None" : stripeWord(a)) + '</span><span class="tie">' + (t === "ok" ? "=" : t === "none" ? "?" : "&ne;") + '</span><span class="mono dim">' + esc(appWord(df, a)) + '</span><span class="word">' + esc(meaning(df, a)) + '</span><span class="mono dim r">' + (money(a.priceMonthly) ? esc(money(a.priceMonthly)) + "/mo" : "") + "</span></div>"; }
      var attention = df.stillWrong.concat(df.fixedNow, df.noVerdict, df.notInStripe);
      var moreRow = df.agreeing > 0 ? '<div class="mrow ok dimrow"><i></i><span class="mono">+' + df.agreeing + ' more</span><span class="mono dim">Active</span><span class="tie">=</span><span class="mono dim">Has access</span><span class="word">Agree</span><span></span></div>' : "";
      var unpaid0 = df.lastGood ? (Number(df.lastGood.comparison.monthlyExposure) || 0) : 0;
      var VIEWS = {
        status: function () {
          var N = 18, W = 900, H = 150, lines = "", dotsL = "", dotsR = "";
          for (var i = 0; i < N; i++) {
            var y = 10 + i * ((H - 20) / (N - 1)), kind = i === 4 ? "wait" : i === 11 ? "ok restored" : "ok";
            var d = "M 14 " + y.toFixed(1) + " C 300 " + y.toFixed(1) + ", 600 " + y.toFixed(1) + ", " + (W - 14) + " " + y.toFixed(1);
            lines += '<path class="ln ' + kind + '" data-i="' + i + '" d="' + d + '" style="--i:' + i + '"/>';
            dotsL += '<circle class="pt l ' + (kind === "wait" ? "off" : "") + '" cx="14" cy="' + y.toFixed(1) + '" r="3.2"/>';
            dotsR += '<circle class="pt r" cx="' + (W - 14) + '" cy="' + y.toFixed(1) + '" r="3.2"/>';
          }
          return '<div class="bridge"><div class="rails"><span>Stripe</span><span>' + df.matched + ' customers</span><span>Your app</span></div><svg viewBox="0 0 ' + W + ' ' + H + '" id="bridge" aria-hidden="true">' + lines + dotsL + dotsR + '<circle class="pulse" id="pulse" r="4" cx="-10" cy="-10"/></svg><p class="event" id="event"></p></div>' +
            '<div class="mtop"><div><h1 class="verdict" style="font-size:20px">' + esc(st0.h) + '</h1>' + (st0.action ? '<div class="act"><span class="btn" data-mini="ok">' + esc(st0.action.label) + "</span></div>" : "") + '<p class="meta"><i></i>Checked just now · next in <span class="mono" id="countdown">58:00</span></p></div></div>' +
          '<div class="mtotals"><span><b class="ok" id="tRestored">' + df.restored.length + '</b> restored</span><span><b>' + df.removed.length + '</b> removed</span><span><b class="wait">' + esc(money(unpaid0)) + '</b> unpaid / mo</span><span class="link" data-mini="customers" style="margin-left:auto">All customers</span></div>'; },
        customers: function () { return '<div class="mhead" style="border-top:0;padding-top:4px"><span>Customers · ' + df.matched + ' compared</span></div><div class="mrows">' + attention.slice(0, 6).map(mrow).join("") + moreRow + "</div>"; },
        ok: function () { return '<h1 class="verdict" style="font-size:22px;margin-bottom:14px">Needs your OK</h1>' + df.waiting.map(function (r) { return '<div class="mcard"><div><div class="mono" style="font-size:18px;font-weight:600">' + esc(r.account) + '</div><div class="dim" style="font-size:12px;margin-top:4px">Canceled in Stripe, still has access · ' + esc(money(r.priceMonthly)) + '/mo</div></div><div class="macts"><span class="btn sec">Keep access</span><span class="btn danger">Remove access</span></div></div>'; }).join("") + '<p class="dim" style="font-size:12px;margin-top:14px">Akeso never removes access on its own.</p>'; },
        totals: function () { return '<h1 class="verdict" style="font-size:22px;margin-bottom:14px">Totals</h1><div class="mfigs"><div><b class="ok">' + df.restored.length + '</b><span>Access restored</span></div><div><b>' + df.removed.length + '</b><span>Access removed</span></div><div><b class="wait">' + esc(money(unpaid0)) + '</b><span>Unpaid access, per month</span></div></div><p class="dim" style="font-size:12px;margin-top:14px">Revenue recovered: not measured.</p>'; },
        access: function () { return '<h1 class="verdict" style="font-size:22px;margin-bottom:14px">Access</h1><div class="mrows">' + [["Stripe", "Reads subscriptions. Never changes anything in Stripe.", "Connected"], ["Your code", "On GitHub. Fixes arrive as a pull request you approve.", "Connected"], ["Your customers", "Which accounts have paid access, read from Supabase.", "Connected"]].map(function (x) { return '<div class="mrow ok" style="grid-template-columns:8px 120px 1fr 90px 80px"><i></i><span>' + x[0] + '</span><span class="dim">' + x[1] + '</span><span class="word">' + x[2] + '</span><span class="dim r" style="font-size:11px">Disconnect</span></div>'; }).join("") + "</div>"; },
        history: function () { return '<h1 class="verdict" style="font-size:22px;margin-bottom:14px">History</h1><div class="mrows">' + (D.demoLedger || []).slice().reverse().slice(0, 6).map(function (e) { var word = { check: "Checked", fix: "Fixed", sweep: "Compared customers", restore: "Access restored", approval: "Needs your OK", certify: "Rules confirmed" }[e.kind] || cap(e.kind); var t = e.kind === "check" ? (e.grade === "A" ? "ok" : "bad") : e.kind === "fix" ? "wait" : e.kind === "sweep" ? "wait" : e.kind === "restore" ? "ok" : e.kind === "approval" ? "wait" : "ok"; var sum = e.kind === "check" ? "Grade " + e.grade : e.kind === "fix" ? plural((e.files || []).length, "file", "files") : e.kind === "sweep" ? (e.comparison && e.comparison.counts ? e.comparison.counts.matched + " compared" : "") : e.account || ""; return '<div class="mrow ' + t + '" style="grid-template-columns:8px 160px 1fr 110px"><i></i><span>' + esc(word) + '</span><span class="dim">' + esc(sum) + '</span><span class="dim r mono">' + esc(when(e.at)) + "</span></div>"; }).join("") + "</div>"; }
      };
      var NAV = [["status", "Status"], ["customers", "Customers"], ["ok", "Needs your OK"], ["totals", "Totals"], ["access", "Access"], ["history", "History"]];
      window.__mini = function (view) {
        if (!VIEWS[view]) view = "status";
        var crumb = NAV.filter(function (n) { return n[0] === view; })[0][1];
        frame.innerHTML = '<div class="chrome"><b><i></i>' + esc(crumb) + '</b><span class="seal">Verified · just now</span></div>' +
          '<div class="tool"><nav class="mrail">' + NAV.map(function (n) { return '<span data-mini="' + n[0] + '"' + (n[0] === view ? ' class="on"' : "") + "><i></i>" + n[1] + "</span>"; }).join("") + "</nav>" +
          '<div class="mcontent">' + VIEWS[view]() + "</div></div>";
        Array.prototype.forEach.call(frame.querySelectorAll(".mcontent > *"), function (el, i) { el.style.setProperty("--i", i); });
        Array.prototype.forEach.call(frame.querySelectorAll(".mrow"), function (el, i) { el.style.setProperty("--i", i); });
      };
      window.__mini("status");
      window.__restoredExtra = 0;
      (function () {
        var busy = false;
        function tick() {
          var svg = $("bridge"); if (!svg || busy || document.hidden) return;
          var ok = Array.prototype.filter.call(svg.querySelectorAll(".ln.ok:not(.restored)"), function () { return true; });
          if (!ok.length) return;
          var ln = ok[Math.floor(Math.random() * ok.length)], i = +ln.dataset.i, dotR = svg.querySelectorAll(".pt.r")[i], pulse = $("pulse");
          busy = true;
          ln.classList.remove("ok"); ln.classList.add("bad"); dotR.classList.add("off");
          var ev0 = $("event"); if (ev0) { ev0.textContent = "acct_" + (2000 + i * 137 % 7000) + " is paying but locked out"; ev0.classList.add("on"); }
          setTimeout(function () {
            if (!ln.isConnected) { busy = false; return; }
            var len = ln.getTotalLength(), t0 = performance.now(), dur = 700;
            (function move(now) { var k = Math.min(1, (now - t0) / dur); var p = ln.getPointAtLength(len * k); pulse.setAttribute("cx", p.x); pulse.setAttribute("cy", p.y); pulse.style.opacity = "1"; if (k < 1) requestAnimationFrame(move); else {
              pulse.style.opacity = "0"; ln.classList.remove("bad"); ln.classList.add("ok", "restored", "just"); dotR.classList.remove("off");
              var ev = $("event"); if (ev) { ev.textContent = "acct_" + (2000 + i * 137 % 7000) + " was locked out · restored, confirmed"; ev.classList.add("on"); setTimeout(function () { ev.classList.remove("on"); }, 4200); }
              var tr = $("tRestored"); if (tr) { window.__restoredExtra++; tr.textContent = String(df.restored.length + window.__restoredExtra); tr.classList.remove("bump"); void tr.offsetWidth; tr.classList.add("bump"); }
              setTimeout(function () { ln.classList.remove("just"); busy = false; }, 900);
            } })(t0);
          }, 1500);
        }
        setInterval(tick, 9000); setTimeout(tick, 2000);
      })();
      (function () { var t0 = Date.now(); setInterval(function () { var c = $("countdown"); if (!c) return; var left = Math.max(0, 58 * 60 - Math.floor((Date.now() - t0) / 1000)); c.textContent = String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0"); }, 1000); })();
      frame.dataset.done = "1"; requestAnimationFrame(function () { setTimeout(function () { var fr = $("frame"); if (fr) fr.classList.add("in"); }, 60); });
    }

    /* connect */
    document.querySelectorAll("[data-conn]").forEach(function (c) { var v = conns[c.dataset.conn]; var word = v === "preview" ? "Connected (preview)" : v === "waiting" ? "Waiting for you in the window" : v ? "Connected" : "Not connected"; var cls = v === "preview" || v === "waiting" ? "wait" : v ? "ok" : ""; c.querySelector(".st").innerHTML = '<i class="' + cls + '"></i>' + word; var b = c.querySelector("[data-connect]"); if (b) b.textContent = v && v !== "waiting" ? "Reconnect" : "Connect"; });
    var after = $("afterConnect"); if (after) after.hidden = nConn < 3;

    if (onboarding) { document.title = "Akeso"; return; }

    /* page */
    var f = fold(L);
    var busy = !!D.busy;
    var app = D.appName || "Your app";
    document.title = "Akeso · " + app;
    $("appName").textContent = app; $("who").textContent = app.charAt(0).toUpperCase();
    var st = $("fileStatus"); if (st) { st.textContent = D.demo ? "Example" : (D.fileName || ""); st.className = "status"; }
    $("sStatus").innerHTML = statusHTML(f, { hosted: D.hosted, busy: busy, app: app });
    $("sLoop").innerHTML = loopHTML(f, busy) + (drawerOpen ? '<div class="card drawer" style="border-top:0;border-radius:0 0 8px 8px;margin-top:-1px">' + drawerHTML(f, drawerOpen) + "</div>" : "");
    if (drawerOpen) { var cell = document.querySelector('[data-cell="' + drawerOpen + '"]'); if (cell) cell.classList.add("open"); }
    $("compareN").textContent = f.sweep && f.matched > 0 ? f.matched + " compared · " + ago(f.sweep.at) : "";
    $("compare").innerHTML = customersHTML(f, filter);
    $("inbox").innerHTML = okHTML(f, D.hosted);
    $("okSection").hidden = false;
    $("figures").innerHTML = figuresHTML(f);
    $("bound").innerHTML = accessHTML(f, D);
    $("timeline").innerHTML = historyHTML(L, D);

    /* chain */
    var seal = $("seal"); seal.className = "seal none"; seal.textContent = L.length ? "Verifying" : "Nothing checked yet";
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
        setSeal(broken ? "Record " + broken + " was changed" : "Verified · " + ago(f.lastAt), !!broken);
      })();
    } else if (L.length) { setSeal(plural(L.length, "record", "records") + " · not verified", false, true); }
  }

  /* ---------------- events ---------------- */
  function loadRows(text) { var n = 0; return text.split("\n").filter(function (l) { return l.trim(); }).map(function (l) { n++; try { var o = JSON.parse(l); return (o && typeof o === "object") ? o : { kind: "unreadable", line: n }; } catch (x) { return { kind: "unreadable", line: n }; } }); }
  document.addEventListener("change", function (e) {
    if (!e.target.matches("input[type=file]")) return;
    var file = e.target.files[0]; if (!file) return;
    file.text().then(function (t) {
      var rows = loadRows(t); var D = window.AKESO || {};
      if (!rows.some(function (r) { return r.kind !== "unreadable" && r.hash; })) { var st = $("fileStatus"); if (st) { st.textContent = "Not an Akeso results file"; st.className = "status bad"; } return; }
      var named = rows.find(function (r) { return r.appName || r.app; });
      window.AKESO = Object.assign({}, D, { ledger: rows, appName: (named && (named.appName || named.app)) || "Your app", demo: false, onboarding: false, fileName: file.name, root: null });
      render(); window.scrollTo(0, 0);
    });
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (b) { var done = function (t) { b.textContent = t; setTimeout(function () { b.textContent = "Copy"; }, 1600); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(function () { done("Copied"); }, function () { done("Select and copy"); }); else done("Select and copy"); return; }
    var mi = e.target.closest("[data-mini]"); if (mi && window.__mini) { e.preventDefault(); window.__mini(mi.dataset.mini); return; }
    var dr = e.target.closest("[data-drawer]"); if (dr) { drawerOpen = drawerOpen === dr.dataset.drawer ? null : dr.dataset.drawer; render(); return; }
    var fl = e.target.closest("[data-filter]"); if (fl) { filter = fl.dataset.filter; render(); return; }
    var go = e.target.closest("[data-screen]"); if (go) { e.preventDefault(); window.AKESO = Object.assign({}, window.AKESO || {}, { onboarding: true, screen: go.dataset.screen }); render(); window.scrollTo(0, 0); return; }
    if (e.target.id === "demoLink" || e.target.id === "demoLink2") { e.preventDefault(); var D = window.AKESO || {}; window.AKESO = Object.assign({}, D, { ledger: D.demoLedger || [], appName: D.demoName || "Example app", demo: true, onboarding: false, fileName: "" }); render(); window.scrollTo(0, 0); return; }
    if (e.target.id === "backLink") { e.preventDefault(); var D2 = window.AKESO || {}; window.AKESO = Object.assign({}, D2, { ledger: [], demo: false, onboarding: true, screen: "connect", fileName: "" }); render(); window.scrollTo(0, 0); return; }
    if (e.target.id === "download") { var D3 = window.AKESO || {}; var blob = new Blob([(D3.ledger || []).map(function (r) { return JSON.stringify(r); }).join("\n") + "\n"], { type: "application/json" }); var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ledger.jsonl"; a.click(); return; }
    var cb = e.target.closest("[data-connect]");
    if (cb) {
      e.preventDefault(); var prov = cb.dataset.connect;
      var w = 520, h = 720, left = Math.max(0, (screen.width - w) / 2), top = Math.max(0, (screen.height - h) / 2);
      var win = window.open(cb.getAttribute("href"), "akeso-connect", "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
      if (!win) { location.href = cb.getAttribute("href"); return; }
      var c = Object.assign({}, (window.AKESO || {}).connections || {}); c[prov] = "waiting"; window.AKESO.connections = c; render(); return;
    }
    var dc = e.target.closest("[data-disconnect]"); if (dc) { var p = dc.dataset.disconnect; dc.textContent = "Disconnecting"; fetch("/api/disconnect?provider=" + p, { method: "POST", credentials: "same-origin" }).catch(function () {}).then(function () { var c2 = Object.assign({}, (window.AKESO || {}).connections || {}); delete c2[p]; window.AKESO.connections = c2; render(); }); return; }
    var card = e.target.closest("[data-ok]");
    if (card) {
      if (e.target.closest("[data-remove]")) { card.querySelector(".acts").innerHTML = '<span class="confirm">Remove ' + esc(card.querySelector(".id").textContent) + "'s access? <button class=\"btn danger\" data-yes>Yes, remove</button><button class=\"btn sec\" data-no>No</button></span>"; return; }
      if (e.target.closest("[data-no]")) { render(); return; }
      if (e.target.closest("[data-keep]") || e.target.closest("[data-yes]")) {
        var decision = e.target.closest("[data-yes]") ? "remove" : "keep";
        card.querySelector(".acts").innerHTML = '<span class="done">Sending</span>';
        fetch("/api/decide", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.dataset.ok, decision: decision }) }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }).then(function () { card.querySelector(".acts").innerHTML = '<span class="done">' + (decision === "remove" ? "Removed" : "Kept") + "</span>"; }, function () { card.querySelector(".acts").innerHTML = '<span class="done">Akeso cannot reach your app yet. This arrives with the first hosted check.</span>'; });
        return;
      }
    }
    var t = e.target.closest("[data-tool]");
    if (t) { var P = "Run npx akeso-check here, follow its next steps, and explain the report to me in plain English."; var T = { terminal: { paste: "npx akeso-check" }, claude: { paste: P }, cursor: { paste: P }, codex: { paste: P }, lovable: { paste: "npx akeso-check", steps: true } }; document.querySelectorAll("[data-tool]").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); }); $("cmd").textContent = T[t.dataset.tool].paste; $("cmdCopy").dataset.copy = T[t.dataset.tool].paste; $("how").hidden = !T[t.dataset.tool].steps; }
  });

  /* the frame keeps a 960x520 layout and scales to whatever size it got */
  function fitFrame() { var fr = $("frame"), inner = $("frameInner"); if (!fr || !inner || fr.offsetWidth === 0 || window.innerWidth <= 720) { if (inner) inner.style.removeProperty("--s"); return; } inner.style.setProperty("--s", String(fr.clientWidth / 960)); }
  window.addEventListener("resize", fitFrame); setTimeout(fitFrame, 0); setTimeout(fitFrame, 300);
  (function () { var lock = $("lock"), fr = $("frame"); if (!lock || !fr || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) return; var edge = $("edge"), stage = $("stage"), pending = null;
    function light(ev) {
      if (!edge) return;
      var r = fr.getBoundingClientRect(), W = fr.clientWidth, H = fr.clientHeight;
      /* the cursor in the frame's own coordinates, by proportion of its screen box, so the bloom stays under the pointer while the frame tilts */
      var lx = (ev.clientX - r.left) / r.width * W, ly = (ev.clientY - r.top) / r.height * H;
      edge.style.setProperty("--mx", (lx + 9).toFixed(1) + "px"); edge.style.setProperty("--my", (ly + 9).toFixed(1) + "px"); edge.classList.add("on");
    }
    lock.addEventListener("mousemove", function (e) { pending = e; if (pending.raf) return; pending.raf = requestAnimationFrame(function () { var ev = pending; pending = null; fr.classList.remove("settle"); var r = fr.getBoundingClientRect(); var px = (ev.clientX - (r.left + r.width / 2)) / r.width, py = (ev.clientY - (r.top + r.height / 2)) / r.height; fr.style.setProperty("--ry", (px * 8).toFixed(2) + "deg"); fr.style.setProperty("--rx", (6 - py * 7).toFixed(2) + "deg"); light(ev); }); });
    lock.addEventListener("mouseleave", function () { fr.classList.add("settle"); fr.style.removeProperty("--rx"); fr.style.removeProperty("--ry"); if (edge) edge.classList.remove("on"); }); })();

  /* the field: one dot per customer, a slow wave turning them green */
  (function () {
    var c = $("field"); if (!c || !c.getContext) return;
    var ctx = c.getContext("2d"), still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    var dark = matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    var GAP = 28, R = 1.6, t0 = performance.now();
    function size() { var d = Math.min(2, window.devicePixelRatio || 1); if (!c.clientWidth) return; if (c.width !== Math.round(c.clientWidth * d) || c.height !== Math.round(c.clientHeight * d)) { c.width = Math.round(c.clientWidth * d); c.height = Math.round(c.clientHeight * d); ctx.setTransform(d, 0, 0, d, 0, 0); } }
    window.addEventListener("resize", size);
    function hash(x, y) { var h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967295; }
    function draw(now) {
      size(); var t = (now - t0) / 1000, w = c.clientWidth, h = c.clientHeight, cx = w / 2, cy = h / 2;
      if (!w) { requestAnimationFrame(draw); return; }
      ctx.clearRect(0, 0, w, h);
      for (var gy = GAP / 2; gy < h; gy += GAP) for (var gx = GAP / 2; gx < w; gx += GAP) {
        var hz = hash(gx, gy), hz2 = hash(gy, gx);
        var x = gx + (hz - 0.5) * 9, y = gy + (hz2 - 0.5) * 9;
        var dx = (x - cx) / w, dy = (y - cy) / h, dist = Math.sqrt(dx * dx + dy * dy);
        var wave = 0.5 + 0.5 * Math.sin(x * 0.012 - t * 0.9 + hz * 2.4 + Math.sin(y * 0.01 + t * 0.4 + hz2 * 3) * 1.8);
        var g = Math.pow(wave, 2.6) * (0.6 + 0.8 * hz2);
        var edge = Math.min(1, Math.max(0, (dist - 0.16) / 0.34));
        var a = Math.min(0.6, (0.06 + 0.5 * g)) * edge;
        var amber = hz > 0.993 && ((t * 0.7 + hz * 60) % 7) < 0.7;
        var shade = hz2 < 0.34 ? (dark ? "63,211,238" : "34,195,222") : hz2 < 0.67 ? (dark ? "63,226,213" : "31,209,196") : (dark ? "92,242,196" : "58,232,179");
        ctx.fillStyle = amber ? "rgba(224,150,26," + (0.9 * edge) + ")" : "rgba(" + shade + "," + a + ")";
        ctx.beginPath(); ctx.arc(x, y, R + g * 1.1, 0, 6.2832); ctx.fill();
      }
      if (!still) requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  })();

  /* the intro's two questions alternate slowly */
  (function () { var hs = document.querySelectorAll("#lock .lines h1"); if (hs.length < 2) return; var i = 0; setInterval(function () { if (document.hidden) return; hs[i].classList.remove("on"); i = (i + 1) % hs.length; hs[i].classList.add("on"); }, 5200); })();
  (function () {
    var el = $("board"); if (!el) return;
    var COLS = 26, ROWS = [["DID YOUR CUSTOMERS GET", "WHAT THEY PAID FOR?"], ["DO YOUR CANCELED CUSTOMERS", "STILL HAVE ACCESS?"]], POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ?";
    var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    function pad(t) { var left = Math.floor((COLS - t.length) / 2); return (Array(left + 1).join(" ") + t + Array(COLS + 1).join(" ")).slice(0, COLS); }
    el.innerHTML = ROWS[0].map(function (r) { return '<span class="row">' + pad(r).split("").map(function (c) { return '<span class="cell"><span>' + (c === " " ? "&nbsp;" : c) + "</span></span>"; }).join("") + "</span>"; }).join("");
    var cells = Array.prototype.slice.call(el.querySelectorAll(".cell")), i = 0, gen = 0, timers = [];
    function set(cell, ch) { cell.firstChild.innerHTML = ch === " " ? "&nbsp;" : ch; }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function settle(rows) { var target = rows.map(pad).join(""); cells.forEach(function (cell, k) { set(cell, target.charAt(k)); cell.classList.remove("go"); }); }
    function flipTo(rows) {
      gen++; var my = gen; timers.forEach(clearTimeout); timers = [];
      var target = rows.map(pad).join("");
      if (still || document.hidden) { settle(rows); return; }
      cells.forEach(function (cell, k) {
        var col = k % COLS, final = target.charAt(k), cur = cell.textContent.replace(/ /g, " ");
        if (cur === final) return;
        var steps = 3 + Math.floor(Math.random() * 6), step = 0;
        later(function tick() {
          if (my !== gen) return;
          cell.classList.remove("go"); void cell.offsetWidth; cell.classList.add("go");
          later(function () { if (my !== gen) return; step++; set(cell, step >= steps ? final : POOL.charAt(Math.floor(Math.random() * POOL.length))); }, 45);
          if (step < steps - 1) later(tick, 92);
        }, col * 26 + Math.random() * 30);
      });
      later(function () { if (my === gen) settle(rows); }, 26 * COLS + 30 + 9 * 92 + 120);
    }
    var btn = $("findOut"), lbl = btn && btn.querySelector(".lbl");
    if (lbl && lbl.dataset.label) {
      var A = lbl.dataset.label, B = lbl.dataset.hover, W = Math.max(A.length, B.length), bgen = 0, bt = [];
      var padc = function (t) { var left = Math.floor((W - t.length) / 2); return (Array(left + 1).join(" ") + t + Array(W + 1).join(" ")).slice(0, W); };
      lbl.innerHTML = padc(A).split("").map(function (c) { return '<span class="c"><span>' + (c === " " ? "&nbsp;" : c) + "</span></span>"; }).join("");
      var bcells = Array.prototype.slice.call(lbl.querySelectorAll(".c"));
      var bflip = function (text) {
        bgen++; var my = bgen; bt.forEach(clearTimeout); bt = []; var t = padc(text);
        bcells.forEach(function (cell, k) { var final = t.charAt(k); if (still) { set(cell, final); return; } var steps = 2 + Math.floor(Math.random() * 4), step = 0;
          bt.push(setTimeout(function tick() { if (my !== bgen) return; cell.classList.remove("go"); void cell.offsetWidth; cell.classList.add("go"); bt.push(setTimeout(function () { if (my !== bgen) return; step++; set(cell, step >= steps ? final : POOL.charAt(Math.floor(Math.random() * POOL.length))); }, 45)); if (step < steps - 1) bt.push(setTimeout(tick, 80)); }, k * 22)); });
        bt.push(setTimeout(function () { if (my === bgen) bcells.forEach(function (cell, k) { set(cell, t.charAt(k)); }); }, W * 22 + 6 * 80 + 100));
      };
      btn.addEventListener("mouseenter", function () { bflip(B); }); btn.addEventListener("mouseleave", function () { bflip(A); });
    }
    (function () {
      var sat = btn && btn.querySelector(".sat"), still2 = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (sat && !still2) (function () {
        var pos = 0, speed = 100 / 7, target = speed, last = performance.now();
        btn.addEventListener("mouseenter", function () { target = 100 / 1.6; }); btn.addEventListener("mouseleave", function () { target = 100 / 7; });
        (function frame(now) { var dt = Math.min(0.05, (now - last) / 1000); last = now; speed += (target - speed) * Math.min(1, dt * 6); pos = (pos + speed * dt) % 100; sat.style.offsetDistance = pos.toFixed(3) + "%"; requestAnimationFrame(frame); })(last);
      })();
    })();
    var cycle = null;
    function start() { if (cycle) return; cycle = setInterval(function () { i = (i + 1) % ROWS.length; flipTo(ROWS[i]); }, 3600); }
    function stop() { if (cycle) { clearInterval(cycle); cycle = null; } gen++; timers.forEach(clearTimeout); timers = []; settle(ROWS[i]); }
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    start();
  })();

  /* section index */
  (function () { var links = document.querySelectorAll(".index a"); if (!links.length || !window.IntersectionObserver) return; var io = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) links.forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id); }); }); }, { rootMargin: "-30% 0px -60% 0px" }); document.querySelectorAll(".sections section[id]").forEach(function (s) { io.observe(s); }); })();

  function refreshConnections() { if (!(window.AKESO && window.AKESO.hosted && window.fetch)) return; fetch("/api/connections", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j && typeof j === "object") { var cur = (window.AKESO || {}).connections || {}; Object.keys(cur).forEach(function (k) { if (cur[k] === "waiting" && !j[k]) j[k] = "waiting"; }); window.AKESO.connections = j; render(); } }).catch(function () {}); }
  window.addEventListener("message", function (e) { if (e.origin !== location.origin || !e.data || e.data.akeso !== "connected") return; var c = Object.assign({}, (window.AKESO || {}).connections || {}); c[e.data.provider] = e.data.preview ? "preview" : true; window.AKESO.connections = c; render(); refreshConnections(); });
  window.addEventListener("focus", refreshConnections);
  if (window.AKESO && window.AKESO.onboarding && /^#(connect|paste)$/.test(location.hash)) window.AKESO.screen = location.hash.slice(1);
  render();
  refreshConnections();
})();
`;

export function renderDashboard({ ledger = [], appName = "this app", root = null, hosted = false, demo = false } = {}) {
  const data = JSON.stringify(hosted && demo
    ? { ledger: [], demoLedger: ledger, demoName: appName, appName: "Your app", onboarding: true, demo: false, hosted: true, scenarioNames: SCENARIO_NAMES }
    : { ledger, appName, root, onboarding: false, demo: false, hosted, scenarioNames: SCENARIO_NAMES }).replaceAll("</", "<\\/");
  const fonts = hosted ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">` : "";
  const CARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/></svg>';
  const BRANCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 3-4 3-6 4-2 .6-4 1-6 1"/></svg>';
  const DB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>';

  const onboarding = hosted ? `
    <section id="lock" hidden>
      <canvas class="field" id="field" aria-hidden="true"></canvas>
      <a href="#" class="link" id="demoLink" hidden>See an example</a>
      <div class="paper">
        <div class="lines" aria-live="off"><h1 class="on">Did your customers get what they paid for?</h1><h1>Do your canceled customers still have access?</h1></div>
        <div class="stage" id="stage"><div class="frame" id="frame"><div class="screen"><div class="inner" id="frameInner"></div></div><div class="glow" id="edge" aria-hidden="true"></div></div></div>
        <a href="#" class="btn big orbit" id="findOut" data-screen="connect"><span class="lbl">Find out</span><i class="sat" aria-hidden="true"></i></a>
      </div>
    </section>
    <section id="connect" hidden><div class="wrap">
      <p class="eyebrow">Step 1 of 2</p>
      <h1 class="big">Connect what Akeso needs.</h1>
      <p class="lead">Click one. A small window opens. Press Grant.</p>
      <div class="card rows">
        <div class="row" data-conn="stripe"><div class="mark">${CARD}</div><div class="k"><b>Stripe</b><span>Where you get paid.</span></div><div class="st"><i></i>Not connected</div><a class="btn sec" href="/api/connect?provider=stripe" data-connect="stripe">Connect</a></div>
        <div class="row" data-conn="github"><div class="mark">${BRANCH}</div><div class="k"><b>Your code</b><span>On GitHub.</span></div><div class="st"><i></i>Not connected</div><a class="btn sec" href="/api/connect?provider=github" data-connect="github">Connect</a></div>
        <div class="row" data-conn="supabase"><div class="mark">${DB}</div><div class="k"><b>Your customers</b><span>On Supabase.</span></div><div class="st"><i></i>Not connected</div><a class="btn sec" href="/api/connect?provider=supabase" data-connect="supabase">Connect</a></div>
        <div class="row" id="afterConnect" hidden><div class="mark"><span class="spin"></span></div><div class="k"><b>Checking your app</b><span>The first hosted check is being built. Until then, the one-command check works.</span></div></div>
      </div>
      <p class="alt">Prefer to keep everything on your own computer? <a href="#" class="link" data-screen="paste">Run it yourself with one command.</a></p>
    </div></section>
    <section id="paste" hidden><div class="wrap">
      <p class="eyebrow"><a href="#" class="link" data-screen="connect">Back</a></p>
      <h1 class="big">One command. Runs on your computer.</h1>
      <p class="lead">Nothing leaves it.</p>
      <div class="tabs" id="tabs" role="tablist"><button role="tab" aria-selected="true" data-tool="terminal">Terminal</button><button role="tab" aria-selected="false" data-tool="claude">Claude Code</button><button role="tab" aria-selected="false" data-tool="cursor">Cursor</button><button role="tab" aria-selected="false" data-tool="codex">Codex</button><button role="tab" aria-selected="false" data-tool="lovable">Lovable / Bolt / v0</button></div>
      <ol class="how" id="how" hidden><li>Put your project on GitHub (the GitHub button in your builder).</li><li>On github.com: Code, Codespaces, Create codespace.</li><li>In the terminal at the bottom, paste this and press Enter.</li></ol>
      <div class="cmd" style="margin-top:12px"><code id="cmd">npx akeso-check</code><button class="link" id="cmdCopy" data-copy="npx akeso-check">Copy</button></div>
      <p class="alt">It writes <span class="mono">.akeso/ledger.jsonl</span> in your project. <label class="link" style="cursor:pointer">Open your results file<input type="file" id="ledgerFile" class="sr" accept=".jsonl,application/json,text/plain"></label>. Read in this tab, never uploaded.</p>
    </div></section>` : "";

  const shell = `${onboarding}
  <div id="page">
    <header class="bar"><div class="wrap">
      <span class="app" id="appName"></span>
      <span class="seal none" id="seal" aria-live="polite"></span>
      <span class="acts">${hosted ? `<span class="status" id="fileStatus"></span><a href="#" class="link txt" id="backLink" style="color:var(--ink2);font-weight:400">Start over</a><label class="link txt" style="color:var(--ink2);font-weight:400;cursor:pointer">Open a results file<input type="file" class="sr" accept=".jsonl,application/json,text/plain"></label>` : ""}<a href="#access" class="txt">Settings</a><span class="who" id="who"></span></span>
    </div></header>
    <main class="wrap layout">
      <nav class="index" aria-label="Sections"><a href="#status">Status</a><a href="#customers">Customers</a><a href="#ok">Needs your OK</a><a href="#totals">Totals</a><a href="#access">Access</a><a href="#history">History</a></nav>
      <div class="sections">
        <section id="status"><div id="sStatus"></div></section>
        <section id="theloop"><div id="sLoop"></div></section>
        <section id="customers"><h2>Customers<span class="r" id="compareN"></span></h2><div class="legend" style="margin:-4px 0 10px"><span><i></i>paying, has access</span><span><i class="wait"></i>needs you</span><span><i class="bad"></i>locked out</span><span><i class="none"></i>no verdict</span></div><div class="card" id="compare"></div></section>
        <section id="ok"><h2>Needs your OK</h2><div id="inbox"></div><div id="okSection" hidden></div></section>
        <section id="totals"><h2>Totals</h2><div id="figures"></div></section>
        <section id="access"><h2>Access</h2><div id="bound"></div></section>
        <section id="history"><h2>History<span class="seal none r" id="seal2"></span></h2><div id="timeline"></div></section>
        <p class="doctrine">Akeso restores access on its own. It never removes access on its own.</p>
      </div>
    </main>
  </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Akeso · ${escapeHtml(appName)}</title>
${fonts}
<style>${CSS}</style>
</head><body>
${shell}
<script>window.AKESO = ${data};</script>
<script>${JS}</script>
</body></html>`;
}
