// Whether the caller may reach an exception (BRANCHES-DESIGN §4.4): one branch must be inside their
// scope; every branch, once a clinic has two, needs a scope covering all of them.
import type { ExceptionScope } from "../../generated/prisma/enums.ts";
import { branchContext } from "../../common/branch-context.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import type { ScheduleWriteResult } from "./schedules.service.ts";

type Refusal = Extract<ScheduleWriteResult, { ok: false }>;

export async function refuseExceptionReach(
  tx: TransactionClient,
  scope: ExceptionScope,
  branchId: string | null,
): Promise<Refusal | null> {
  if (scope === "ONE_BRANCH") {
    const exists = branchId !== null && (await tx.branch.count({ where: { id: branchId } })) > 0;
    return exists && branchContext.allows(branchId!)
      ? null
      : { ok: false, code: "NOT_FOUND", params: { resource: "branch" } };
  }
  const active = await tx.branch.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (active.length <= 1) return null;
  if (!active.every((b) => branchContext.allows(b.id))) return { ok: false, code: "SCOPE_TOO_NARROW", params: {} };
  return null;
}

export async function activeBranchIds(tx: TransactionClient): Promise<string[]> {
  const rows = await tx.branch.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((b) => b.id);
}
