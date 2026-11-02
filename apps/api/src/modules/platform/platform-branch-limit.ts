// The operator sets a clinic's branch limit (BRANCHES-DESIGN §9 A, steps 6.1–6.2). The limit and its history row are
// written in one transaction under the clinic's row lock; lowering it below the active count opens a grace (step 6.3).
import { uuidv7 } from "uuidv7";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { reconcileGrace } from "../branches/branch-limit-grace.ts";
import type { ClinicResult } from "./platform-clinics.ts";

export interface BranchLimit {
  maxBranches: number;
  previousLimit: number;
  activeBranches: number;
}

type Changed = { ok: true; value: BranchLimit & { changeId: string } } | { ok: false; code: "NOT_FOUND" | "ALREADY_IN_THAT_STATE"; previousLimit?: number };

/** Inside a transaction bound to the clinic: lock its row, write the new limit and its history row. */
export async function changeBranchLimit(tx: TransactionClient, tenantId: string, actor: ActorContext, maxBranches: number, reason: string): Promise<Changed> {
  const locked = await tx.$queryRaw<{ max_branches: number }[]>`SELECT max_branches FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  const previousLimit = locked[0]?.max_branches;
  if (previousLimit === undefined) return { ok: false, code: "NOT_FOUND" };
  if (previousLimit === maxBranches) return { ok: false, code: "ALREADY_IN_THAT_STATE", previousLimit };

  await tx.tenant.update({ where: { id: tenantId }, data: { maxBranches } });
  const changeId = uuidv7();
  await tx.branchLimitChange.create({ data: injected({ id: changeId, previousLimit, newLimit: maxBranches, reason, changedBy: actor.userId }) });
  await reconcileGrace(tx, changeId, maxBranches, new Date());
  const activeBranches = await tx.branch.count({ where: { status: "ACTIVE" } });
  return { ok: true, value: { maxBranches, previousLimit, activeBranches, changeId } };
}

export async function setBranchLimit(
  actor: ActorContext,
  tenantId: string,
  input: { maxBranches: number; reason: string },
): Promise<ClinicResult<BranchLimit>> {
  const reason = input.reason.trim();
  if (reason === "") return { ok: false, code: "REASON_REQUIRED", params: {} };

  return withTenant<ClinicResult<BranchLimit>>(tenantId, actor, async (tx) => {
    const changed = await changeBranchLimit(tx, tenantId, actor, input.maxBranches, reason);
    if (changed.ok) {
      const { changeId: _changeId, ...value } = changed.value;
      return { ok: true as const, value };
    }
    return changed.code === "NOT_FOUND"
      ? { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } }
      : { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: String(changed.previousLimit) } };
  });
}
