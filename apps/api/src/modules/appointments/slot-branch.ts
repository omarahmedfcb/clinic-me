// The branch a slot token books into: the one it signs. A branch outside the caller's scope reads as not
// found (BRANCHES-DESIGN §4.2); since stage 5 there is no token without a branch, and no guessing one.
import { branchContext } from "../../common/branch-context.ts";

export type SlotBranch =
  | { ok: true; branchId: string }
  | { ok: false; code: "NOT_FOUND"; params: { resource: "branch" } };

export function resolveSlotBranch(tokenBranchId: string): SlotBranch {
  if (!branchContext.allows(tokenBranchId)) return { ok: false, code: "NOT_FOUND", params: { resource: "branch" } };
  return { ok: true, branchId: tokenBranchId };
}
