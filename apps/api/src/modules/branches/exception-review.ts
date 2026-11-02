// When a branch is created, every future-dated exception is put to the clinic (BRANCHES-DESIGN §4.4, step 6.6): a service
// the step 8 create route calls, never a trigger. KEEP leaves it as it is; COPY_TO_NEW_BRANCH adds it to the new branch.
import { uuidv7 } from "uuidv7";
import type { RefusalCode, RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import { addExceptionIn, type ScheduleCaller } from "../schedules/schedules.service.ts";

/** Inside the transaction that created `branchId`: one review row per exception dated `today` or later, in any branch. */
export async function openExceptionReview(tx: TransactionClient, branchId: string, today: string): Promise<number> {
  const due = await tx.scheduleException.findMany({ where: { date: { gte: new Date(`${today}T00:00:00Z`) } }, select: { id: true } });
  for (const { id } of due) await tx.branchExceptionReview.create({ data: injected({ id: uuidv7(), branchId, exceptionId: id }) });
  return due.length;
}

export interface ReviewItem {
  id: string;
  decision: string | null;
  exception: { id: string; date: string; type: string; scope: string; branchName: string | null; doctorName: string | null; startTime: string | null; endTime: string | null; reason: string | null };
}

const hhmm = (time: Date | null): string | null => (time === null ? null : time.toISOString().slice(11, 16));

export async function listExceptionReview(caller: ScheduleCaller, branchId: string): Promise<ReviewItem[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.branchExceptionReview.findMany({
      where: { branchId },
      orderBy: { exception: { date: "asc" } },
      select: {
        id: true,
        decision: true,
        exception: {
          select: { id: true, date: true, type: true, scope: true, startTime: true, endTime: true, reason: true, branch: { select: { name: true } },
            doctor: { select: { printedName: true, membership: { select: { user: { select: { fullName: true } } } } } } },
        },
      },
    });
    return rows.map(({ id, decision, exception: e }) => ({
      id,
      decision,
      exception: {
        id: e.id, date: e.date.toISOString().slice(0, 10), type: e.type, scope: e.scope, branchName: e.branch?.name ?? null,
        doctorName: e.doctor === null ? null : e.doctor.printedName ?? e.doctor.membership.user.fullName,
        startTime: hhmm(e.startTime), endTime: hhmm(e.endTime), reason: e.reason,
      },
    }));
  });
}

export type DecideResult = { ok: true; value: { decision: string } } | { ok: false; code: RefusalCode; params: RefusalParams };

/** One decision per item, final. A copy is written through the schedules service's own rules, in the same transaction. */
export async function decideExceptionReview(
  caller: ScheduleCaller,
  branchId: string,
  reviewId: string,
  decision: "KEEP" | "COPY_TO_NEW_BRANCH",
): Promise<DecideResult> {
  return withTenant<DecideResult>(caller.tenantId, caller.actor, async (tx) => {
    const locked = await tx.$queryRaw<{ decision: string | null }[]>`
      SELECT decision::text AS decision FROM branch_exception_reviews WHERE id = ${reviewId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`;
    if (locked[0] === undefined) return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "exception" as const } };
    if (locked[0].decision !== null) return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: locked[0].decision } };
    const review = await tx.branchExceptionReview.findUniqueOrThrow({ where: { id: reviewId }, select: { exception: true } });

    if (decision === "COPY_TO_NEW_BRANCH") {
      const e = review.exception;
      if (e.scope === "EVERY_BRANCH") return { ok: false as const, code: "INVALID_FIELD" as const, params: { field: "decision" as const } };
      const copied = await addExceptionIn(tx, caller, {
        doctorId: e.doctorId, date: e.date.toISOString().slice(0, 10), type: e.type, startTime: hhmm(e.startTime), endTime: hhmm(e.endTime),
        reason: e.reason, branchId, scope: "ONE_BRANCH",
      });
      if (!copied.ok) return { ok: false as const, code: copied.code, params: copied.params };
    }
    await tx.branchExceptionReview.update({ where: { id: reviewId }, data: { decision, decidedBy: caller.actor.userId, decidedAt: new Date() } });
    return { ok: true as const, value: { decision } };
  });
}
