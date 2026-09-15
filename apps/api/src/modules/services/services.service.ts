import type { ServiceType } from "../../generated/prisma/client.ts";
import { LIVE_STATUSES } from "../appointments/domain/transition.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

/**
 * Services — what a clinic offers, how long it takes, and what it costs.
 *
 * Two fields here are load-bearing for the slot engine and easy to mistake for cosmetic:
 * `durationMinutes` is the length of a bookable slot, and `bufferMinutes` (Q20) is turnaround
 * added to the *occupied* footprint of an appointment of this service — never to the slot offered
 * for it.
 *
 * `priceMinor` is integer minor units (CLAUDE.md). There is no currency column here on purpose:
 * currency lives on `tenants`, so a clinic cannot end up with two services priced in different
 * ones.
 */

export interface CallerContext {
  tenantId: string;
  actor: ActorContext;
}

export interface ServiceSummary {
  id: string;
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  bufferMinutes: number;
  priceMinor: number;
  isActive: boolean;
  /**
   * Appointments still to happen that are booked on this service — the number the deactivate
   * warning shows (`PHASE-5-DESIGN.md` §2.3). Zero is a real answer and not a missing one.
   */
  futureAppointmentCount: number;
}

export interface CreateServiceInput {
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  bufferMinutes: number;
  priceMinor: number;
}

export type UpdateServiceInput = Partial<CreateServiceInput> & { isActive?: boolean };

/**
 * `now` is a parameter and is never read from the clock in here.
 *
 * "Future appointments" is a claim about an instant, and CLAUDE.md's rule is that anything whose
 * output depends on a reference point takes it explicitly — otherwise the only way to test the
 * boundary is to wait for it. The controller passes `new Date()`; a test passes whatever it needs
 * to put an appointment one minute on either side of the line.
 */
export async function listServices(caller: CallerContext, now: Date): Promise<ServiceSummary[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.service.findMany({ orderBy: { createdAt: "asc" } });
    const counts = await countFutureAppointments(tx, now);
    return rows.map((row) => toSummary(row, counts.get(row.id) ?? 0));
  });
}

export async function getService(
  caller: CallerContext,
  serviceId: string,
  now: Date,
): Promise<ServiceSummary | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const row = await tx.service.findFirst({ where: { id: serviceId } });
    if (row === null) return null;
    const counts = await countFutureAppointments(tx, now, serviceId);
    return toSummary(row, counts.get(row.id) ?? 0);
  });
}

/**
 * One `groupBy` for the whole list rather than a count per row, which would be N+1 queries to
 * render a screen that rarely holds more than a dozen services.
 *
 * `LIVE_STATUSES` comes from the appointment state machine rather than being spelled out here. A
 * cancelled appointment is not an upcoming visit, and counting it would make the warning tell an
 * admin to hesitate over something that is not going to happen.
 */
async function countFutureAppointments(
  tx: TransactionClient,
  now: Date,
  serviceId?: string,
): Promise<Map<string, number>> {
  const grouped = await tx.appointment.groupBy({
    by: ["serviceId"],
    where: {
      scheduledStart: { gt: now },
      // Spread into a mutable array: Prisma's generated `in` will not take a readonly one, and
      // LIVE_STATUSES is readonly precisely so no caller can edit the state machine's answer.
      status: { in: [...LIVE_STATUSES] },
      ...(serviceId === undefined ? {} : { serviceId }),
    },
    _count: { _all: true },
  });
  return new Map(grouped.map((row) => [row.serviceId, row._count._all]));
}

export async function createService(
  caller: CallerContext,
  input: CreateServiceInput,
): Promise<ServiceSummary> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const created = await tx.service.create({ data: injected({ ...input }) });
    // A service that has just been created cannot have an appointment on it, so this is 0 by
    // construction rather than by a query.
    return toSummary(created, 0);
  });
}

/**
 * Deactivation rather than deletion, for the same reason as doctors: appointments reference this
 * row, and the engine filters availability on `isActive` (Q28) so a deactivated service simply
 * stops being bookable while its history stays intact.
 *
 * Changing `durationMinutes` deliberately does **not** touch existing appointments. Their
 * `scheduled_start`/`scheduled_end` were fixed when they were booked, and silently restretching a
 * booked appointment because a setting changed is how a patient's time moves without anyone
 * telling them.
 */
export async function updateService(
  caller: CallerContext,
  serviceId: string,
  input: UpdateServiceInput,
  now: Date,
): Promise<ServiceSummary | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.service.findFirst({ where: { id: serviceId } });
    if (existing === null) return null;
    const updated = await tx.service.update({ where: { id: serviceId }, data: input });
    // Counted after the write, so a screen that has just deactivated a service reads back the
    // number it must keep showing: deactivation leaves those appointments standing (§2.3), and a
    // response implying they went away would be the opposite of the ruling.
    const counts = await countFutureAppointments(tx, now, serviceId);
    return toSummary(updated, counts.get(updated.id) ?? 0);
  });
}

interface ServiceRow {
  id: string;
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  bufferMinutes: number;
  priceMinor: number;
  isActive: boolean;
}

const toSummary = (row: ServiceRow, futureAppointmentCount: number): ServiceSummary => ({
  id: row.id,
  nameAr: row.nameAr,
  nameEn: row.nameEn,
  type: row.type,
  durationMinutes: row.durationMinutes,
  bufferMinutes: row.bufferMinutes,
  priceMinor: row.priceMinor,
  isActive: row.isActive,
  futureAppointmentCount,
});
