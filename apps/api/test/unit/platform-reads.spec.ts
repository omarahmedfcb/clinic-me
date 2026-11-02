// Branches 6.5 (Q8 ruled 2026-10-31): every /platform GET says how its read is recorded, and its own handler makes the call.
// A clinic's own data is read into both trails; a cross-clinic list into the vendor's; the rest reads no clinic data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

const PLATFORM = path.join(__dirname, "..", "..", "src", "modules", "platform");

const READ_ROUTES: { route: string; read: "both-trails" | "vendor-trail" | "no-clinic-data" }[] = [
  { route: "GET /platform/clinics/:tenantId/file", read: "both-trails" },
  { route: "GET /platform/clinics/:tenantId/contracts/:contractId/content", read: "both-trails" },
  { route: "GET /platform/clinics", read: "vendor-trail" },
  { route: "GET /platform/branch-requests", read: "vendor-trail" },
  { route: "GET /platform/branch-limit-graces", read: "vendor-trail" },
  { route: "GET /platform/messages", read: "vendor-trail" },
  { route: "GET /platform/support-sessions", read: "vendor-trail" },
  { route: "GET /platform/me", read: "no-clinic-data" },
  { route: "GET /platform/build", read: "no-clinic-data" },
  { route: "GET /platform/operators", read: "no-clinic-data" },
];

function readRoutesIn(source: string): { route: string; body: string }[] {
  const base = /@Controller\(\s*["'`]([^"'`]*)["'`]\s*\)/.exec(source)?.[1] ?? "";
  const decorators = [...source.matchAll(/@(Post|Get|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)];
  return decorators.flatMap((match, index) => {
    if (match[1] !== "Get") return [];
    const body = source.slice(match.index ?? 0, decorators[index + 1]?.index ?? source.length);
    return [{ route: `GET /${[base, match[2] ?? ""].filter((part) => part !== "").join("/")}`, body }];
  });
}

describe("every platform read says how it is recorded", () => {
  const found = new Map<string, string>();
  for (const file of sourceFiles(PLATFORM, [".controller.ts"])) {
    for (const entry of readRoutesIn(stripComments(readFileSync(file, "utf8")))) found.set(entry.route, entry.body);
  }

  test("the manifest lists exactly the read routes that exist", () => {
    const listed = new Set(READ_ROUTES.map((entry) => entry.route));
    expect({
      inCodeButNotListed: [...found.keys()].filter((route) => !listed.has(route)).sort(),
      listedButNotInCode: [...listed].filter((route) => !found.has(route)).sort(),
    }).toEqual({ inCodeButNotListed: [], listedButNotInCode: [] });
  });

  test("the scanner can see the routes it is guarding", () => {
    expect(found.size).toBeGreaterThanOrEqual(9);
  });

  test("each recorded read is recorded by its own handler, into the trails its manifest entry names", () => {
    const offenders = READ_ROUTES.filter(({ route, read }) => {
      const body = found.get(route) ?? "";
      if (read === "no-clinic-data") return body.includes("recordOperatorRead(");
      const call = /recordOperatorRead\(\s*actor\s*,\s*\{([^}]*)\}/.exec(body)?.[1];
      if (call === undefined) return true;
      // As a property key (`tenantId,` or `tenantId:`), not a value: `entityId: tenantId` once passed for both-trails.
      const namesTenant = /(?:^|,)\s*tenantId\s*(?:[:,]|$)/.test(call);
      return read === "both-trails" ? !namesTenant : namesTenant;
    }).map(({ route }) => route);
    expect(offenders).toEqual([]);
  });
});
