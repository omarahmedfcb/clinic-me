// The WhatsApp AI's tools -- ARCHITECTURE.md §12's registry, same shape as webchat-tools.ts, but
// every executor calls bot-api-client.ts (a real HTTP request to /bot/*) instead of a service
// function directly. See bot-api-client.ts's header comment for why that difference is the point.
//
// No list_clinics/select_clinic here, unlike webchat-tools.ts: the clinic is never ambiguous on
// WhatsApp -- the number the patient messaged already resolved one (whatsapp-tenants.ts), before
// the model sees a single word.
//
// No select_patient either. webchat-tools.ts added it because its session keeps `patientId` in an
// in-memory slot the model never sees again; there is no equivalent durable slot here (see
// whatsapp-conversation.ts's header and schema.prisma's note on `Conversation.lastAiResponseId` for
// why: the *only* thing this module persists between turns is the OpenAI response id, everything
// else is expected to live in the model's own chained context). book_appointment therefore takes
// `patientId` directly, from whichever id find_or_create_patient most recently returned in this same
// conversation -- exactly the shape `BotBookDto` already requires from any bot. A hallucinated id is
// not a real risk this loosens: `/bot/appointments` re-validates the patient belongs to this tenant
// before booking, the same as it would for any other caller.

import { formatInClinicTime, parseFlexibleDate, todayInClinic } from "../../common/clinic-time.ts";
import { normalisePhone } from "../auth/phone.ts";
import type { BotApiClient } from "./bot-api-client.ts";
import type { GptTool } from "../webchat/gpt-client.ts";

const EGYPT = "EG" as const;

/** What a tool executor needs, resolved once per inbound message rather than carried in a session:
 *  there is no per-turn state left to carry (see the header above). */
export interface WhatsAppToolContext {
  client: BotApiClient;
  timezone: string;
  /** The inbound message that is driving this turn -- the evidence a booking's WhatsApp consent is
   *  recorded against (`BotBookDto.consentMessageId`). Never taken from the model: consent evidence
   *  has to be the message that actually carried it, not text the model could get wrong. */
  inboundExternalMessageId: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------------------------

/** Handled by the orchestrator itself (whatsapp-orchestrator.ts), never by `executeWhatsAppTool`. */
export const START_NEW_BOOKING_TOOL = "start_new_booking";

export const WHATSAPP_TOOLS: GptTool[] = [
  {
    type: "function",
    name: "find_or_create_patient",
    description:
      "Look up the patient by full name and phone once you have both. Creates a new patient record " +
      "automatically if none exists on that phone number. If several patients already share the phone " +
      "number, this returns them all -- read out their names, ask which one the booking is for, and use " +
      "that patient's exact id (never invent one) the next time you call a tool that takes a patientId.",
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
    name: "list_doctors",
    description: "List this clinic's doctors.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "list_services",
    description:
      "List this clinic's services. If exactly one is returned, use it directly without asking. If more " +
      "than one, ask the patient which the visit is for.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "list_slots",
    description:
      "List open appointment times for a doctor, service and date. The only source of truth for " +
      "availability -- never state a time that did not come from this tool. Accepts the date as " +
      "YYYY-MM-DD or DD-MM-YYYY (with - or /); convert anything else the patient says -- a relative date, " +
      "a worded date, Arabic -- into one of those forms yourself before calling. Rejects any date before " +
      "today in the clinic's own calendar with DATE_IN_PAST.",
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
      "Books the slot the patient confirmed, for the patient identified by patientId. Only call this " +
      "after the patient has explicitly confirmed the doctor, date and time out loud, and only with a " +
      "patientId that came from find_or_create_patient earlier in this conversation. Pass the same " +
      "doctorId, serviceId and date you used for list_slots, and the slotId of the chosen time, copied " +
      "exactly as list_slots returned it.",
    parameters: {
      type: "object",
      properties: {
        patientId: { type: "string" },
        doctorId: { type: "string" },
        serviceId: { type: "string" },
        date: { type: "string" },
        slotId: { type: "string" },
      },
      required: ["patientId", "doctorId", "serviceId", "date", "slotId"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: START_NEW_BOOKING_TOOL,
    description:
      "Call this when the patient says they want to start over, drop what they were doing, or book a " +
      "new or another appointment -- even in the middle of a booking, or right after one. It discards " +
      "everything gathered so far in this chat.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

/** The same tools without the reset, offered on the fresh chain so it cannot reset itself in a loop. */
export const WHATSAPP_TOOLS_AFTER_RESET = WHATSAPP_TOOLS.filter((tool) => tool.name !== START_NEW_BOOKING_TOOL);

// ---------------------------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------------------------

async function toolFindOrCreatePatient(ctx: WhatsAppToolContext, args: Record<string, unknown>): Promise<unknown> {
  const fullName = asString(args["fullName"]).trim();
  const phone = normalisePhone(asString(args["phone"]), EGYPT);
  if (fullName.length < 2 || !phone) return { ok: false, reason: "INVALID_INPUT" };

  const found = await ctx.client.findPatientsByPhone(phone);
  if (!found.ok) return { ok: false, reason: found.code };

  if (found.value.patients.length === 1 && found.value.patients[0]) {
    return { ok: true, status: "found_one", patient: found.value.patients[0] };
  }
  if (found.value.patients.length > 1) {
    return { ok: true, status: "found_many", patients: found.value.patients };
  }

  const created = await ctx.client.createProvisionalPatient({ fullNameAr: fullName, phoneE164: phone });
  if (!created.ok) return { ok: false, reason: created.code };
  return { ok: true, status: "created", patient: created.value };
}

async function toolListDoctors(ctx: WhatsAppToolContext): Promise<unknown> {
  const result = await ctx.client.listDoctors();
  if (!result.ok) return { ok: false, reason: result.code };
  return { ok: true, doctors: result.value.doctors };
}

async function toolListServices(ctx: WhatsAppToolContext): Promise<unknown> {
  const result = await ctx.client.listServices();
  if (!result.ok) return { ok: false, reason: result.code };
  return { ok: true, services: result.value.services };
}

async function toolListSlots(ctx: WhatsAppToolContext, args: Record<string, unknown>): Promise<unknown> {
  const doctorId = asString(args["doctorId"]);
  const serviceId = asString(args["serviceId"]);
  const date = parseFlexibleDate(asString(args["date"]));
  if (!doctorId || !serviceId || !date) return { ok: false, reason: "INVALID_INPUT" };
  if (date < todayInClinic(ctx.timezone)) return { ok: false, reason: "DATE_IN_PAST" };

  const result = await ctx.client.listSlots({ doctorId, serviceId, date });
  if (!result.ok) return { ok: false, reason: result.code, params: result.params };

  const now = new Date();
  return {
    ok: true,
    // `/bot/slots` returns each slot as `{ token, start }` with `start` a raw instant
    // (bot-api-client.ts's note on why) -- formatted into the clinic's local wall-clock time here,
    // the same shape webchat-tools.ts hands the model. Also re-checked against "now": a slot that
    // has passed since the list was computed is worse to show than one the engine's own lead-time
    // rules already excluded.
    slots: result.value.slots
      .map((slot) => ({ start: new Date(slot.start) }))
      .filter((slot) => slot.start > now)
      .map((slot) => ({ slotId: slot.start.toISOString(), localTime: formatInClinicTime(slot.start, ctx.timezone) })),
  };
}

async function toolBookAppointment(ctx: WhatsAppToolContext, args: Record<string, unknown>): Promise<unknown> {
  const patientId = asString(args["patientId"]);
  const doctorId = asString(args["doctorId"]);
  const serviceId = asString(args["serviceId"]);
  const date = parseFlexibleDate(asString(args["date"]));
  const slotStartMs = Date.parse(asString(args["slotId"]));
  if (!patientId || !doctorId || !serviceId || !date || Number.isNaN(slotStartMs)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }

  // Re-ask the API for the offer and take the token from *its* answer, never from the model.
  const offered = await ctx.client.listSlots({ doctorId, serviceId, date });
  if (!offered.ok) return { ok: false, reason: offered.code, params: offered.params };

  const match = offered.value.slots.find((slot) => new Date(slot.start).getTime() === slotStartMs);
  if (match === undefined) return { ok: false, reason: "SLOT_TAKEN", params: {} };

  const result = await ctx.client.bookAppointment({
    patientId,
    slotToken: match.token,
    consentMessageId: ctx.inboundExternalMessageId,
  });
  if (!result.ok) return { ok: false, reason: result.code, params: result.params };

  return {
    ok: true,
    appointmentId: result.value.appointmentId,
    localTime: formatInClinicTime(new Date(result.value.start), ctx.timezone),
  };
}

export async function executeWhatsAppTool(
  ctx: WhatsAppToolContext,
  name: string,
  rawArguments: string,
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "INVALID_ARGUMENTS" };
  }

  switch (name) {
    case "find_or_create_patient":
      return toolFindOrCreatePatient(ctx, args);
    case "list_doctors":
      return toolListDoctors(ctx);
    case "list_services":
      return toolListServices(ctx);
    case "list_slots":
      return toolListSlots(ctx, args);
    case "book_appointment":
      return toolBookAppointment(ctx, args);
    default:
      return { ok: false, reason: "UNKNOWN_TOOL" };
  }
}
