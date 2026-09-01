import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* The access probe: a temporary route the Check adds to the founder's app so
 * the lifecycle pass can ask THE APP'S OWN CODE "is this account entitled?"
 * after each transition. Added for the run, removed afterwards — and removal
 * refuses to touch any file the Check did not write.
 *
 * The judgement problem lives here: which function IS the app's access
 * decision? Detection ranks candidate files; this module only wires a probe
 * when it finds an exported function whose name and shape it recognises. When
 * it is not sure, it says so and emits a two-line stub for the founder (or
 * their coding agent) to complete — an honest gap beats a wrong wire.
 */

const MARKER = "AKESO PROBE — added by Akeso Check for a test run. Safe to delete.";

/* Function names that mean "the billing/access decision" when exported.
   Ordered: an explicit entitlement function beats a generic isPro. */
const KNOWN_NAMES = [
  "getBillingEntitlement",
  "billingEntitled",
  "isSubscribed",
  "hasActiveSubscription",
  "isPro",
  "isPremium",
  "isPaid",
  "hasPaidAccess",
  "hasAccess",
];

/* Find recognisable exported access functions in one file. Regex over source is
   deliberate — no TS compiler dependency — and anything it cannot classify is
   simply not offered, never guessed at. */
export function findAccessExports(source) {
  const found = [];
  for (const name of KNOWN_NAMES) {
    const patterns = [
      new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`),
      new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(async\\s*)?\\(([^)]*)\\)\\s*=>`),
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) {
        const params = (match[2] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
        found.push({ name, paramCount: params.length, firstParam: params[0] || null });
        break;
      }
    }
  }
  return found;
}

/* Choose the probe target across the ranked candidate files. One-argument
   functions only: isPro(userId) is wireable; isPro(userId, featureFlag, ctx)
   is a guess we refuse to make. */
export async function chooseProbeTarget(root, accessDecisionSites) {
  const considered = [];
  for (const site of accessDecisionSites.slice(0, 6)) {
    if (site.clientSideOnly) continue; /* a browser-side gate cannot answer for the server */
    const source = await readFile(path.join(root, site.file), "utf8").catch(() => null);
    if (!source) continue;
    for (const fn of findAccessExports(source)) {
      considered.push({ file: site.file, ...fn, siteScore: site.score });
    }
  }
  considered.sort((a, b) =>
    (KNOWN_NAMES.indexOf(a.name) - KNOWN_NAMES.indexOf(b.name)) || (b.siteScore - a.siteScore));

  const wireable = considered.filter((c) => c.paramCount === 1);
  return {
    chosen: wireable[0] || null,
    considered,
    reason: wireable[0]
      ? `Found ${wireable[0].name}(${wireable[0].firstParam}) in ${wireable[0].file}.`
      : considered.length
        ? "Access functions exist but none takes exactly one argument — wiring one would be a guess."
        : "No recognisable exported access function was found.",
  };
}

/* No path segment may start with an underscore. Next.js treats an
   underscore-prefixed folder as a PRIVATE folder and excludes it from routing
   entirely, so the old `__akeso_probe` route silently never existed on any
   real Next.js app. The fixtures are plain Node servers, which is why the
   tests never caught it; a real user's run did. */
function probeRoutePath(root, framework) {
  if (framework === "next-pages") return path.join(root, "pages", "api", "akeso-probe.ts");
  return path.join(root, "app", "api", "akeso-probe", "route.ts");
}

/* Relative import from the generated route file to the access module, with the
   extension handled the way the app's own imports are. */
function importSpecifier(fromFile, toFile) {
  let relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative.replace(/\.(ts|tsx)$/, "").replace(/\.(js)$/, "");
}

export function renderProbe({ framework, specifier, exportName }) {
  const body = `// ${MARKER}
// It exists so the lifecycle test can ask this app's own code whether an
// account is billing-entitled. It reads; it never writes.
import { ${exportName} } from "${specifier}";

${framework === "next-pages"
    ? `export default async function handler(req, res) {
  const account = String(req.query.account || "");
  res.status(200).json({ billingEntitled: Boolean(await ${exportName}(account)) });
}`
    : `export async function GET(request${framework.startsWith("node") ? "" : ": Request"}) {
  const account = new URL(request.url).searchParams.get("account") || "";
  return Response.json({ billingEntitled: Boolean(await ${exportName}(account)) });
}`}
`;
  return body;
}

export function renderProbeStub(framework) {
  return `// ${MARKER}
// Akeso could not identify this app's access function on its own.
// ONE LINE TO COMPLETE: import your access check and return its answer.
// Example:  import { isPro } from "../../lib/access";
${framework === "next-pages"
    ? `export default async function handler(req, res) {
  const account = String(req.query.account || "");
  res.status(200).json({ billingEntitled: /* await isPro(account) */ null });
}`
    : `export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get("account") || "";
  return Response.json({ billingEntitled: /* await isPro(account) */ null });
}`}
`;
}

/* A Supabase Edge Function app has no Node route to mount a probe on. The
   probe becomes one more edge function, served by the same `supabase
   functions serve` the founder already runs, reading the table and column the
   Check found through the runtime's own service client. Akeso never holds
   that key: the function runtime injects it, and the file is removed after. */
export function isEdgeApp(detection) {
  return Boolean(detection.webhookHandlers?.[0]?.file?.startsWith("supabase/functions/"));
}

function renderEdgeProbe(detection) {
  const table = detection.database?.entitlementTable || "profiles";
  const column = detection.database?.entitlementColumn || "billing_entitled";
  const statusColumn = /status/i.test(column);
  return `// ${MARKER}
// Akeso: temporary probe. Removed when the run ends. Answers one question for
// the Check: does this account currently have paid access, according to your
// own database? Reads ${table}.${column}, nothing else, and writes nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ENTITLED = new Set(["active", "trialing", "past_due"]);

Deno.serve(async (req) => {
  const account = new URL(req.url).searchParams.get("account");
  if (!account) return new Response(JSON.stringify({ error: "account required" }), { status: 400, headers: { "content-type": "application/json" } });
  const { data, error } = await supabase.from("${table}").select("${column}").eq("id", account).maybeSingle();
  // A read error is reported, never turned into "not entitled".
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });
  const value = (data as Record<string, unknown> | null)?.["${column}"];
  const billingEntitled = ${statusColumn ? "ENTITLED.has(String(value ?? \"\"))" : "Boolean(value)"};
  return new Response(JSON.stringify({ billingEntitled }), { headers: { "content-type": "application/json" } });
});
`;
}

export async function installProbe(root, detection) {
  if (isEdgeApp(detection)) {
    const routeFile = path.join(root, "supabase", "functions", "akeso-probe", "index.ts");
    await mkdir(path.dirname(routeFile), { recursive: true });
    await writeFile(routeFile, renderEdgeProbe(detection));
    return { routeFile, urlPath: "/functions/v1/akeso-probe", wired: true, reason: null, target: { file: "supabase (service client)", name: `${detection.database?.entitlementTable || "profiles"}.${detection.database?.entitlementColumn || "billing_entitled"}` } };
  }
  const framework = detection.framework?.framework || "next-app-router";
  const routeFile = probeRoutePath(root, framework)
    .replace(/route\.ts$/, framework === "node-other" ? "route.mjs" : "route.ts");

  const target = await chooseProbeTarget(root, detection.accessDecisionSites || []);
  const content = target.chosen
    ? renderProbe({
      framework,
      specifier: importSpecifier(routeFile, path.join(root, target.chosen.file)),
      exportName: target.chosen.name,
    })
    : renderProbeStub(framework);

  await mkdir(path.dirname(routeFile), { recursive: true });
  await writeFile(routeFile, content);
  return {
    routeFile,
    urlPath: "/api/akeso-probe",
    wired: Boolean(target.chosen),
    reason: target.reason,
    target: target.chosen || null,
  };
}

/* Removal refuses to delete anything without the marker: if a founder edited
   the stub into something real and kept it, that file is now theirs. */
export async function removeProbe(routeFile) {
  const content = await readFile(routeFile, "utf8").catch(() => null);
  if (content === null) return { removed: false, reason: "already gone" };
  if (!content.includes(MARKER)) return { removed: false, reason: "file no longer carries the Akeso marker — leaving it alone" };
  /* An edge probe is a whole function directory watched by `supabase
     functions serve`. Removing the file and then the directory gave the
     watcher a moment where the directory existed without its file, and the
     CLI's serve process died reading it. One removal, one event. */
  if (path.basename(path.dirname(routeFile)) === "akeso-probe" && routeFile.includes(`${path.sep}supabase${path.sep}functions${path.sep}`)) {
    await rm(path.dirname(routeFile), { recursive: true, force: true });
    return { removed: true };
  }
  await rm(routeFile);
  /* tidy the wrapper dir Next requires, only if we created it and it is now empty */
  const dir = path.dirname(routeFile);
  /* rmdir, not rm: it removes the folder only when it is empty, so a folder
     holding anything of the founder's is never touched. (rm without recursive
     throws on a directory, which silently left an empty folder in their repo.) */
  if (["akeso-probe", "__akeso_probe"].includes(path.basename(dir))) await rmdir(dir).catch(() => {});
  return { removed: true };
}
