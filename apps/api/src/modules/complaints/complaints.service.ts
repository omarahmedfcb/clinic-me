// The staff-facing half of complaints ("شكوى"). The bot's half — filing one — is bot.service.ts's
// createComplaint; this is OWNER/ADMIN reading and resolving what the bot filed. Same split as
// audit.service.ts (read) versus the triggers that write audit_logs, for the same reason: the
// people who read this are not the actor who wrote it.

import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

export interface ComplaintsCaller {
  tenantId: string;
  actor: ActorContext;
}

export interface ComplaintEntry {
  id: string;
  referenceNumber: string;
  description: string;
  status: "OPEN" | "RESOLVED";
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByName: string | null;
}

export interface ComplaintsQuery {
  status?: "OPEN" | "RESOLVED";
  limit?: number;
  offset?: number;
}

/** Newest first — an open complaint from this morning belongs above one resolved last week. */
export async function listComplaints(
  ctx: ComplaintsCaller,
  query: ComplaintsQuery = {},
): Promise<{ entries: ComplaintEntry[]; total: number }> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const where = query.status === undefined ? {} : { status: query.status };

    const [rows, total] = await Promise.all([
      tx.complaint.findMany({
        where,
        select: {
          id: true,
          referenceNumber: true,
          description: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
          patient: { select: { id: true, fullNameAr: true, phoneE164: true } },
          resolvedByUser: { select: { fullName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
      tx.complaint.count({ where }),
    ]);

    return {
      total,
      entries: rows.map((row) => ({
        id: row.id,
        referenceNumber: row.referenceNumber,
        description: row.description,
        status: row.status,
        patientId: row.patient.id,
        patientName: row.patient.fullNameAr,
        patientPhone: row.patient.phoneE164,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
        resolvedByName: row.resolvedByUser?.fullName ?? null,
      })),
    };
  });
}

/** Marks a complaint resolved. Idempotent on purpose -- resolving an already-resolved complaint a
 *  second time just refreshes who and when, rather than being refused, because two admins closing
 *  the same complaint a minute apart is not a conflict worth surfacing. */
export async function resolveComplaint(
  ctx: ComplaintsCaller,
  complaintId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" }> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const complaint = await tx.complaint.findFirst({ where: { id: complaintId }, select: { id: true } });
    if (complaint === null) return { ok: false as const, code: "NOT_FOUND" as const };

    await tx.complaint.update({
      where: { id: complaintId },
      data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: ctx.actor.userId },
    });
    return { ok: true as const };
  });
}
