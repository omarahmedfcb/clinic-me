// An application-written audit row's reach: the request's one selected branch, the same value withTenant
// binds for audit_row_change, else UNSCOPED. Omitting the branch header is recorded, never dropped.
import { branchContext } from "./branch-context.ts";

export function requestAuditReach(): { branchId: string | null; scope: "ONE_BRANCH" | "UNSCOPED" } {
  const branchId = branchContext.selectedSingle() ?? null;
  return branchId === null ? { branchId: null, scope: "UNSCOPED" } : { branchId, scope: "ONE_BRANCH" };
}
