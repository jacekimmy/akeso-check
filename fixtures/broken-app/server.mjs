// Minimal runnable server for the fixture: the webhook route plus the access
// probe the Check queries after each lifecycle transition.
import http from "node:http";
import { handleWebhook, isPro, readProfiles } from "./lib/handler.mjs";
import { writeFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 4101);

// Fresh state per run so a previous run's grants cannot leak into this one.
await writeFile(new URL("./data/profiles.json", import.meta.url), "{}");

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const out = await handleWebhook(body, req.headers["stripe-signature"]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (error) {
        res.writeHead(500); res.end(String(error?.message || error));
      }
    });
    return;
  }
  if (url.pathname === "/__akeso_probe") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ billingEntitled: await isPro(url.searchParams.get("account")) }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`broken-app listening on ${PORT}`));
