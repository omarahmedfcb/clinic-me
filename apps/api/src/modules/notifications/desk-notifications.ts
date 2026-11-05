import type { NotificationKind } from "../../generated/prisma/client.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { recordNotification } from "./notifications.service.ts";

/**
 * The four notifications between the desk and the doctor. Each is written inside the transaction of
 * the change it describes (see `recordNotification`), and each has ONE audience, enforced by
 * `visibleTo` in notifications.service.ts:
 *
 *   CONSULTATION_STARTED, CONSULTATION_ENDED  -> reception
 *   PATIENT_CHECKED_IN, PATIENT_PAID          -> the appointment's doctor
 *
 * The payload carries only the patient's display name and the appointment time -- never anything
 * clinical, and never an amount.
 */

const KIND_OF_QUEUE_EVENT: Readonly<Record<string, NotificationKind | undefined>> = {
  ARRIVE: "PATIENT_CHECKED_IN",
  START_CONSULTATION: "CONSULTATION_STARTED",
  COMPLETE: "CONSULTATION_ENDED",
};

async function patientNameOf(tx: TransactionClient, patientId: string): Promise<string> {
  const patient = await tx.patient.findFirst({ where: { id: patientId }, select: { fullNameAr: true } });
  return patient?.fullNameAr ?? "";
}

/**
 * Called for every queue event; does nothing for the ones that are not one of the three below.
 * ARRIVE is reception's check-in, START_CONSULTATION and COMPLETE are the doctor's.
 */
export async function notifyQueueEvent(
  tx: TransactionClient,
  actorUserId: string,
  appointmentId: string,
  event: string,
  now: Date,
): Promise<void> {
  const kind = KIND_OF_QUEUE_EVENT[event];
  if (kind === undefined) return;

  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId },
    select: { patientId: true, doctorId: true, scheduledStart: true },
  });
  if (appointment === null) return;

  await recordNotification(tx, actorUserId, {
    kind,
    appointmentId,
    patientId: appointment.patientId,
    source: kind === "PATIENT_CHECKED_IN" ? "RECEPTION" : "DOCTOR",
    occurredAt: now,
    payload: {
      patientName: await patientNameOf(tx, appointment.patientId),
      start: appointment.scheduledStart.toISOString(),
      toDoctorId: appointment.doctorId,
    },
  });
}

/**
 * A payment was recorded: tell the doctor the patient belongs to. The doctor is found from the
 * appointment, or from the visit when the money was taken against a charge with no appointment id.
 * A doctor who collected the payment themselves is not told about their own action.
 */
export async function notifyPatientPaid(
  tx: TransactionClient,
  caller: { actor: { userId: string }; role: string },
  input: {
    appointmentId: string | null;
    visitId: string | null;
    patientId: string;
    collectorDoctorId: string | null;
    now: Date;
  },
): Promise<void> {
  let doctorId: string | null = null;
  let start: string | undefined;

  if (input.appointmentId !== null) {
    const appointment = await tx.appointment.findFirst({
      where: { id: input.appointmentId },
      select: { doctorId: true, scheduledStart: true },
    });
    doctorId = appointment?.doctorId ?? null;
    start = appointment?.scheduledStart.toISOString();
  }
  if (doctorId === null && input.visitId !== null) {
    const visit = await tx.visit.findFirst({ where: { id: input.visitId }, select: { doctorId: true } });
    doctorId = visit?.doctorId ?? null;
  }
  if (doctorId === null || doctorId === input.collectorDoctorId) return;

  await recordNotification(tx, caller.actor.userId, {
    kind: "PATIENT_PAID",
    appointmentId: input.appointmentId,
    patientId: input.patientId,
    source: caller.role === "DOCTOR" ? "DOCTOR" : "RECEPTION",
    occurredAt: input.now,
    payload: {
      patientName: await patientNameOf(tx, input.patientId),
      ...(start === undefined ? {} : { start }),
      toDoctorId: doctorId,
    },
  });
}
