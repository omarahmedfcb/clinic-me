import type { TransactionClient } from "../../prisma/with-tenant.ts";

/**
 * When that doctor last finished with someone. The database half of Q9's readiness instant.
 *
 * Its pure counterpart is `graceReferenceInstant()` in `domain/no-show.ts`, which combines this
 * with the appointment's own start. The split is the usual one: the query lives here, the rule
 * lives in `domain/` with no I/O.
 *
 * Shared by both halves of the module — `markNoShow()` needs it for one appointment, and
 * `pendingNoShows()` needs it per doctor across a whole day — which is why it sits in its own file
 * rather than in either.
 */
export async function doctorFreeAt(
  tx: TransactionClient,
  doctorId: string,
  now: Date,
): Promise<Date | null> {
  const last = await tx.appointment.findFirst({
    where: {
      doctorId,
      status: "COMPLETED",
      consultationEndedAt: { not: null, lte: now },
    },
    orderBy: { consultationEndedAt: "desc" },
    select: { consultationEndedAt: true },
  });
  return last?.consultationEndedAt ?? null;
}
