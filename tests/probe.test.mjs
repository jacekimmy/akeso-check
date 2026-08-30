import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chooseProbeTarget, findAccessExports, installProbe, removeProbe } from "../src/probe.mjs";
import { detect } from "../src/detect.mjs";

test("recognises the shapes access functions actually take", () => {
  assert.deepEqual(
    findAccessExports(`export async function isPro(userId: string) { return true; }`),
    [{ name: "isPro", paramCount: 1, firstParam: "userId: string" }],
  );
  assert.deepEqual(
    findAccessExports(`export const hasAccess = async (id) => db.check(id);`),
    [{ name: "hasAccess", paramCount: 1, firstParam: "id" }],
  );
  /* an explicit entitlement function outranks a generic isPro downstream */
  const both = findAccessExports(`
    export function isPro(u) { return true; }
    export function getBillingEntitlement(accountId) { return {}; }
  `);
  assert.equal(both.length, 2);
});

test("refuses to wire a function it would have to guess at", async () => {
  const root = path.resolve("fixtures");
  await writeFile(path.join(root, "_tmp_multi.mjs"),
    "export async function hasAccess(userId, feature, ctx) { return true; }");
  const target = await chooseProbeTarget(root, [{ file: "_tmp_multi.mjs", score: 5, clientSideOnly: false }]);
  assert.equal(target.chosen, null);
  assert.match(target.reason, /guess/);
  const { rm } = await import("node:fs/promises");
  await rm(path.join(root, "_tmp_multi.mjs"));
});

test("a client-side gate is never offered as the server's answer", async () => {
  const target = await chooseProbeTarget(path.resolve("fixtures/broken-app"), [
    { file: "lib/handler.mjs", score: 4, clientSideOnly: true },
  ]);
  assert.equal(target.chosen, null);
});

test("install wires the real function, the probe executes, removal cleans up", async () => {
  const root = path.resolve("fixtures/broken-app");
  const detection = await detect(root);
  /* force the runnable target and a runnable template */
  detection.framework = { framework: "node-other" };
  detection.accessDecisionSites = [{ file: "lib/handler.mjs", score: 9, clientSideOnly: false }];

  const install = await installProbe(root, detection);
  try {
    assert.equal(install.wired, true, install.reason);
    assert.equal(install.target.name, "isPro");

    const written = await readFile(install.routeFile, "utf8");
    assert.match(written, /AKESO PROBE/);
    assert.match(written, /from "\.\.\/\.\.\/\.\.\/lib\/handler\.mjs"/);

    /* the generated route must actually run and give the app's own answer */
    await writeFile(path.join(root, "data", "profiles.json"),
      JSON.stringify({ probed: { is_pro: true }, other: { is_pro: false } }));
    const routeModule = await import(`${install.routeFile}?v=${Date.now()}`);
    const yes = await (await routeModule.GET(new Request("http://x/api/__akeso_probe?account=probed"))).json();
    const no = await (await routeModule.GET(new Request("http://x/api/__akeso_probe?account=other"))).json();
    assert.equal(yes.billingEntitled, true);
    assert.equal(no.billingEntitled, false);
  } finally {
    const removal = await removeProbe(install.routeFile);
    assert.equal(removal.removed, true);
  }
});

test("removal refuses a file that lost the Akeso marker", async () => {
  const root = path.resolve("fixtures/broken-app");
  const file = path.join(root, "app", "api", "__akeso_probe", "route.mjs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "// the founder kept and edited this file\nexport const theirs = true;\n");
  const removal = await removeProbe(file);
  assert.equal(removal.removed, false);
  assert.match(removal.reason, /marker/);
  const { rm } = await import("node:fs/promises");
  await rm(path.dirname(file), { recursive: true });
});
