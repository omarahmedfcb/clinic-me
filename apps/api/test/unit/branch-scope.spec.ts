import { scheduledTemplateBranches, selectBranch, type BranchFacts } from "../../src/common/branch-scope.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";

const A = "0193a000-0000-7000-8000-00000000000a";
const B = "0193a000-0000-7000-8000-00000000000b";
const C = "0193a000-0000-7000-8000-00000000000c";

const twoBranches = (overrides: Partial<BranchFacts>): BranchFacts => ({
  scope: "ALL",
  activeBranchIds: [A, B],
  defaultBranchId: A,
  memberBranchIds: [],
  scheduledBranchIds: [],
  ...overrides,
});

describe("a single-branch clinic resolves to its one branch, whatever the scope", () => {
  for (const scope of ["ALL", "SELECTED", "SCHEDULED"] as const) {
    test(scope, () => {
      const facts: BranchFacts = { ...twoBranches({ scope }), activeBranchIds: [A] };
      expect(selectBranch(facts, undefined)).toEqual({ allowed: [A], selected: A, isMultiBranch: false });
    });
  }
});

describe("membership scope in a multi-branch clinic", () => {
  test("ALL may act in every active branch, and no header means all of them", () => {
    expect(selectBranch(twoBranches({ scope: "ALL" }), undefined)).toEqual({
      allowed: [A, B],
      selected: "all",
      isMultiBranch: true,
    });
  });

  test("SELECTED is held to its listed branches", () => {
    expect(selectBranch(twoBranches({ scope: "SELECTED", memberBranchIds: [B] }), undefined)?.allowed).toEqual([B]);
  });

  test("SCHEDULED follows the doctor's current templates", () => {
    expect(selectBranch(twoBranches({ scope: "SCHEDULED", scheduledBranchIds: [B] }), undefined)?.allowed).toEqual([B]);
  });

  test("a SCHEDULED doctor with no current template falls back to the default branch, not a refusal", () => {
    expect(selectBranch(twoBranches({ scope: "SCHEDULED" }), undefined)).toEqual({
      allowed: [A],
      selected: A,
      isMultiBranch: true,
    });
  });

  test("a listed branch that is no longer active is not allowed", () => {
    expect(selectBranch(twoBranches({ scope: "SELECTED", memberBranchIds: [B, C] }), undefined)?.allowed).toEqual([B]);
  });
});

describe("X-Branch-Id", () => {
  test("names one allowed branch", () => {
    expect(selectBranch(twoBranches({}), B)?.selected).toBe(B);
  });

  test("outside the allowed set is refused", () => {
    expect(selectBranch(twoBranches({ scope: "SELECTED", memberBranchIds: [A] }), B)).toBeNull();
    expect(selectBranch(twoBranches({}), C)).toBeNull();
    expect(selectBranch(twoBranches({}), "not-a-uuid")).toBeNull();
  });

  test("`all` with a one-branch scope is that branch", () => {
    expect(selectBranch(twoBranches({ scope: "SELECTED", memberBranchIds: [B] }), "all")?.selected).toBe(B);
  });
});

describe("SCHEDULED counts every template not yet ended, judged in the clinic's own calendar", () => {
  // 21:00 UTC on the 28th is already the 29th at UTC+4, a zone with no daylight saving.
  const instant = new Date("2026-10-28T21:00:00Z");
  const templates = [{ branchId: B, validFrom: "2026-01-01", validTo: "2026-10-28" }];

  test("the template that ended on the 28th no longer counts in the clinic", () => {
    expect(todayInClinic("Asia/Dubai", instant)).toBe("2026-10-29");
    expect(scheduledTemplateBranches(templates, todayInClinic("Asia/Dubai", instant))).toEqual([]);
  });

  test("whereas judging by UTC would still have counted it", () => {
    expect(scheduledTemplateBranches(templates, instant.toISOString().slice(0, 10))).toEqual([B]);
  });

  test("a template starting next week counts now, so nobody's scope changes by itself on Monday", () => {
    expect(scheduledTemplateBranches([{ branchId: B, validFrom: "2026-11-02", validTo: null }], "2026-10-29")).toEqual([B]);
  });
});
