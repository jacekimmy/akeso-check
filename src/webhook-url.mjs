/* Where the app's webhook actually answers.
 *
 * Derived from the handler file the Check found, because a founder should
 * never have to tell the tool a path it can already see. This lived in two
 * places once, drifted, and produced "/api/api/stripe/webhook" in the verify
 * path — a run that could not test anything, reported as an untestable app.
 * One definition, used by everything.
 */

export function webhookUrlFor(detection, base) {
  const root = String(base || "").replace(/\/$/, "");
  const handler = detection.webhookHandlers?.[0] || null;

  /* Supabase Edge Functions are served from their own prefix, not the app. */
  const edgeFunction = handler?.file.match(/^supabase\/functions\/([^/]+)\//)?.[1];
  if (edgeFunction) return `${root}/functions/v1/${edgeFunction}`;

  if (!handler) return `${root}/api/stripe/webhook`;

  const routePath = handler.file
    .replace(/^app/, "api")                       /* Next app router: app/api/... -> api/... */
    .replace(/^pages\//, "")                      /* Next pages router: pages/api/... -> api/... */
    .replace(/\/route\.(ts|tsx|js|jsx|mjs)$/, "") /* app-router route files are directories */
    .replace(/\.(ts|tsx|js|jsx|mjs)$/, "")        /* pages-router files are the path itself */
    .replace(/^api\/api\//, "api/");              /* app/api/... would otherwise double up */

  return `${root}/${routePath.startsWith("api/") ? routePath : `api/${routePath}`}`;
}
