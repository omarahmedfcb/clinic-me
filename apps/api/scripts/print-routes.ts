import path from "node:path";
import { apiRoutes } from "./route-capabilities.ts";

/**
 * `npm run routes` — the manifest as a table, for reading rather than for asserting.
 *
 * A separate file from `route-capabilities.ts` because that module is loaded two different ways and
 * neither of the usual "am I the entry point" idioms works in both. `apps/api/package.json` declares
 * no `"type"`, so **jest's swc transform treats it as CommonJS while `node` treats it as ESM** —
 * Node decides by looking for `import`/`export` syntax. `import.meta` fails the typecheck (TS1470)
 * and `require.main` throws at runtime; both were tried. A file that is only ever a script needs no
 * guard at all, which is the simpler answer.
 *
 * Paths come from `process.argv[1]`, defined under both module systems, rather than from
 * `process.cwd()` — so this prints the same table whichever directory it is invoked from.
 */
const apiRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const routes = apiRoutes(path.join(apiRoot, "src"), repoRoot);

const width = Math.max(...routes.map((route) => route.path.length));
for (const route of routes) {
  const capability = route.capability ?? "— (no @RequirePermission)";
  console.log(`${route.method.padEnd(6)} ${route.path.padEnd(width)}  ${capability}`);
}

const capabilities = new Set(routes.map((route) => route.capability).filter((c) => c !== null));
console.log(
  `\n${String(routes.length)} routes, ${String(capabilities.size)} of the matrix's capabilities in use.`,
);
