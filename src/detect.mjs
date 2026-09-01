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

/* Which table and column actually hold paid access. The Fix generates real
   queries from this, so a guess would produce code that runs against a table
   the app does not have. Evidence is counted across the whole codebase and the
   winner is reported WITH its confidence — "profiles"/"billing_entitled" is
   the fallback, and the caller is told when that is all it is. */
const TABLE_READ = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/gi;
const ENTITLEMENT_COLUMN = /\b(is_pro|is_premium|is_paid|is_plus|has_access|is_subscribed|billing_entitled|subscription_status|plan|tier)\b/gi;
const BILLING_TABLES = new Set(["profiles", "users", "accounts", "subscriptions", "subscribers", "customers", "entitlements", "billing"]);

/* Prisma and Drizzle apps declare their tables in a schema file, not in
   query strings, so the query-string scan above finds nothing and falls back
   to "profiles". Five of eight real starter kits did exactly that. The model
   or table that carries Stripe-ish fields is the one billing lives in, and
   its most entitlement-like field is the column. */
const STRIPEY = /stripe|subscription|plan|is_?pro|is_?paid|premium|entitle/i;
const ENTITLEMENT_FIELD_RANK = [
  /^(is_?pro|is_?paid|is_?premium|has_?access|is_?subscribed|billing_?entitled|active|is_?active)$/i,
  /^(subscription_?status|status)$/i,
  /^(plan|plan_?name|tier|stripe_?price_?id)$/i,
  /^stripe_?current_?period_?end$/i,
];
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/* The text inside a {...} starting at `open`, honouring nested braces and
   skipping string literals, so an option object like { mode: "date" } inside
   a column definition cannot end the walk early. */
function balancedBody(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "\`") { quote = ch; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

async function findSchemaDeclaredStorage(root, sourceFiles) {
  const candidates = [];

  /* Prisma: model Name { field Type ... } blocks, table renamed by @@map. */
  const prismaRaw = await readIfThere(path.join(root, "prisma", "schema.prisma"))
    || await readIfThere(path.join(root, "schema.prisma"));
  if (prismaRaw) {
    for (const match of prismaRaw.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      const [, model, body] = match;
      const fields = [...body.matchAll(/^\s*(\w+)\s+\w+/gm)].map((m) => m[1]).filter((f) => !/^@@/.test(f));
      const stripey = fields.filter((f) => STRIPEY.test(f));
      if (!stripey.length && !STRIPEY.test(model)) continue;
      const mapped = body.match(/@@map\(\s*"([^"]+)"\s*\)/)?.[1];
      candidates.push({ table: mapped || model, fields, hits: stripey.length + (STRIPEY.test(model) ? 2 : 0), source: "prisma" });
    }
  }

  /* Drizzle: pgTable("name", { field: ... }) or mysqlTable/sqliteTable. */
  for (const file of sourceFiles) {
    if (!/schema|db|drizzle/i.test(file)) continue;
    const content = await readIfThere(file);
    if (!content || !/(pg|mysql|sqlite)Table\(/.test(content)) continue;
    for (const match of content.matchAll(/(?:pg|mysql|sqlite)Table\(\s*["'\`]([\w-]+)["'\`]\s*,\s*\{/g)) {
      /* The column object is read to its matching brace, not to the next
         newline: a one-line pgTable() declaration otherwise swallowed the
         table declared after it and took credit for its Stripe fields. */
      const table = match[1];
      const body = balancedBody(content, match.index + match[0].length - 1);
      if (body === null) continue;
      const fields = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
      const stripey = fields.filter((f) => STRIPEY.test(f));
      if (!stripey.length && !STRIPEY.test(table)) continue;
      candidates.push({ table, fields, hits: stripey.length + (STRIPEY.test(table) ? 2 : 0), source: "drizzle" });
    }
  }

  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => b.hits - a.hits)[0];
  let column = null;
  for (const pattern of ENTITLEMENT_FIELD_RANK) {
    column = best.fields.find((f) => pattern.test(f) || pattern.test(snake(f)));
    if (column) break;
  }
  return { table: best.table, column, source: best.source, fields: best.fields.filter((f) => STRIPEY.test(f)) };
}

async function findEntitlementStorage(root, sourceFiles, accessDecisionSites) {
  const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const tables = new Map();
  const columns = new Map();

  /* A declared schema outranks a guess from query strings: it is the
     database's own statement of what exists. */
  const declared = await findSchemaDeclaredStorage(root, sourceFiles);
  if (declared) {
    return {
      entitlementTable: declared.table,
      entitlementColumn: declared.column || "billing_entitled",
      tableConfirmed: true,
      columnConfirmed: Boolean(declared.column),
      schemaSource: declared.source,
      evidence: { tables: [{ name: declared.table, hits: 1, source: declared.source }], columns: declared.fields.map((name) => ({ name, hits: 1 })) },
    };
  }
  /* Files the ranking already believes decide access are worth more than a
     random file that happens to mention a table. */
  const weighted = new Set(accessDecisionSites.slice(0, 5).map((site) => site.file));

  for (const file of sourceFiles) {
    const content = await readIfThere(file);
    if (!content) continue;
    const weight = weighted.has(path.relative(root, file)) ? 3 : 1;
    for (const match of content.matchAll(TABLE_READ)) {
      if (!BILLING_TABLES.has(match[1].toLowerCase())) continue;
      for (let i = 0; i < weight; i += 1) tally(tables, match[1]);
    }
    for (const match of content.matchAll(ENTITLEMENT_COLUMN)) {
      for (let i = 0; i < weight; i += 1) tally(columns, match[1].toLowerCase());
    }
  }

  const best = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const table = best(tables);
  const column = best(columns);
  return {
    entitlementTable: table?.[0] || "profiles",
    entitlementColumn: column?.[0] || "billing_entitled",
    /* Confidence is reported, never implied. Generated code says out loud when
       it is working from a default instead of from evidence. */
    tableConfirmed: Boolean(table),
    columnConfirmed: Boolean(column),
    evidence: {
      tables: [...tables.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, hits]) => ({ name, hits })),
      columns: [...columns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, hits]) => ({ name, hits })),
    },
  };
}

/* Whether this project is TypeScript, and whether "@/..." resolves in it.
   Both decide what generated code may look like: writing .ts into a plain
   JavaScript project, or an "@/" import into a project with no such alias,
   produces a file that cannot even load. */
async function detectLanguage(root) {
  const tsconfigRaw = await readIfThere(path.join(root, "tsconfig.json"));
  let pathAlias = null;
  if (tsconfigRaw) {
    try {
      /* tsconfig allows comments and trailing commas, so a strict parse fails
         on perfectly valid files. Both are stripped before parsing. */
      const cleaned = tsconfigRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
      const paths = JSON.parse(cleaned)?.compilerOptions?.paths || {};
      const alias = Object.keys(paths).find((key) => key.endsWith("/*"));
      if (alias) pathAlias = alias.slice(0, -1); /* "@/*" -> "@/" */
    } catch { /* an unparseable tsconfig just means no alias is assumed */ }
  }
  return { typescript: Boolean(tsconfigRaw), pathAlias };
}

export async function detect(root) {
  const framework = { ...await detectFramework(root), ...await detectLanguage(root) };
  const env = await readEnv(root);
  const pkgRaw = await readIfThere(path.join(root, "package.json"));
  let deps = {};
  try { const pkg = JSON.parse(pkgRaw || "{}"); deps = { ...pkg.dependencies, ...pkg.devDependencies }; } catch { /* reported by detectFramework */ }

  const stripe = detectStripe(env.values, deps);
  const database = detectDatabase(env.values, deps);
  const sourceFiles = await collectSourceFiles(root);
  const webhookHandlers = await findWebhookHandler(root, sourceFiles);
  const accessDecisionSites = await findAccessDecisionSites(root, sourceFiles);
  const storage = await findEntitlementStorage(root, sourceFiles, accessDecisionSites);
  Object.assign(database, storage);

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
