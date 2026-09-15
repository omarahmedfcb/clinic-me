import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `permissionSummary()` returns something that looks authoritative and is not. It is a display
 * hint: `GET /auth/me` sends it so the UI can hide controls, and it is sent to a client, which
 * means it is a claim the client can modify.
 *
 * The doc comment on the function says "never authorise from this". A comment is the weakest guard
 * this project has used, and this is the one place that failure would be invisible — a service
 * branching on `summary.payments === "full"` reads like a permission check, passes review, and
 * enforces nothing, because the value came from a helper rather than from `PermissionGuard`
 * evaluating the role in a validated token.
 *
 * So the allowed callers are enumerated. Adding one is a deliberate act with this test in the way,
 * rather than an import somebody adds while wiring a feature.
 *
 * **If you are here because this test failed:** the fix is almost never to add your file to the
 * list. It is `@RequirePermission(capability, level)` on the route. Authorisation happens at the
 * boundary, per request, against the token — not from a map somebody passed around.
 */

/** Files permitted to import `permissionSummary`. Rendering and its own tests, nothing else. */
const ALLOWED = new Set([
  path.join("src", "modules", "auth", "auth.controller.ts"),
  path.join("src", "common", "permissions.ts"),
  path.join("src", "common", "permissions.spec.ts"),
  path.join("test", "unit", "permission-summary-is-display-only.spec.ts"),

  // Added 2026-08-27, and worth justifying rather than waving through: this spec asserts that the
  // shell's SIDEBAR follows the matrix instead of a second hand-kept copy of it. That is display
  // behaviour being tested against the matrix -- the legitimate use -- not authorisation. It would
  // not be legitimate for a file that decided whether a request may proceed.
  path.join("test", "unit", "shell-navigation.spec.ts"),
]);

const API_ROOT = path.resolve(__dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("permissionSummary is display-only", () => {
  const files = [...sourceFiles(path.join(API_ROOT, "src")), ...sourceFiles(path.join(API_ROOT, "test"))];

  test("the scan actually looks at this codebase, so an empty result cannot pass", () => {
    // Without this, a broken path would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(30);
  });

  test("only the enumerated files import it", () => {
    const importers = files
      .filter((file) => /\bpermissionSummary\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(API_ROOT, file))
      .filter((relative) => !ALLOWED.has(relative))
      .sort();

    expect(importers).toEqual([]);
  });

  test("at least one allowed file actually uses it, so the list is not stale", () => {
    // A permitted caller that no longer exists would leave this test guarding nothing while
    // continuing to pass.
    const used = files.some(
      (file) =>
        ALLOWED.has(path.relative(API_ROOT, file)) &&
        path.relative(API_ROOT, file) !== path.join("src", "common", "permissions.ts") &&
        /\bpermissionSummary\b/.test(readFileSync(file, "utf8")),
    );
    expect(used).toBe(true);
  });
});
