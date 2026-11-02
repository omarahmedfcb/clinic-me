// Branches step 5g: every scoped GET in BRANCH_ENFORCEMENT has a branch-read case, and each case names a spec that exists
// and contains its text. A new scoped GET with no case fails here; only a named ruling may hold one back.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { AWAITING_RULING, BRANCH_READ_CASES } from "../integration/branch-read-cases.ts";

const scopedGets = Object.entries(BRANCH_ENFORCEMENT)
  .filter(([route, status]) => route.startsWith("GET ") && status === "scoped")
  .map(([route]) => route)
  .sort();
const specPath = (spec: string): string => path.join(__dirname, "..", "integration", `${spec}.integration.spec.ts`);

describe("branch-read cases (step 5g)", () => {
  test("every scoped GET has a case, or a named ruling it waits on", () => {
    expect(scopedGets.filter((route) => !(route in BRANCH_READ_CASES) && !(route in AWAITING_RULING))).toEqual([]);
  });

  test("no case or waiting entry names anything but a scoped GET, and none is both", () => {
    const keys = [...Object.keys(BRANCH_READ_CASES), ...Object.keys(AWAITING_RULING)];
    expect(keys.filter((route) => !scopedGets.includes(route))).toEqual([]);
    expect(Object.keys(AWAITING_RULING).filter((route) => route in BRANCH_READ_CASES)).toEqual([]);
  });

  test("each case's spec exists and contains its text", () => {
    const broken = Object.entries(BRANCH_READ_CASES)
      .filter(([, { spec, contains }]) => !existsSync(specPath(spec)) || !readFileSync(specPath(spec), "utf8").includes(contains))
      .map(([route, { spec }]) => `${route} -> ${spec}`);
    expect(broken).toEqual([]);
  });
});
