// A write whose stored row lies outside the caller's branches is recorded, then answered by the caller
// exactly as a missing row: the same not-found, so the refusal confirms nothing (BRANCHES-DESIGN §4.2).
import { branchContext } from "./branch-context.ts";
import { injectedIdOnly } from "../prisma/injected.ts";
import type { ActorContext, TransactionClient } from "../prisma/with-tenant.ts";

export interface RefusingCaller {
  tenantId: string;
  actor: ActorContext;
  role: string;
}

export async function refusedOutOfBranch(
  tx: TransactionClient,
  caller: RefusingCaller,
  row: { table: string; id: string; branchId: string },
): Promise<boolean> {
  if (branchContext.allows(row.branchId)) return false;
  await tx.auditLog.create({
    data: injectedIdOnly({
      tenantId: caller.tenantId,
      actorUserId: caller.actor.userId,
      actorRole: caller.role,
      action: "BRANCH_SCOPE_REFUSED",
      entityType: row.table,
      entityId: row.id,
      branchId: row.branchId,
      scope: "ONE_BRANCH",
      newState: { allowed: branchContext.tryGet()?.allowed ?? [] },
      ipAddress: caller.actor.ip,
      userAgent: caller.actor.userAgent,
    }),
  });
  return true;
}
