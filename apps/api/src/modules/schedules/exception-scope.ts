// An exception's reach, decided explicitly (rulings of 2026-10-29): a doctor's absence is every branch
// by default; a closure with no doctor has no default once two branches exist; extra availability is one.
import type { ExceptionScope, ScheduleExceptionType } from "../../generated/prisma/enums.ts";

export interface ScopeRequest {
  type: ScheduleExceptionType;
  doctorId: string | null;
  branchId: string | null;
  scope: ExceptionScope | null;
}

export type ScopeDecision =
  | { ok: true; scope: ExceptionScope; branchId: string | null }
  | { ok: false; code: "BRANCH_REQUIRED" | "INVALID_FIELD" };

export function resolveExceptionScope(request: ScopeRequest, activeBranchIds: readonly string[]): ScopeDecision {
  if (request.scope === "EVERY_BRANCH" && request.branchId !== null) return { ok: false, code: "INVALID_FIELD" };
  if (request.branchId !== null) return { ok: true, scope: "ONE_BRANCH", branchId: request.branchId };

  const only = activeBranchIds.length === 1 ? activeBranchIds[0]! : null;
  const oneBranchOrAsk = (): ScopeDecision =>
    only === null ? { ok: false, code: "BRANCH_REQUIRED" } : { ok: true, scope: "ONE_BRANCH", branchId: only };

  if (request.type === "EXTRA_AVAILABILITY") {
    return request.scope === "EVERY_BRANCH" ? { ok: false, code: "BRANCH_REQUIRED" } : oneBranchOrAsk();
  }
  if (request.scope === "EVERY_BRANCH") return { ok: true, scope: "EVERY_BRANCH", branchId: null };
  if (request.doctorId !== null && request.scope === null) return { ok: true, scope: "EVERY_BRANCH", branchId: null };
  return oneBranchOrAsk();
}
