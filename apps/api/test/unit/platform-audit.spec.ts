import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **Every `/platform/*` write is audited, and this says by which of the two trails.**
 *
 * `platform-audit.ts` has claimed since 0f that this file exists and fails the build on a write
 * route with no audit. It did not exist. Written on 2026-09-15, when the back office tripled the
 * number of write routes — a comment asserting a guard that is not there is worse than no guard,
 * because it is read as one.
 *
 * There are two trails, deliberately:
 *
 * - **`recordOperatorAction`** writes into the *clinic's* own `audit_logs`, so their administrator
 *   can see what the vendor did to their account — creating it, suspending it, resetting an admin's
 *   password, filing a contract against it.
 * - **`recordPlatformAction`** writes with `tenant_id = NULL`, visible to no tenant session. Who we
 *   hire and what we agreed commercially is not a clinic's to read.
 * - **A database trigger** covers the three back-office tables, because the row itself is the
 *   record and a service-level call would duplicate it.
 *
 * A route in none of the three is the failure this catches.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const PLATFORM = path.join(API_ROOT, "src", "modules", "platform");

/**
 * Every write route on the platform surface, and how it is audited.
 *
 * `"trigger"` means the row lands in `audit_logs` from `audit_platform_row_change()` rather than
 * from a service call. `"own-account"` means the route acts only on the caller's own credential and
 * writes no record about anybody else — enrolling an authenticator, answering its challenge.
 */
const WRITE_ROUTES: { route: string; audited: "clinic-trail" | "vendor-trail" | "trigger" | "own-account" }[] = [
  { route: "POST /platform/login", audited: "own-account" },
  { route: "POST /platform/totp/enrol", audited: "own-account" },
  { route: "POST /platform/totp/confirm", audited: "own-account" },
  { route: "POST /platform/totp/verify", audited: "own-account" },
  // Recovery, 2026-09-16. `vendor-trail`, not `own-account`, and that is the whole point: it is the
  // one path that opens the console without the authenticator, so it writes its own audit action
  // rather than passing silently the way enrolling a phone does.
  { route: "POST /platform/totp/recovery", audited: "vendor-trail" },
  // Regenerating acts only on the caller's own credential, and demands both factors to do it.
  { route: "POST /platform/recovery-codes/regenerate", audited: "own-account" },
  // Beginning a replacement writes nothing; confirming it does, on the operator themselves.
  { route: "POST /platform/totp/replace", audited: "own-account" },
  { route: "POST /platform/totp/replace/confirm", audited: "vendor-trail" },
  { route: "POST /platform/clinics", audited: "clinic-trail" },
  { route: "POST /platform/clinics/:tenantId/suspension", audited: "clinic-trail" },
  { route: "POST /platform/clinics/:tenantId/admins/:userId/password", audited: "clinic-trail" },
  { route: "POST /platform/clinics/:tenantId/contracts", audited: "clinic-trail" },
  { route: "POST /platform/clinics/:tenantId/file", audited: "trigger" },
  { route: "POST /platform/clinics/:tenantId/contacts", audited: "trigger" },
  { route: "POST /platform/clinics/:tenantId/contacts/:contactId/remove", audited: "trigger" },
  { route: "POST /platform/operators", audited: "vendor-trail" },
  { route: "POST /platform/operators/:userId/role", audited: "vendor-trail" },
  { route: "POST /platform/operators/:userId/totp/reset", audited: "vendor-trail" },
];

/**
 * `@Controller("x")` plus each `@Post("y")`, as `POST /x/y` — **with the handler's own body**.
 *
 * The body matters, and the first version of this file did not collect it: it asked whether the
 * *file* contained `recordPlatformAction(`, so deleting the call from one of three handlers in the
 * same controller left the suite green. Caught by deleting exactly that and watching nothing fail —
 * the failure mode this project keeps finding in its own tooling.
 *
 * The body is everything from one route decorator to the next, which is coarse and sufficient: a
 * call sitting in the next handler down cannot satisfy the one above it.
 */
function writeRoutesIn(source: string): { route: string; body: string }[] {
  const base = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(source)?.[1] ?? "";
  const decorators = [...source.matchAll(/@(Post|Get|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)];

  return decorators.flatMap((match, index) => {
    if (match[1] !== "Post") return [];
    const start = match.index ?? 0;
    const end = decorators[index + 1]?.index ?? source.length;
    const tail = match[2] ?? "";
    const full = [base, tail].filter((part) => part !== "").join("/");
    return [{ route: `POST /${full}`, body: source.slice(start, end) }];
  });
}

describe("every platform write route is audited", () => {
  /** Route → the handler's own body, so an audit call is credited to the handler that makes it. */
  const found = new Map<string, string>();
  for (const file of sourceFiles(PLATFORM, [".controller.ts"])) {
    for (const entry of writeRoutesIn(stripComments(readFileSync(file, "utf8")))) {
      found.set(entry.route, entry.body);
    }
  }

  test("the manifest lists exactly the write routes that exist", () => {
    const listed = new Set(WRITE_ROUTES.map((entry) => entry.route));
    expect({
      inCodeButNotListed: [...found.keys()].filter((route) => !listed.has(route)).sort(),
      listedButNotInCode: [...listed].filter((route) => !found.has(route)).sort(),
    }).toEqual({ inCodeButNotListed: [], listedButNotInCode: [] });
  });

  test("the scanner can see the routes it is guarding, so an empty pass is impossible", () => {
    // Without this, renaming the module or changing the decorator makes every assertion above
    // vacuously true — the failure mode this project has found in its own tooling repeatedly.
    expect(found.size).toBeGreaterThanOrEqual(14);
  });

  test("each audited route makes the call itself, not merely somewhere in its controller", () => {
    const offenders = WRITE_ROUTES.filter((entry) => {
      const body = found.get(entry.route) ?? "";
      if (entry.audited === "clinic-trail") return !body.includes("recordOperatorAction(");
      if (entry.audited === "vendor-trail") return !body.includes("recordPlatformAction(");
      return false;
    }).map((entry) => entry.route);

    expect(offenders).toEqual([]);
  });

  test("the three trigger-audited tables are the three back-office tables, named in the migration", () => {
    // The other half of "audited by a trigger": the trigger has to be there. `audit-triggers`
    // counts them structurally; this names them, so a dropped trigger reads as a deleted line here.
    const migrations = path.join(API_ROOT, "prisma", "migrations");
    const sql = sourceFiles(migrations, [".sql"])
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const table of ["platform_clinic_files", "platform_clinic_contacts", "platform_clinic_contracts"]) {
      expect(sql).toContain(`CREATE TRIGGER ${table}_audit`);
    }
    expect(sql).toContain("audit_platform_row_change()");
  });
});
