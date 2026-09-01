// Runs the fixture the way Next would: takes whatever webhook route file is
// currently on disk, hands it a real web Request, and returns its Response.
//
// This matters for the end-to-end test. Before the Fix, it serves the
// tutorial-broken handler. After the Fix, it serves the GENERATED handler,
// unmodified, with the generated entitlement module behind it — so the test
// grades real executed code, not a description of it.
import http from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4120);

process.env.AKESO_FIXTURE_DB = process.env.AKESO_FIXTURE_DB || path.join(here, "data", "db.json");
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://fixture.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "fixture-key";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fixture";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_fixturefixturefixture5678";

// Fresh state per run, and the account the scenarios use must already exist —
// real apps only create rows through their own signup flow.
const ACCOUNTS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "shared", "akeso-warmup"];
await writeFile(process.env.AKESO_FIXTURE_DB, JSON.stringify({
  tables: {
    users: ACCOUNTS.map((id) => ({ id, billing_entitled: null, stripe_price_id: null, admin_block: false, abuse_block: false, complimentary_access: false, billing_override: false })),
    akeso_processed_events: [],
    akeso_event_watermarks: [],
  },
}, null, 2));

// Whichever handler is on disk right now. Imported per request with a cache
// buster so a fix applied mid-session is picked up, exactly like a dev server.
async function currentHandler() {
  for (const candidate of ["app/api/stripe/webhook/route.mjs", "app/api/stripe/webhook/route.ts"]) {
    const file = path.join(here, candidate);
    try {
      const module = await import(`${file}?v=${Date.now()}`);
      if (module.POST) return module.POST;
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("no webhook route found");
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      const POST = await currentHandler();
      const response = await POST(new Request(`http://localhost:${PORT}${req.url}`, {
        method: "POST",
        headers: req.headers,
        body,
      }));
      const text = await response.text();
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "text/plain" });
      res.end(text);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error?.message || error));
    }
    return;
  }

  // The Akeso endpoints, served the same way: whatever is on disk right now.
  // Present only after "fix --apply --with-endpoints", so a run before that
  // correctly gets a 404 rather than a stub that pretends to work.
  const akesoRoute = url.pathname.match(/^\/api\/akeso\/([a-z-]+)$/)?.[1];
  if (req.method === "POST" && akesoRoute) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      const file = path.join(here, "app", "api", "akeso", akesoRoute, "route.mjs");
      const module = await import(`${file}?v=${Date.now()}`);
      const response = await module.POST(new Request(`http://localhost:${PORT}${req.url}`, {
        method: "POST", headers: req.headers, body,
      }));
      const text = await response.text();
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "text/plain" });
      res.end(text);
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND") { res.writeHead(404); res.end("no such route"); return; }
      res.writeHead(500);
      res.end(String(error?.message || error));
    }
    return;
  }

  if (url.pathname === "/api/akeso-probe" || url.pathname === "/__akeso_probe") {
    try {
      const { isPro } = await import(`${path.join(here, "lib", "access.mjs")}?v=${Date.now()}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ billingEntitled: await isPro(url.searchParams.get("account")) }));
    } catch (error) {
      // A probe that cannot read must say so, never answer "false".
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, () => console.log(`repairable-prisma-app listening on ${PORT}`));
