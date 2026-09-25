// The whole of what the web chat's LLM may do, as functions -- ARCHITECTURE.md §12's tool
// registry. Every tool calls the same service-layer functions the staff-facing controllers call,
// under an AI_AGENT caller context; nothing here talks to Postgres directly. The model never
// invents a clinic, doctor, patient or slot id -- every id it uses came out of a tool result first.
//
// Every schema below sets strict: true -- OpenAI validates a tool call's arguments against the
// JSON Schema before we ever see it, so a malformed or missing field is rejected before it reaches
// this file at all, not caught here after the fact.

import type { Capability } from "../../common/permissions.ts";
import { permissionLevel } from "../../common/permissions.ts";
import { findAvailableSlots, bookAppointment, type CallerContext } from "../appointments/appointments.service.ts";
import { normalisePhone } from "../auth/phone.ts";
import { createProvisionalPatient, findPatientsByPhone } from "../bot/bot.service.ts";
import { listDoctors } from "../doctors/doctors.service.ts";
import { listServices } from "../services/services.service.ts";
import type { GptTool } from "./gpt-client.ts";
import { getBookableClinic, listBookableClinics, resolveBotActor } from "./webchat-clinics.ts";
import type { WebchatSession } from "./webchat-session.ts";

/** Egypt only, for now -- this project has no other market yet, so the phone country and the
 *  fallback clinic timezone are both fixed rather than threaded through as configuration. */
const EGYPT = "EG" as const;
const DEFAULT_TIMEZONE = "Africa/Cairo";

/** Fails loudly in development rather than silently letting an unreviewed capability through. */
function assertBotCapability(capability: Capability): void {
  if (permissionLevel("AI_AGENT", capability) === "none") {
    throw new Error(`AI_AGENT does not hold ${capability} -- add it to permissions.ts before using it here.`);
  }
}

/** Built once a clinic is selected. `null` means the conversation has not chosen one yet. */
function callerFor(session: WebchatSession): CallerContext | null {
  const { tenantId, botMembershipId, botUserId } = session.slots;
  if (!tenantId || !botMembershipId || !botUserId) return null;
  return {
    tenantId,
    role: "AI_AGENT",
    membershipId: botMembershipId,
    actor: { userId: botUserId, ip: "webchat", userAgent: "clinic-os-webchat" },
  };
}

/** The clinic's local wall-clock time for an instant, e.g. `2026-09-25 10:00`. No arithmetic done
 *  by hand -- and none left for the model to get wrong either. */
function formatInClinicTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Today's date, in the clinic's own calendar rather than the server's. Reads it off the resolved
 *  tenant instead of hardcoding Africa/Cairo directly, even though that is the only value this
 *  project currently has. */
function todayInClinic(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Accepts the date formats a patient (or the model, converting free text) is likely to produce:
 * ISO (2026-09-23), and Egypt's everyday day-first convention with either separator
 * (23-09-2026, 23/09/2026). Returns a normalised YYYY-MM-DD string, or null if it cannot be read as
 * a real calendar date -- the model is instructed to convert relative or worded dates itself before
 * calling this tool, so this only needs to cover the handful of literal shapes people actually type.
 */
function parseFlexibleDate(input: string): string | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (isoMatch) {
    const asDate = new Date(`${input}T00:00:00Z`);
    return Number.isNaN(asDate.getTime()) ? null : input;
  }

  const dayFirstMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(input);
  if (dayFirstMatch) {
    const [, day, month, year] = dayFirstMatch;
    const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    const asDate = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(asDate.getTime()) ? null : iso;
  }

  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------------------------

export const WEBCHAT_TOOLS: GptTool[] = [
  {
    type: "function",
    name: "list_clinics",
    description: "List clinics that accept bookings through this chat. Call this first, before anything else.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "select_clinic",
    description:
      "Lock in the clinic the patient picked, using its exact id from list_clinics. Never guess or invent an id.",
    parameters: {
      type: "object",
      properties: { clinicId: { type: "string", description: "The id field from list_clinics." } },
      required: ["clinicId"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "find_or_create_patient",
    description:
      "Look up the patient by full name and phone once a clinic is selected. Creates a new patient record " +
      "automatically if none exists on that phone number. If several patients already share the phone number, " +
      "this returns them all -- ask the patient which one and then call select_patient.",
    parameters: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        phone: { type: "string", description: "As the patient typed it, in any format." },
      },
      required: ["fullName", "phone"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "select_patient",
    description:
      "Confirms which household member the booking is for, by the exact patientId returned by " +
      "find_or_create_patient's found_many list. Never invent a patientId.",
    parameters: {
      type: "object",
      properties: { patientId: { type: "string" } },
      required: ["patientId"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_doctors",
    description: "List the selected clinic's doctors.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "list_services",
    description:
      "List the selected clinic's services. If exactly one is returned, use it directly without asking. " +
      "If more than one, ask the patient which the visit is for.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "list_slots",
    description:
      "List open appointment times for a doctor, service and date. The only source of truth for " +
      "availability -- never state a time that did not come from this tool. Accepts the date as " +
      "YYYY-MM-DD or DD-MM-YYYY (with - or /); convert anything else the patient says -- a relative date, a " +
      "worded date, Arabic -- into one of those forms yourself before calling. Rejects any date before today " +
      "in the clinic's own calendar with DATE_IN_PAST.",
    parameters: {
      type: "object",
      properties: {
        doctorId: { type: "string" },
        serviceId: { type: "string" },
        date: { type: "string" },
      },
      required: ["doctorId", "serviceId", "date"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "book_appointment",
    description:
      "Books the slot the patient confirmed, using its exact token from list_slots. Only call this after the " +
      "patient has explicitly confirmed the doctor, date and time out loud.",
    parameters: {
      type: "object",
      properties: { slotToken: { type: "string" } },
      required: ["slotToken"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------------------------

async function toolListClinics(): Promise<unknown> {
  const clinics = await listBookableClinics();
  if (clinics.length === 0) return { ok: true, clinics: [], note: "No clinic is currently bookable through this chat." };
  return { ok: true, clinics: clinics.map((clinic) => ({ id: clinic.id, name: clinic.name, nameEn: clinic.nameEn })) };
}

async function toolSelectClinic(session: WebchatSession, args: Record<string, unknown>): Promise<unknown> {
  const clinicId = asString(args["clinicId"]);
  if (!clinicId) return { ok: false, reason: "INVALID_INPUT" };

  const clinic = await getBookableClinic(clinicId);
  if (!clinic) return { ok: false, reason: "UNKNOWN_CLINIC" };

  const bot = await resolveBotActor(clinic.id);
  if (!bot) return { ok: false, reason: "NOT_BOOKABLE" };

  session.slots.tenantId = clinic.id;
  session.slots.tenantTimezone = clinic.timezone;
  session.slots.botMembershipId = bot.membershipId;
  session.slots.botUserId = bot.userId;

  return { ok: true, clinicId: clinic.id, name: clinic.name };
}

async function toolFindOrCreatePatient(session: WebchatSession, args: Record<string, unknown>): Promise<unknown> {
  const caller = callerFor(session);
  if (!caller) return { ok: false, reason: "NO_CLINIC_SELECTED" };

  const fullName = asString(args["fullName"]).trim();
  const phone = normalisePhone(asString(args["phone"]), EGYPT);
  if (fullName.length < 2 || !phone) return { ok: false, reason: "INVALID_INPUT" };

  assertBotCapability("bot.findPatientByPhone");
  const matches = await findPatientsByPhone(caller, phone);

  if (matches.length === 1 && matches[0]) {
    session.slots.patientId = matches[0].patientId;
    return { ok: true, status: "found_one", patient: matches[0] };
  }
  if (matches.length > 1) {
    session.slots.householdCandidateIds = matches.map((match) => match.patientId);
    return { ok: true, status: "found_many", patients: matches };
  }

  assertBotCapability("bot.createProvisionalPatient");
  const created = await createProvisionalPatient(caller, { fullNameAr: fullName, phoneE164: phone });
  session.slots.patientId = created.patientId;
  return { ok: true, status: "created", patient: created };
}

function toolSelectPatient(session: WebchatSession, args: Record<string, unknown>): unknown {
  const patientId = asString(args["patientId"]);
  if (!patientId) return { ok: false, reason: "INVALID_INPUT" };
  if (!session.slots.householdCandidateIds?.includes(patientId)) {
    return { ok: false, reason: "NOT_A_CANDIDATE" };
  }
  session.slots.patientId = patientId;
  return { ok: true };
}

async function toolListDoctors(session: WebchatSession): Promise<unknown> {
  const caller = callerFor(session);
  if (!caller) return { ok: false, reason: "NO_CLINIC_SELECTED" };

  assertBotCapability("bot.listDoctors");
  const doctors = await listDoctors(caller, new Date());
  return {
    ok: true,
    doctors: doctors
      .filter((doctor) => doctor.isActive)
      .map((doctor) => ({ id: doctor.id, fullName: doctor.fullName, title: doctor.title, specialty: doctor.specialty })),
  };
}

async function toolListServices(session: WebchatSession): Promise<unknown> {
  const caller = callerFor(session);
  if (!caller) return { ok: false, reason: "NO_CLINIC_SELECTED" };

  assertBotCapability("bot.listServices");
  const services = await listServices(caller, new Date());
  return {
    ok: true,
    services: services
      .filter((service) => service.isActive)
      .map((service) => ({
        id: service.id,
        nameAr: service.nameAr,
        nameEn: service.nameEn,
        durationMinutes: service.durationMinutes,
      })),
  };
}

async function toolListSlots(session: WebchatSession, args: Record<string, unknown>): Promise<unknown> {
  const caller = callerFor(session);
  if (!caller) return { ok: false, reason: "NO_CLINIC_SELECTED" };

  const doctorId = asString(args["doctorId"]);
  const serviceId = asString(args["serviceId"]);
  const date = parseFlexibleDate(asString(args["date"]));
  if (!doctorId || !serviceId || !date) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const timezone = session.slots.tenantTimezone ?? DEFAULT_TIMEZONE;
  if (date < todayInClinic(timezone)) {
    return { ok: false, reason: "DATE_IN_PAST" };
  }

  assertBotCapability("bot.listSlots");
  const now = new Date();
  const result = await findAvailableSlots(caller, { doctorId, serviceId, date, channel: "PATIENT", now });
  if (!result.ok) return { ok: false, reason: result.code, params: result.params };

  // Belt-and-suspenders: never show a time that has already passed today, regardless of what the
  // slot engine's own lead-time rules already exclude -- the one thing worse than a short list is a
  // list with a time the patient can no longer take.
  const futureSlots = result.slots.filter((slot) => slot.start > now);

  return {
    ok: true,
    slots: futureSlots.map((slot) => ({ token: slot.token, localTime: formatInClinicTime(slot.start, timezone) })),
  };
}

async function toolBookAppointment(session: WebchatSession, args: Record<string, unknown>): Promise<unknown> {
  const caller = callerFor(session);
  if (!caller) return { ok: false, reason: "NO_CLINIC_SELECTED" };

  const patientId = session.slots.patientId;
  if (!patientId) return { ok: false, reason: "NO_PATIENT_SELECTED" };

  const slotToken = asString(args["slotToken"]);
  if (!slotToken) return { ok: false, reason: "INVALID_INPUT" };

  assertBotCapability("bot.book");
  const result = await bookAppointment(caller, {
    slotToken,
    patientId,
    source: "ONLINE",
    complaintSummary: null,
    bookingNotes: null,
    now: new Date(),
  });

  if (!result.ok) return { ok: false, reason: result.code };

  const timezone = session.slots.tenantTimezone ?? DEFAULT_TIMEZONE;
  return { ok: true, appointmentId: result.appointmentId, localTime: formatInClinicTime(result.start, timezone) };
}

export async function executeWebchatTool(session: WebchatSession, name: string, rawArguments: string): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "INVALID_ARGUMENTS" };
  }

  switch (name) {
    case "list_clinics":
      return toolListClinics();
    case "select_clinic":
      return toolSelectClinic(session, args);
    case "find_or_create_patient":
      return toolFindOrCreatePatient(session, args);
    case "select_patient":
      return toolSelectPatient(session, args);
    case "list_doctors":
      return toolListDoctors(session);
    case "list_services":
      return toolListServices(session);
    case "list_slots":
      return toolListSlots(session, args);
    case "book_appointment":
      return toolBookAppointment(session, args);
    default:
      return { ok: false, reason: "UNKNOWN_TOOL" };
  }
}
