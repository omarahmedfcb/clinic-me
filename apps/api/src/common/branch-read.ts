// The branches a scoped read covers (BRANCHES-DESIGN §4.3): the one X-Branch-Id selects, else every branch
// the caller holds. Null outside a request, where an unattended process reads the whole clinic.
import { branchContext } from "./branch-context.ts";

export function readBranches(): readonly string[] | null {
  const context = branchContext.tryGet();
  if (context === undefined) return null;
  const single = branchContext.selectedSingle();
  return single === undefined ? context.allowed : [single];
}

/** A Prisma `where` fragment narrowing a branch-stamped model to the read's branches; empty when unattended. */
export function readBranchWhere(): { branchId?: { in: string[] } } {
  const branches = readBranches();
  return branches === null ? {} : { branchId: { in: [...branches] } };
}

export function inReadBranches(branchId: string): boolean {
  const branches = readBranches();
  return branches === null || branches.includes(branchId);
}
