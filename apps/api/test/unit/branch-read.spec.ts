import { branchContext, NO_MEMBERSHIP, type BranchContext } from "../../src/common/branch-context.ts";
import { inReadBranches, readBranches, readBranchWhere } from "../../src/common/branch-read.ts";
import { ALL_BRANCHES } from "../../src/common/branch-scope.ts";

const context = (allowed: string[], selected: string): BranchContext => ({ allowed, selected, isMultiBranch: allowed.length > 1, branches: [] });

describe("the branches a scoped read covers (BRANCHES-DESIGN §4.3)", () => {
  test("outside any request, an unattended process reads the whole clinic", () => {
    expect(readBranches()).toBeNull();
    expect(readBranchWhere()).toEqual({});
    expect(inReadBranches("anything")).toBe(true);
  });

  test("a selected branch narrows the read to it", () => {
    branchContext.run(context(["A", "B"], "A"), () => {
      expect(readBranches()).toEqual(["A"]);
      expect(readBranchWhere()).toEqual({ branchId: { in: ["A"] } });
      expect(inReadBranches("B")).toBe(false);
    });
  });

  test("no single selection reads every branch the caller holds, and never another", () => {
    branchContext.run(context(["A", "B"], ALL_BRANCHES), () => {
      expect(readBranches()).toEqual(["A", "B"]);
      expect(inReadBranches("C")).toBe(false);
    });
  });

  test("a request with no membership reads nothing", () => {
    branchContext.run(NO_MEMBERSHIP, () => {
      expect(readBranches()).toEqual([]);
      expect(inReadBranches("A")).toBe(false);
    });
  });
});
