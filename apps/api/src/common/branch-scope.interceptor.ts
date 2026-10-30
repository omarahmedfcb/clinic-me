// Resolves the branches a membership may act in and the one `X-Branch-Id` selects, per request
// (BRANCHES-DESIGN §4.1). A branch outside the allowed set is 404, as a cross-tenant id is.
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException } from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { actorContext } from "./actor-context.ts";
import { branchContext, NO_MEMBERSHIP, type BranchContext, type BranchSummary } from "./branch-context.ts";
import { scheduledTemplateBranches, selectBranch, type BranchFacts } from "./branch-scope.ts";
import { todayInClinic } from "./clinic-time.ts";
import { refusal } from "./refusals.ts";
import { withTenant, type ActorContext } from "../prisma/with-tenant.ts";

export const BRANCH_HEADER = "x-branch-id";

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

async function loadFacts(
  tenantId: string,
  membershipId: string,
  actor: ActorContext,
): Promise<{ facts: BranchFacts; branches: BranchSummary[] }> {
  return withTenant(tenantId, actor, async (tx) => {
    const branches = await tx.branch.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, nameEn: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    const base = {
      activeBranchIds: branches.map((b) => b.id),
      defaultBranchId: branches.find((b) => b.isDefault)?.id ?? "",
      memberBranchIds: [],
      scheduledBranchIds: [],
    };
    if (branches.length <= 1) return { facts: { scope: "ALL", ...base }, branches };

    const membership = await tx.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: {
        branchScope: true,
        branches: { select: { branchId: true } },
        doctor: { select: { scheduleTemplates: { select: { branchId: true, validFrom: true, validTo: true } } } },
      },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    const templates = (membership.doctor?.scheduleTemplates ?? []).map((t) => ({
      branchId: t.branchId,
      validFrom: isoDate(t.validFrom),
      validTo: t.validTo === null ? null : isoDate(t.validTo),
    }));
    const facts: BranchFacts = {
      ...base,
      scope: membership.branchScope,
      memberBranchIds: membership.branches.map((b) => b.branchId),
      scheduledBranchIds: scheduledTemplateBranches(templates, todayInClinic(tenant.timezone)),
    };
    return { facts, branches };
  });
}

/** A membership's branch context; `null` when `header` names a branch outside its scope. */
export async function resolveBranchContext(
  tenantId: string,
  membershipId: string,
  actor: ActorContext,
  header: string | undefined,
): Promise<BranchContext | null> {
  const { facts, branches } = await loadFacts(tenantId, membershipId, actor);
  const selection = selectBranch(facts, header);
  if (selection === null) return null;
  return { ...selection, branches: branches.filter((b) => selection.allowed.includes(b.id)) };
}

@Injectable()
export class BranchScopeInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = request.authClaims as AuthenticatedRequest["authClaims"] | undefined;

    // No membership behind the request: an empty scope, so branch checks refuse rather than pass.
    let bound: BranchContext = NO_MEMBERSHIP;
    if (claims !== undefined) {
      const header = request.headers[BRANCH_HEADER];
      const resolved = await resolveBranchContext(
        claims.tenantId,
        claims.membershipId,
        actorContext.getOrThrow(),
        typeof header === "string" ? header : undefined,
      );
      if (resolved === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "branch" }));
      bound = resolved;
    }

    return new Observable((subscriber) => {
      branchContext.run(bound, () => {
        subscriber.add(next.handle().subscribe(subscriber));
      });
    });
  }
}
