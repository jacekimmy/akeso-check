// The single source of truth for this fixture's webhook behaviour.
// Deliberately the classic vibe-coded shape:
//   - trusts the parsed JSON body outright (signature never checked)
//   - grants on checkout.session.completed
//   - ignores every cancellation, failure, and refund event
// The result: canceled customers keep access forever. The Check must catch it.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "profiles.json");

export async function readProfiles() {
  try { return JSON.parse(await readFile(DB, "utf8")); } catch { return {}; }
}

async function writeProfiles(profiles) {
  await writeFile(DB, JSON.stringify(profiles, null, 2));
}

export async function handleWebhook(rawBody /* string */, _signatureHeader) {
  const event = JSON.parse(rawBody); // no verification: anyone could forge this

  if (event.type === "checkout.session.completed") {
    const profiles = await readProfiles();
    const account = event.data.object.client_reference_id;
    profiles[account] = { ...profiles[account], is_pro: true };
    await writeProfiles(profiles);
  }
  // every other event type: silently ignored
  return { received: true };
}

// Where this app decides who has paid access.
export async function isPro(accountId) {
  const profiles = await readProfiles();
  return Boolean(profiles[accountId]?.is_pro);
}
