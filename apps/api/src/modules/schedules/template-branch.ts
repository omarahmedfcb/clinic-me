// The branch a template replace acts on, and the doctor's templates in every other branch, which the
// new set must not overlap: one doctor is in one place at a time (BRANCHES-DESIGN §4.4).
import { branchContext } from "../../common/branch-context.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import type { ScheduleWriteResult } from "./schedules.service.ts";
import { findOverlap, type TemplateWindow } from "./template-rules.ts";

type Refusal = Extract<ScheduleWriteResult, { ok: false }>;

export async function resolveTemplateBranch(
  tx: TransactionClient,
  requested: string | undefined,
): Promise<{ ok: true; branchId: string } | Refusal> {
  if (requested === undefined) {
    const active = await tx.branch.findMany({ where: { status: "ACTIVE" }, select: { id: true }, take: 2 });
    if (active.length !== 1) return { ok: false, code: "BRANCH_REQUIRED", params: {} };
    requested = active[0]!.id;
  }
  const exists = (await tx.branch.count({ where: { id: requested } })) > 0;
  if (!exists || !branchContext.allows(requested)) return { ok: false, code: "NOT_FOUND", params: { resource: "branch" } };
  return { ok: true, branchId: requested };
}

export async function overlapWithOtherBranches(
  tx: TransactionClient,
  doctorId: string,
  branchId: string,
  incoming: readonly TemplateWindow[],
): Promise<Refusal | null> {
  const rows = await tx.scheduleTemplate.findMany({ where: { doctorId, branchId: { not: branchId } } });
  const wall = (time: Date): string => time.toISOString().slice(11, 16);
  const day = (value: Date): string => value.toISOString().slice(0, 10);
  const elsewhere = rows.map((t) => ({
    weekday: t.weekday,
    startTime: wall(t.startTime),
    endTime: wall(t.endTime),
    validFrom: day(t.validFrom),
    validTo: t.validTo === null ? null : day(t.validTo),
  }));
  for (const mine of incoming) {
    for (const theirs of elsewhere) {
      const overlap = findOverlap([mine, theirs]);
      if (overlap !== null) return { ok: false, code: "OVERLAPPING_TEMPLATE", params: overlap };
    }
  }
  return null;
}
