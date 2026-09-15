import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "./appointments.service.ts";

/**
 * The non-clinical half of the appointment detail panel — `PHASE-4.md`.
 *
 * Everything here is visible to reception, and therefore contains **no clinical content**: no
 * diagnosis, examination, notes, or prescription items. Those live behind their own endpoints in
 * `modules/clinical/`, guarded by `visits.readContent`, which is NONE for every role but DOCTOR.
 *
 * The split is structural rather than a filter, per `CLAUDE.md`. A single endpoint returning
 * everything and removing fields by role is one forgotten branch away from sending a diagnosis to
 * reception, and the response shape would not say so.
 *
 * `complaintSummary` is the one field that looks clinical and is not: reception types it when
 * booking, so it is theirs already. Visit metadata — dates, doctor, service, follow-up — is
 * likewise reception-visible by `CLAUDE.md`'s own list, which is why `visits.readIndex` is FULL for
 * all four human roles while `visits.readContent` is doctor-only.
 */
export interface AppointmentDetail {
  appointmentId: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  source: string;
  complaintSummary: string | null;
  bookingNotes: string | null;
  rescheduleCount: number;

  doctorId: string;
  doctorName: string | null;

  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string | null;
  serviceDurationMinutes: number;

  patientId: string;
  patientNameAr: string;
  patientNameEn: string | null;
  /** Contact details. Reception's job; not clinical. */
  phoneE164: string;
  secondaryPhone: string | null;
  email: string | null;
  address: string | null;

  /**
   * Payment state, in integer minor units — never a float, and never formatted with a currency
   * symbol here. The currency lives in `tenants.currency` and formatting is the interface's job.
   *
   * Null when no payment row exists yet, which is every appointment until Phase 4's payments ship.
   * Distinguished from a zero balance on purpose: "nothing recorded" and "nothing owed" are
   * different answers to "has this been paid".
   */
  payment: {
    status: string;
    /** Phase 5 PR 5: the amounts come from the charge and its balance, not from the receipt row. */
    amountDueMinor: number;
    amountPaidMinor: number;
    remainingMinor: number | null;
  } | null;
}

export async function getAppointmentDetail(
  caller: CallerContext,
  appointmentId: string,
): Promise<AppointmentDetail | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        scheduledStart: true,
        scheduledEnd: true,
        source: true,
        complaintSummary: true,
        bookingNotes: true,
        rescheduleCount: true,
        doctorId: true,
        serviceId: true,
        patientId: true,
        patient: {
          select: {
            fullNameAr: true,
            fullNameEn: true,
            phoneE164: true,
            secondaryPhone: true,
            email: true,
            address: true,
          },
        },
        service: { select: { nameAr: true, nameEn: true, durationMinutes: true } },
        doctor: { select: { title: true, membership: { select: { user: { select: { fullName: true } } } } } },
      },
    });

    // 404, not 403 — a cross-tenant id is indistinguishable from one that never existed.
    if (appointment === null) return null;

    // Phase 5 PR 5 split the invoice from the receipt, so this panel reads two things: the latest
    // receipt for its status, and the charge balance for the amounts. The balance is a view, which
    // is why this is raw SQL -- and why it cannot drift from the rows it sums (D7 as amended).
    const receipt = await tx.payment.findFirst({
      where: { appointmentId: appointment.id },
      select: { status: true },
      orderBy: { createdAt: "desc" },
    });

    const balances = await tx.$queryRaw<
      { patient_share_minor: number; paid_minor: number; balance_minor: number }[]
    >`SELECT b.patient_share_minor, b.paid_minor, b.balance_minor
         FROM visit_charge_balances b
         JOIN visits v ON v.id = b.visit_id
        WHERE v.appointment_id = ${appointment.id}::uuid
        ORDER BY b.charge_id DESC
        LIMIT 1`;
    const balance = balances[0];

    const payment =
      receipt === null && balance === undefined
        ? null
        : {
            status: receipt?.status ?? "PENDING",
            amountDueMinor: balance?.patient_share_minor ?? 0,
            amountPaidMinor: balance?.paid_minor ?? 0,
            remainingMinor: balance?.balance_minor ?? null,
          };

    const doctorName = appointment.doctor
      ? `${appointment.doctor.title} ${appointment.doctor.membership.user.fullName}`.trim()
      : null;

    return {
      appointmentId: appointment.id,
      status: appointment.status,
      scheduledStart: appointment.scheduledStart,
      scheduledEnd: appointment.scheduledEnd,
      source: appointment.source,
      complaintSummary: appointment.complaintSummary,
      bookingNotes: appointment.bookingNotes,
      rescheduleCount: appointment.rescheduleCount,
      doctorId: appointment.doctorId,
      doctorName,
      serviceId: appointment.serviceId,
      serviceNameAr: appointment.service.nameAr,
      serviceNameEn: appointment.service.nameEn,
      serviceDurationMinutes: appointment.service.durationMinutes,
      patientId: appointment.patientId,
      patientNameAr: appointment.patient.fullNameAr,
      patientNameEn: appointment.patient.fullNameEn,
      phoneE164: appointment.patient.phoneE164,
      secondaryPhone: appointment.patient.secondaryPhone,
      email: appointment.patient.email,
      address: appointment.patient.address,
      payment,
    };
  });
}
