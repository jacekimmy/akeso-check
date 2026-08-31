import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/* Works out what this project is, using only what is on disk.
 *
 * This is the part of the Check that decides whether everything downstream is
 * possible: which framework, where the env lives, whether there are Stripe
 * keys and what mode they are in, where the webhook handler is, and — the hard
 * one — where the app decides who has paid access.
 *
 * Two disciplines carried over from the product-care engine:
 * - Report only what was actually observed. "Not found" is a finding, not an
 *   error; a wrong confident answer is worse than an honest gap.
 * - Never print a secret. Keys are reported as mode + last four characters.
 */

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".vercel", ".turbo",
  "coverage", ".cache", "out", ".wrangler", ".vinext",
]);

const ENV_FILES = [".env", ".env.local", ".env.development.local", ".env.production.local", ".env.development", ".env.production"];

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function readIfThere(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

/* Safe to show: enough to recognise a key, never enough to use one. */
function describeKey(value) {
  if (!value) return null;
  const mode = value.startsWith("sk_live_") || value.startsWith("rk_live_") ? "LIVE"
    : value.startsWith("sk_test_") || value.startsWith("rk_test_") ? "test"
    : value.startsWith("pk_live_") ? "LIVE (publishable)"
    : value.startsWith("pk_test_") ? "test (publishable)"
    : value.startsWith("whsec_") ? "webhook secret"
    : "unrecognised";
  return { mode, lastFour: value.slice(-4), length: value.length };
}

async function detectFramework(root) {
  const pkgRaw = await readIfThere(path.join(root, "package.json"));
  if (!pkgRaw) return { framework: "unknown", reason: "No package.json found." };
  let pkg;
  try { pkg = JSON.parse(pkgRaw); } catch { return { framework: "unknown", reason: "package.json is not valid JSON." }; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps.next) {
    const hasAppDir = await exists(path.join(root, "app")) || await exists(path.join(root, "src", "app"));
    const hasPagesDir = await exists(path.join(root, "pages")) || await exists(path.join(root, "src", "pages"));
    return {
      framework: hasAppDir ? "next-app-router" : hasPagesDir ? "next-pages" : "next-unknown-layout",
      nextVersion: deps.next,
      packageName: pkg.name || null,
    };
  }
  if (deps.express) return { framework: "express", packageName: pkg.name || null };
  return { framework: "node-other", packageName: pkg.name || null, dependencies: Object.keys(deps).slice(0, 20) };
}

async function readEnv(root) {
  const merged = {};
  const filesFound = [];
  for (const name of ENV_FILES) {
    const raw = await readIfThere(path.join(root, name));
    if (raw === null) continue;
    filesFound.push(name);
    Object.assign(merged, parseEnv(raw));
  }
  return { filesFound, values: merged };
}

function detectStripe(env, pkgDeps) {
  const secretKey = env.STRIPE_SECRET_KEY || env.STRIPE_API_KEY || env.STRIPE_SK || null;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SIGNING_SECRET || null;
  return {
    sdkInstalled: Boolean(pkgDeps?.stripe),
    secretKey: describeKey(secretKey),
    webhookSecret: describeKey(webhookSecret),
    /* The lifecycle pass may only ever run against a test-mode key. */
    lifecycleTestable: Boolean(secretKey && !secretKey.includes("_live_")),
    liveKeyPresent: Boolean(secretKey && secretKey.includes("_live_")),
  };
}

function detectDatabase(env, pkgDeps) {
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || null;
  const postgresUrl = env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || null;
  return {
    kind: supabaseUrl ? "supabase" : postgresUrl ? "postgres" : "none-found",
    supabase: supabaseUrl ? {
      urlHost: (() => { try { return new URL(supabaseUrl).host; } catch { return "unparseable"; } })(),
      /* Anonymous/publishable key is fine to use; service-role never is. Its
         mere presence in an env file is worth telling the founder about. */
      serviceRoleKeyPresentInEnv: Boolean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY),
      publishableKeyPresent: Boolean(env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY),
    } : null,
    postgresUrlPresent: Boolean(postgresUrl),
    ormInstalled: pkgDeps?.prisma ? "prisma" : pkgDeps?.drizzle ? "drizzle" : pkgDeps?.["drizzle-orm"] ? "drizzle" : null,
  };
}

/* Walk the source tree once, collecting every file that mentions Stripe.
   Bounded: skips build output and gives up past a sane file count so a huge
   monorepo cannot hang the Check. */
async function collectSourceFiles(root, limit = 4000) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > 8 || files.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(path.join(dir, entry.name), depth + 1);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root, 0);
  return files;
}

const REQUIRED_EVENTS = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
];

async function findWebhookHandler(root, sourceFiles) {
  const candidates = [];
  for (const file of sourceFiles) {
    const relative = path.relative(root, file);
    const looksLikeRoute = /webhook|stripe/i.test(relative);
    const content = await readIfThere(file);
    if (!content) continue;
    /* Must be a real call, not the word. A comment saying "no constructEvent
       here" made an earlier version report the signature as verified — the
       exact false pass this tool exists to catch in other people's code. */
    const code = content.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    const mentionsConstruct = /constructEvent(Async)?\s*\(/.test(code);
    const mentionsEvents = REQUIRED_EVENTS.filter((event) => code.includes(event));
    if (!mentionsConstruct && mentionsEvents.length === 0 && !(looksLikeRoute && /stripe/i.test(content))) continue;

    candidates.push({
      file: relative,
      verifiesSignature: mentionsConstruct,
      /* constructEvent on a parsed body fails at runtime; the raw body is the
         thing that must be verified. Heuristic, so it is reported as evidence
         ("raw body handling not seen") rather than as a verdict. */
      rawBodySeen: /req\.text\(\)|request\.text\(\)|rawBody|buffer\(|arrayBuffer\(|micro|bodyParser:\s*false|await buffer/.test(content),
      handledEvents: mentionsEvents,
      missingEvents: REQUIRED_EVENTS.filter((event) => !code.includes(event)),
    });
  }
  candidates.sort((a, b) => (b.verifiesSignature - a.verifiesSignature) || (b.handledEvents.length - a.handledEvents.length));
  return candidates;
}

/* The judgement problem: where does this app decide who has paid access?
   We do not decide — we gather every plausible site with its evidence and let
   the report (and eventually the founder) confirm. A ranked shortlist that is
   honest about confidence beats a confident wrong answer. */
const ACCESS_HINTS = [
  { pattern: /\b(is_pro|isPro|is_premium|isPremium|is_paid|isPaid|has_access|hasAccess|is_subscribed|isSubscribed|subscribed)\b/, why: "boolean paid flag" },
  { pattern: /\b(plan|tier|subscription_status|subscriptionStatus|subscription_tier)\b\s*(===?|!==?|\.eq\(|:)/, why: "plan/status comparison" },
  { pattern: /\.from\(["'`](subscriptions|subscribers|entitlements|customers|profiles|users|accounts|billing)["'`]\)/, why: "reads a billing-ish table" },
  { pattern: /\bstatus\s*===?\s*["'`](active|trialing|past_due|canceled)["'`]/, why: "compares a Stripe status value" },
  { pattern: /getBillingEntitlement|billingEntitled/, why: "already has an entitlement function" },
];

async function findAccessDecisionSites(root, sourceFiles) {
  const sites = [];
  for (const file of sourceFiles) {
    const content = await readIfThere(file);
    if (!content) continue;
    const relative = path.relative(root, file);
    const reasons = ACCESS_HINTS.filter((hint) => hint.pattern.test(content)).map((hint) => hint.why);
    if (!reasons.length) continue;
    const clientSide = /["']use client["']/.test(content) || /components\/|hooks\//.test(relative) || /from ["']react["']/.test(content);
    sites.push({
      file: relative,
      evidence: [...new Set(reasons)],
      /* A paid gate that only exists in the browser can be bypassed by anyone
         who opens devtools. Worth its own flag. */
      clientSideOnly: clientSide,
      score: reasons.length + (relative.includes("lib/") || relative.includes("server") || relative.includes("api/") ? 2 : 0) - (clientSide ? 1 : 0),
    });
  }
  return sites.sort((a, b) => b.score - a.score).slice(0, 10);
}

export async function detect(root) {
  const framework = await detectFramework(root);
  const env = await readEnv(root);
  const pkgRaw = await readIfThere(path.join(root, "package.json"));
  let deps = {};
  try { const pkg = JSON.parse(pkgRaw || "{}"); deps = { ...pkg.dependencies, ...pkg.devDependencies }; } catch { /* reported by detectFramework */ }

  const stripe = detectStripe(env.values, deps);
  const database = detectDatabase(env.values, deps);
  const sourceFiles = await collectSourceFiles(root);
  const webhookHandlers = await findWebhookHandler(root, sourceFiles);
  const accessDecisionSites = await findAccessDecisionSites(root, sourceFiles);

  return {
    root,
    scannedFiles: sourceFiles.length,
    framework,
    envFiles: env.filesFound,
    stripe,
    database,
    webhookHandlers,
    accessDecisionSites,
    /* What downstream stages are possible, decided here in one place. */
    capabilities: {
      staticPass: true,
      lifecyclePass: stripe.lifecycleTestable && webhookHandlers.length > 0,
      liveSnapshot: stripe.liveKeyPresent || stripe.lifecycleTestable,
      blockers: [
        /* A found webhook handler IS evidence of a Stripe app, even when the
           SDK arrives by URL import (Deno edge functions) and keys live in the
           platform, not in env files. */
        !stripe.sdkInstalled && !stripe.secretKey && webhookHandlers.length === 0 ? "No Stripe SDK or key found. Is this a Stripe-backed app?" : null,
        stripe.liveKeyPresent && !stripe.lifecycleTestable ? "Only a LIVE Stripe key found. Lifecycle tests run only against test mode; add a test key." : null,
        webhookHandlers.length === 0 ? "No Stripe webhook handler found." : null,
        database.kind === "none-found" ? "No database connection found in env files." : null,
      ].filter(Boolean),
    },
  };
}
