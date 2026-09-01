/* Argument parsing shared by the commands.
 *
 * The bug this exists to prevent, found by running the real thing: picking
 * "the first argument that is not a flag" as the project directory silently
 * grabs the VALUE of a flag instead. `fix --apply --verify-url http://…` read
 * the URL as the project path, found no ledger there, and told the founder
 * nothing had ever been checked. Every flag that takes a value has to be
 * declared, in one place, or that returns in a different disguise.
 */

export const VALUE_FLAGS = new Set([
  "--html", "--webhook-secret", "--lifecycle-url", "--account",
  "--verify-url", "--probe-url", "--entitlements-url",
]);

export const SUBCOMMANDS = new Set(["check", "fix", "monitor"]);

export function flagValue(args, name) {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] ?? null : null;
}

/* The project directory, if the founder named one. Skips flags, skips the
   values that belong to them, and skips the subcommand itself. */
export function positionalPath(args, subcommand = null) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) { i += 1; continue; } /* skip the flag AND its value */
    if (arg.startsWith("-")) continue;
    if (arg === subcommand || SUBCOMMANDS.has(arg)) continue;
    return arg;
  }
  return null;
}
