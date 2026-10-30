import path from "node:path";
import { BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { apiRoutes, countVerbDecorators } from "../../scripts/route-capabilities.ts";

const API_SRC = path.resolve(__dirname, "..", "..", "src");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ROUTES = apiRoutes(API_SRC, REPO_ROOT);

describe("every route says how branch scope applies to it", () => {
  test("the route extraction lost nothing", () => {
    expect(ROUTES).toHaveLength(countVerbDecorators(API_SRC));
  });

  test("no route is missing from BRANCH_ENFORCEMENT", () => {
    const missing = ROUTES.filter((r) => !(`${r.method} ${r.path}` in BRANCH_ENFORCEMENT)).map(
      (r) => `${r.method} ${r.path}  (${r.source})`,
    );
    expect(missing).toEqual([]);
  });

  test("no entry names a route that does not exist", () => {
    const served = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(BRANCH_ENFORCEMENT).filter((key) => !served.has(key))).toEqual([]);
  });

  test("the clinical file is never branch-scoped", () => {
    const clinical = Object.entries(BRANCH_ENFORCEMENT).filter(
      ([route, status]) =>
        status !== "clinic-level" &&
        /\/(clinical-|prescription|sick-leave|investigations|procedures|medications|attachments?|attachment-summary)|^\w+ \/patients(\/|$)|\/visit(\/|$)|\/visit\/draft/.test(route) &&
        !route.endsWith("/pricing"),
    );
    expect(clinical).toEqual([]);
  });
});
