// The operator's queue of requests to raise a clinic's branch limit (step 6.2). Read across clinics through
// platform_branch_requests(); an approval raises the limit through 6.1's own path and names the change it made.
import type { RefusalParams } from "../../common/refusals.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { changeBranchLimit } from "./platform-branch-limit.ts";

export interface QueuedRequest {
  id: string;
  tenantId: string;
  clinicName: string;
  status: string;
  requestedLimit: number;
  currentLimit: number;
  activeBranches: number;
  note: string | null;
  requestedByName: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
}

export type DecisionResult =
  | { ok: true; value: { id: string; tenantId: string; status: "APPROVED" | "REJECTED"; maxBranches: number } }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_DECIDED" | "REASON_REQUIRED" | "ALREADY_IN_THAT_STATE"; params: RefusalParams };

export async function listBranchRequestQueue(actor: ActorContext): Promise<QueuedRequest[]> {
  return withPlatformActor(actor, (tx) =>
    tx.$queryRaw<QueuedRequest[]>`
      SELECT id, tenant_id AS "tenantId", clinic_name AS "clinicName", status::text AS status, requested_limit AS "requestedLimit",
             current_limit AS "currentLimit", active_branches AS "activeBranches", note, requested_by_name AS "requestedByName",
             created_at AS "createdAt", decided_at AS "decidedAt", decision_reason AS "decisionReason"
        FROM platform_branch_requests()`,
  );
}

export interface UnresolvedGrace {
  id: string;
  tenantId: string;
  clinicName: string;
  status: string;
  currentLimit: number;
  activeBranches: number;
  startedAt: Date;
  endsAt: Date;
  deferredAt: Date | null;
  deferredReason: string | null;
}

export async function listUnresolvedGraces(actor: ActorContext): Promise<UnresolvedGrace[]> {
  return withPlatformActor(actor, (tx) =>
    tx.$queryRaw<UnresolvedGrace[]>`
      SELECT id, tenant_id AS "tenantId", clinic_name AS "clinicName", status::text AS status, current_limit AS "currentLimit",
             active_branches AS "activeBranches", started_at AS "startedAt", ends_at AS "endsAt",
             deferred_at AS "deferredAt", deferred_reason AS "deferredReason"
        FROM platform_branch_limit_graces()`,
  );
}

export async function decideBranchRequest(actor: ActorContext, requestId: string, input: { approve: boolean; reason?: string }): Promise<DecisionResult> {
  const reason = input.reason?.trim() ?? "";
  if (!input.approve && reason === "") return { ok: false, code: "REASON_REQUIRED", params: {} };
  const queued = (await listBranchRequestQueue(actor)).find((request) => request.id === requestId);
  if (queued === undefined) return { ok: false, code: "NOT_FOUND", params: { resource: "branchRequest" } };

  return withTenant<DecisionResult>(queued.tenantId, actor, async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; requested_limit: number }[]>`
      SELECT status::text AS status, requested_limit FROM branch_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
    const request = rows[0];
    if (request === undefined) return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "branchRequest" as const } };
    if (request.status !== "PENDING") return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: request.status } };
    const decided = { decidedBy: actor.userId, decidedAt: new Date(), decisionReason: reason === "" ? null : reason };

    if (!input.approve) {
      await tx.branchRequest.update({ where: { id: requestId }, data: { status: "REJECTED", ...decided } });
      return { ok: true as const, value: { id: requestId, tenantId: queued.tenantId, status: "REJECTED" as const, maxBranches: queued.currentLimit } };
    }
    const current = (await tx.$queryRaw<{ max_branches: number }[]>`SELECT max_branches FROM tenants WHERE id = ${queued.tenantId}::uuid FOR UPDATE`)[0]?.max_branches;
    if (current !== undefined && request.requested_limit <= current) {
      return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: String(current) } };
    }
    const changed = await changeBranchLimit(tx, queued.tenantId, actor, request.requested_limit, reason === "" ? `branch request ${requestId}` : reason);
    if (!changed.ok) {
      return changed.code === "NOT_FOUND"
        ? { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } }
        : { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: String(changed.previousLimit) } };
    }
    await tx.branchRequest.update({ where: { id: requestId }, data: { status: "APPROVED", limitChangeId: changed.value.changeId, ...decided } });
    return { ok: true as const, value: { id: requestId, tenantId: queued.tenantId, status: "APPROVED" as const, maxBranches: changed.value.maxBranches } };
  });
}
