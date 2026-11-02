import { branchContext, NO_MEMBERSHIP, type BranchContext } from "../../src/common/branch-context.ts";
import { inReadBranches, readBranches, readBranchWhere, readSet, writeBranches } from "../../src/common/branch-read.ts";
import { ALL_BRANCHES } from "../../src/common/branch-scope.ts";

const SUSPENDED_AT = new Date("2031-01-01T00:00:00Z");
const context = (allowed: string[], selected: string, extra: Partial<BranchContext> = {}): BranchContext =>
  ({ allowed, selected, isMultiBranch: allowed.length > 1, branches: [], ...extra });

describe("the branch sets a request reads and writes (BRANCHES-DESIGN §4.3, §9 A)", () => {
  test("outside any request, an unattended process reads and writes the whole clinic", () => {
    expect(readSet()).toBeNull();
    expect(writeBranches()).toBeNull();
    expect(readBranchWhere("scheduledStart")).toEqual({});
    expect(inReadBranches("anything")).toBe(true);
  });

  test("a branch the header names narrows the read to it", () => {
    branchContext.run(context(["A", "B"], "A", { named: true, readSuspended: [{ id: "S", suspendedAt: SUSPENDED_AT }] }), () => {
      expect(readBranches()).toEqual(["A"]);
      expect(readBranchWhere("scheduledStart")).toEqual({ branchId: { in: ["A"] } });
      expect(inReadBranches("B")).toBe(false);
    });
  });

  test("no header reads every branch held, and never another", () => {
    branchContext.run(context(["A", "B"], ALL_BRANCHES), () => {
      expect(readBranches()).toEqual(["A", "B"]);
      expect(inReadBranches("C")).toBe(false);
    });
  });

  test("a suspended branch is read, only before its suspension, and is never in the write set", () => {
    branchContext.run(context(["A"], "A", { readSuspended: [{ id: "S", suspendedAt: SUSPENDED_AT }] }), () => {
      expect(readBranches()).toEqual(["A", "S"]);
      expect(writeBranches()).toEqual(["A"]);
      expect(readBranchWhere("paidAt")).toEqual({ OR: [{ branchId: { in: ["A"] } }, { branchId: "S", paidAt: { lt: SUSPENDED_AT } }] });
      expect(inReadBranches("S", new Date("2030-12-31T23:59:59Z"))).toBe(true);
      expect(inReadBranches("S", SUSPENDED_AT)).toBe(false);
      expect(inReadBranches("S")).toBe(false);
    });
  });

  test("a request with no membership reads and writes nothing", () => {
    branchContext.run(NO_MEMBERSHIP, () => {
      expect(readBranches()).toEqual([]);
      expect(writeBranches()).toEqual([]);
      expect(inReadBranches("A")).toBe(false);
    });
  });
});
