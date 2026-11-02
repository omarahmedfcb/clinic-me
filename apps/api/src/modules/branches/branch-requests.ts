// A clinic asks the operator to raise its branch limit (BRANCHES-DESIGN §1.4, §9 A, step 6.2). One request may be
// pending at a time (a partial unique index); the clinic may withdraw it. The button is step 8.
import { uuidv7 } from "uuidv7";
import type { RefusalCode, RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

export interface RequestCaller {
  tenantId: string;
  actor: ActorContext;
}

export interface BranchRequestView {
  id: string;
  requestedLimit: number;
  note: string | null;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
}

export type RequestResult<T> = { ok: true; value: T } | { ok: false; code: RefusalCode; params: RefusalParams };

const VIEW = { id: true, requestedLimit: true, note: true, status: true, createdAt: true, decidedAt: true, decisionReason: true } as const;

export async function requestBranchLimit(caller: RequestCaller, input: { requestedLimit: number; note?: string }): Promise<RequestResult<BranchRequestView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const locked = await tx.$queryRaw<{ max_branches: number }[]>`SELECT max_branches FROM tenants WHERE id = ${caller.tenantId}::uuid FOR UPDATE`;
    const current = locked[0]?.max_branches ?? 1;
    if (input.requestedLimit <= current) return { ok: false as const, code: "INVALID_FIELD" as const, params: { field: "requestedLimit" as const } };
    if ((await tx.branchRequest.count({ where: { status: "PENDING" } })) > 0) {
      return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: "PENDING" } };
    }
    const note = input.note?.trim() || null;
    const created = await tx.branchRequest.create({
      data: injected({ id: uuidv7(), requestedLimit: input.requestedLimit, note, requestedBy: caller.actor.userId }),
      select: VIEW,
    });
    return { ok: true as const, value: created };
  });
}

export async function listBranchRequests(caller: RequestCaller): Promise<{ maxBranches: number; requests: BranchRequestView[] }> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: { maxBranches: true } });
    const requests = await tx.branchRequest.findMany({ select: VIEW, orderBy: { createdAt: "desc" } });
    return { maxBranches: tenant.maxBranches, requests };
  });
}

export async function withdrawBranchRequest(caller: RequestCaller, requestId: string): Promise<RequestResult<BranchRequestView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const found = await tx.branchRequest.findFirst({ where: { id: requestId }, select: { status: true } });
    if (found === null) return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "branchRequest" as const } };
    if (found.status !== "PENDING") return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: found.status } };
    const withdrawn = await tx.branchRequest.update({
      where: { id: requestId },
      data: { status: "WITHDRAWN", decidedBy: caller.actor.userId, decidedAt: new Date() },
      select: VIEW,
    });
    return { ok: true as const, value: withdrawn };
  });
}
