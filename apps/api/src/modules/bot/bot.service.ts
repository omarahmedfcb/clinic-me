// What the bot may do, as functions. Every one runs under the clinic's RLS through withTenant, and
// every one returns the narrow shape docs/WHATSAPP-BOT-CONTRACT.md §3 allows — never a wider row.

import { uuidv7 } from "uuidv7";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../patients/patients.service.ts";
import { isIntakeIncomplete } from "../patients/domain/intake-completeness.ts";
import { latinSearchKey } from "../patients/domain/transliterate.ts";

/** One household member, and the whole of what the bot learns about them. */
export interface BotHouseholdMember {
  patientId: string;
  displayName: string;
  relationshipToContact: string;
  /** So the bot can say "we still need a few details" rather than the desk discovering it later. */
  intakeIncomplete: boolean;
}

/**
 * Every patient on one number — ruled 2026-09-18, because one phone per household is the norm here.
 *
 * Matched on `phoneE164` exactly. Archived and merged rows are excluded: a merged patient is a
 * duplicate that has already been folded into another record, and offering it would let the bot book
 * against a file the desk has retired.
 */
export async function findPatientsByPhone(
  ctx: CallerContext,
  phone: string,
): Promise<BotHouseholdMember[]> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const patients = await tx.patient.findMany({
      where: { phoneE164: phone, status: "ACTIVE" },
      select: {
        id: true,
        fullNameAr: true,
        relationshipToContact: true,
        // Read only to derive the badge below; never returned.
        dateOfBirth: true,
        gender: true,
        nationality: true,
        phoneE164: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return patients.map((patient) => ({
      patientId: patient.id,
      displayName: patient.fullNameAr,
      relationshipToContact: patient.relationshipToContact,
      intakeIncomplete: isIntakeIncomplete({
        fullNameAr: patient.fullNameAr,
        phoneE164: patient.phoneE164,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        nationality: patient.nationality,
      }),
    }));
  });
}

/**
 * A patient from a name and a phone, marked as the bot's.
 *
 * `createdVia` is set here rather than taken from the caller: provenance a caller can choose is not
 * provenance. The record is deliberately incomplete — `intake-completeness.ts` derives that from the
 * missing date of birth, gender and nationality, so it carries «ملف ناقص» at the desk from the
 * moment it exists, through the flow reception already has.
 */
export async function createProvisionalPatient(
  ctx: CallerContext,
  input: { fullNameAr: string; phoneE164: string },
): Promise<{ patientId: string; displayName: string }> {
  const id = uuidv7();

  await withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const existing = await tx.contact.findFirst({ where: { phoneE164: input.phoneE164 }, select: { id: true } });
    const contactId =
      existing?.id ??
      (await tx.contact.create({ data: injected({ id: uuidv7(), phoneE164: input.phoneE164 }), select: { id: true } })).id;

    /**
     * `SELF` on a number nobody uses yet, `OTHER` when the household already has members.
     *
     * The bot is told a name, not a relationship, and guessing "CHILD" from a chat would be an
     * invention in a clinical record. `OTHER` is the honest value, and reception corrects it while
     * completing the intake it is already being asked to complete.
     */
    const householdSize = await tx.patient.count({ where: { contactId } });

    await tx.patient.create({
      data: injected({
        id,
        contactId,
        fullNameAr: input.fullNameAr,
        fullNameEn: null,
        nameSearchLatin: latinSearchKey(input.fullNameAr, null),
        phoneE164: input.phoneE164,
        relationshipToContact: householdSize === 0 ? "SELF" : "OTHER",
        status: "ACTIVE",
        createdVia: "WHATSAPP_BOT",
      }),
    });
  });

  return { patientId: id, displayName: input.fullNameAr };
}

/**
 * The consent a booking in chat carries, recorded once.
 *
 * Only when the patient has none: consent is evidence, and a row per booking would turn the
 * evidence trail into a booking log. A withdrawal is respected — the patient said no since, and a
 * new booking does not overturn that on their behalf.
 */
export async function ensureWhatsAppConsent(
  ctx: CallerContext,
  patientId: string,
  externalMessageId: string,
  now: Date,
): Promise<void> {
  const needed = await withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const latest = await tx.consent.findFirst({
      where: { patientId, purpose: "WHATSAPP_COMMS" },
      orderBy: { grantedAt: "desc" },
      select: { granted: true, withdrawnAt: true },
    });
    return latest === null;
  });
  if (!needed) return;

  await recordBotConsent(ctx, patientId, { purpose: "WHATSAPP_COMMS", granted: true, externalMessageId }, now);
}

/** Consent the patient gave in chat, with the message as its evidence. */
export async function recordBotConsent(
  ctx: CallerContext,
  patientId: string,
  input: { purpose: "WHATSAPP_COMMS"; granted: boolean; externalMessageId?: string },
  now: Date,
): Promise<{ recorded: true } | { recorded: false; code: "NOT_FOUND" }> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const patient = await tx.patient.findFirst({ where: { id: patientId }, select: { id: true } });
    // 404 rather than a refusal that confirms the id belongs to another clinic.
    if (patient === null) return { recorded: false as const, code: "NOT_FOUND" as const };

    await tx.consent.create({
      data: injected({
        id: uuidv7(),
        patientId,
        purpose: input.purpose,
        granted: input.granted,
        grantedAt: now,
        withdrawnAt: input.granted ? null : now,
        capturedByUserId: ctx.actor.userId,
        evidence: {
          channel: "whatsapp",
          ...(input.externalMessageId === undefined ? {} : { externalMessageId: input.externalMessageId }),
          recordedAt: now.toISOString(),
        },
      }),
    });

    return { recorded: true as const };
  });
}

/** Status of one appointment, and nothing about the visit inside it. */
export async function readAppointmentStatus(
  ctx: CallerContext,
  appointmentId: string,
): Promise<{ appointmentId: string; status: string; scheduledStart: Date; doctorName: string } | null> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        scheduledStart: true,
        doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
      },
    });
    if (appointment === null) return null;

    return {
      appointmentId: appointment.id,
      status: appointment.status,
      scheduledStart: appointment.scheduledStart,
      doctorName: appointment.doctor?.membership?.user?.fullName ?? "",
    };
  });
}
