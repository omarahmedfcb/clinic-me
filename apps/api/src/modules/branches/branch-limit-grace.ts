// A lowered branch limit (BRANCHES-DESIGN §9 A, step 6.3): 30 days' grace (Q12) in which booking continues everywhere and
// the admin chooses which branches go; then the pass suspends them, never one with a future booking, and never deletes.
import { uuidv7 } from "uuidv7";
import type { RefusalCode, RefusalParams } from "../../common/refusals.ts";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { LIVE_STATUSES } from "../appointments/domain/transition.ts";
import { systemActor } from "../audit/system-actor.ts";

export const GRACE_DAYS = 30;

type Branch = { id: string; name: string; isDefault: boolean; createdAt: Date };

/** After any limit change, inside its transaction: open a grace when the limit falls below the active count, clear it when not. */
export async function reconcileGrace(tx: TransactionClient, limitChangeId: string, maxBranches: number, now: Date): Promise<void> {
  const active = await tx.branch.count({ where: { status: "ACTIVE" } });
  const unresolved = await tx.branchLimitGrace.findFirst({ where: { status: { in: ["OPEN", "DEFERRED"] } }, select: { id: true } });
  if (active > maxBranches && unresolved === null) {
    await tx.branchLimitGrace.create({
      data: injected({ id: uuidv7(), limitChangeId, startedAt: now, endsAt: new Date(now.getTime() + GRACE_DAYS * 86_400_000) }),
    });
  } else if (active <= maxBranches && unresolved !== null) {
    await tx.branchLimitGrace.update({ where: { id: unresolved.id }, data: { status: "CLEARED", resolvedAt: now } });
  }
}

const futureBookings = (tx: TransactionClient, branchId: string, now: Date) =>
  tx.appointment.count({ where: { branchId, scheduledStart: { gt: now }, status: { in: [...LIVE_STATUSES] } } });

export interface LimitStatus {
  maxBranches: number;
  activeBranches: number;
  excess: number;
  grace: { id: string; status: string; endsAt: Date; deferredReason: string | null; chosen: string[] } | null;
  branches: (Branch & { futureBookings: number })[];
}

export async function getLimitStatus(caller: { tenantId: string; actor: ActorContext }, now: Date): Promise<LimitStatus> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const { maxBranches } = await tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: { maxBranches: true } });
    const active = await tx.branch.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, isDefault: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    const grace = await tx.branchLimitGrace.findFirst({
      where: { status: { in: ["OPEN", "DEFERRED"] } },
      select: { id: true, status: true, endsAt: true, deferredReason: true, choices: { select: { branchId: true } } },
    });
    const branches = [];
    for (const branch of active) branches.push({ ...branch, futureBookings: await futureBookings(tx, branch.id, now) });
    return {
      maxBranches,
      activeBranches: active.length,
      excess: Math.max(0, active.length - maxBranches),
      grace: grace === null ? null : { id: grace.id, status: grace.status, endsAt: grace.endsAt, deferredReason: grace.deferredReason, chosen: grace.choices.map((c) => c.branchId) },
      branches,
    };
  });
}

export type ChoiceResult = { ok: true; value: { chosen: string[] } } | { ok: false; code: RefusalCode; params: RefusalParams };

/** The admin's choice: exactly the excess, all active, never the default branch. Replaces any earlier choice. */
export async function chooseBranchesToSuspend(caller: { tenantId: string; actor: ActorContext }, branchIds: string[]): Promise<ChoiceResult> {
  return withTenant<ChoiceResult>(caller.tenantId, caller.actor, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM tenants WHERE id = ${caller.tenantId}::uuid FOR UPDATE`;
    const grace = await tx.branchLimitGrace.findFirst({ where: { status: { in: ["OPEN", "DEFERRED"] } }, select: { id: true } });
    if (grace === null) return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: "WITHIN_LIMIT" } };
    const { maxBranches } = await tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: { maxBranches: true } });
    const active = await tx.branch.findMany({ where: { status: "ACTIVE" }, select: { id: true, isDefault: true } });
    const unique = [...new Set(branchIds)];
    const choosable = new Set(active.filter((b) => !b.isDefault).map((b) => b.id));
    if (unique.length !== active.length - maxBranches || unique.some((id) => !choosable.has(id))) {
      return { ok: false as const, code: "INVALID_FIELD" as const, params: { field: "branchIds" as const } };
    }
    await tx.branchGraceChoice.deleteMany({ where: { graceId: grace.id } });
    for (const branchId of unique) await tx.branchGraceChoice.create({ data: injected({ graceId: grace.id, branchId, chosenBy: caller.actor.userId }) });
    return { ok: true as const, value: { chosen: unique } };
  });
}

export interface PassOutcome { tenantId: string; status: "DONE" | "DEFERRED" | "CLEARED"; suspended: string[]; deferred: string[] }

/** One pass over every grace that has ended (`now` is a parameter, so a test can stand at the deadline). */
export async function enforceBranchLimits(now: Date): Promise<PassOutcome[]> {
  const due = await prisma.$queryRaw<{ grace_id: string; tenant_id: string }[]>`SELECT * FROM due_branch_limit_graces(${now})`;
  const actor = await systemActor();
  const outcomes: PassOutcome[] = [];
  for (const { grace_id: graceId, tenant_id: tenantId } of due) {
    outcomes.push(await withTenant(tenantId, actor, (tx) => enforceOne(tx, tenantId, graceId, now)));
  }
  return outcomes;
}

async function enforceOne(tx: TransactionClient, tenantId: string, graceId: string, now: Date): Promise<PassOutcome> {
  const locked = await tx.$queryRaw<{ max_branches: number }[]>`SELECT max_branches FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  const maxBranches = locked[0]!.max_branches;
  const active: Branch[] = await tx.branch.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, isDefault: true, createdAt: true } });
  const excess = active.length - maxBranches;
  if (excess <= 0) {
    await tx.branchLimitGrace.update({ where: { id: graceId }, data: { status: "CLEARED", resolvedAt: now } });
    return { tenantId, status: "CLEARED", suspended: [], deferred: [] };
  }

  const chosen = new Set((await tx.branchGraceChoice.findMany({ where: { graceId }, select: { branchId: true } })).map((c) => c.branchId));
  const newestFirst = [...active].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const targets = [...newestFirst.filter((b) => chosen.has(b.id)), ...newestFirst.filter((b) => !chosen.has(b.id) && !b.isDefault)].slice(0, excess);

  const suspended: string[] = [];
  const blocked: { branch: Branch; bookings: number }[] = [];
  for (const branch of targets) {
    const bookings = await futureBookings(tx, branch.id, now);
    if (bookings > 0) {
      blocked.push({ branch, bookings });
      continue;
    }
    await tx.branch.update({ where: { id: branch.id }, data: { status: "SUSPENDED", suspendedAt: now, suspensionReason: `branch limit lowered to ${maxBranches}` } });
    suspended.push(branch.id);
  }

  if (blocked.length === 0) {
    await tx.branchLimitGrace.update({ where: { id: graceId }, data: { status: "DONE", resolvedAt: now } });
    return { tenantId, status: "DONE", suspended, deferred: [] };
  }
  const reason = `future bookings in ${blocked.map(({ branch, bookings }) => `${branch.name} (${bookings})`).join(", ")}`;
  await tx.branchLimitGrace.update({ where: { id: graceId }, data: { status: "DEFERRED", deferredAt: now, deferredReason: reason } });
  return { tenantId, status: "DEFERRED", suspended, deferred: blocked.map(({ branch }) => branch.id) };
}
