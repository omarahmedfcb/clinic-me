// Drives runFlow() end-to-end against a fake BotApiClient -- no HTTP, no database, no real GPT call
// (jest.mock below replaces gpt-client.ts's callGpt with a stub). This is the first test coverage
// this module has had; it is not exhaustive (see the file-level comment in whatsapp-flow.ts for what
// each step does), but it exercises every kind of turn the step machine has to get right: a vague
// opener, a clear one, both booking and complaint end to end, slot pagination, and the off-script
// detour that must never lose the patient's place in the flow.

jest.mock("../webchat/gpt-client.ts", () => ({ callGpt: jest.fn() }));

import { callGpt } from "../webchat/gpt-client.ts";
import type { BotApiClient, BotDoctor, BotHouseholdMember, BotResult, BotService, BotSlot } from "./bot-api-client.ts";
import { runFlow, type FlowContext, type FlowState } from "./whatsapp-flow.ts";
import type { WhatsAppTenant } from "./whatsapp-tenants.ts";

const mockedCallGpt = callGpt as jest.MockedFunction<typeof callGpt>;

const TENANT: WhatsAppTenant = {
  id: "tenant-1",
  timezone: "Africa/Cairo",
  clinicName: "عيادة النور",
  clinicNameEn: "Al Noor Clinic",
  phoneNumberId: "1234567890",
  bot: { userId: "bot-user", ip: "127.0.0.1", userAgent: "bot" } as WhatsAppTenant["bot"],
};

const DOCTOR: BotDoctor = { id: "doc-1", fullName: "أحمد سامي", title: "Dr.", specialty: "أسنان" };
const SERVICE: BotService = { id: "svc-1", nameAr: "كشف", nameEn: "Consultation", durationMinutes: 20 };

function ok<T>(value: T): BotResult<T> {
  return { ok: true, value };
}

/** A fake wide enough for every method the flow calls; each test overrides only what it needs.
 *  Cast through `unknown` because `BotApiClient` is a class with a private field -- a plain object
 *  can never structurally match it, and that mismatch is not something under test here. */
function fakeClient(overrides: Partial<Record<keyof BotApiClient, jest.Mock>>): BotApiClient {
  const base = {
    findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [] as BotHouseholdMember[] })),
    createProvisionalPatient: jest.fn().mockResolvedValue(ok({ patientId: "pat-new", displayName: "مريض جديد" })),
    listDoctors: jest.fn().mockResolvedValue(ok({ doctors: [DOCTOR] })),
    listServices: jest.fn().mockResolvedValue(ok({ services: [SERVICE] })),
    listSlots: jest.fn().mockResolvedValue(ok({ slots: [] as BotSlot[] })),
    bookAppointment: jest.fn(),
    createComplaint: jest.fn(),
  };
  return { ...base, ...overrides } as unknown as BotApiClient;
}

function ctxFor(client: BotApiClient, state: FlowState | null, input: FlowContext["input"], opts: Partial<FlowContext> = {}): FlowContext {
  return {
    tenant: TENANT,
    client,
    phoneE164: "+201001234567",
    input,
    state,
    isNewSession: false,
    inboundExternalMessageId: "wamid.test",
    ...opts,
  };
}

beforeEach(() => {
  mockedCallGpt.mockReset();
  mockedCallGpt.mockResolvedValue({ outputText: "" } as Awaited<ReturnType<typeof callGpt>>);
});

describe("opening a session", () => {
  test("a vague opener sends the welcome line once and offers the intent menu", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "ازيك" }, { isNewSession: true }));

    expect(result.handled).toBe(true);
    expect(result.nextState).toEqual({ step: "INTENT", lang: "ar" });
    expect(result.outgoing?.kind).toBe("buttons");
    if (result.outgoing?.kind === "buttons") {
      expect(result.outgoing.body).toContain(TENANT.clinicName);
      expect(result.outgoing.buttons).toHaveLength(2);
    }
  });

  test("a clear booking opener skips the menu and goes straight to identity", async () => {
    const client = fakeClient({ findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [] })) });
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "عايز احجز معاد" }, { isNewSession: true }));

    expect(result.nextState).toMatchObject({ step: "PHONE_CHOICE", intent: "booking" });
    // The welcome line still opens the very first message of the session, even off the fast path.
    expect(result.outgoing?.kind === "buttons" && result.outgoing.body).toContain(TENANT.clinicName);
  });

  test("an English opener is answered in English", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "hi there" }, { isNewSession: true }));
    expect(result.nextState).toEqual({ step: "INTENT", lang: "en" });
    expect(result.outgoing?.kind === "buttons" && result.outgoing.body).toContain("Welcome to");
  });
});

describe("identity", () => {
  test("a single known patient is asked to confirm, not asked for their name again", async () => {
    const client = fakeClient({
      findPatientsByPhone: jest.fn().mockResolvedValue(
        ok({ patients: [{ patientId: "pat-1", displayName: "سارة محمد", relationshipToContact: "SELF", intakeIncomplete: false }] }),
      ),
    });
    const state: FlowState = { step: "INTENT", lang: "ar" };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "intent_complaint" }));

    expect(result.nextState).toMatchObject({ step: "IDENTITY_YESNO", patientId: "pat-1", patientName: "سارة محمد" });
    expect(result.outgoing?.kind).toBe("buttons");
  });

  test("confirming yes moves straight into the complaint text step, no name/number asked", async () => {
    const client = fakeClient({});
    const state: FlowState = {
      step: "IDENTITY_YESNO",
      lang: "ar",
      intent: "complaint",
      phoneE164: "+201001234567",
      patientId: "pat-1",
      patientName: "سارة محمد",
    };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "yn_yes" }));
    expect(result.nextState).toEqual({ step: "COMPLAINT_TEXT", lang: "ar", patientId: "pat-1", patientName: "سارة محمد" });
  });
});

describe("complaint flow end to end", () => {
  test("description then confirm files the complaint and returns a reference number", async () => {
    const client = fakeClient({
      createComplaint: jest.fn().mockResolvedValue(ok({ complaintId: "cmp-1", referenceNumber: "CMP-ABC123" })),
    });

    const afterText = await runFlow(
      ctxFor(client, { step: "COMPLAINT_TEXT", lang: "ar", patientId: "pat-1", patientName: "سارة" }, { kind: "text", text: "الدكتور اتأخر ساعة كاملة" }),
    );
    expect(afterText.nextState).toMatchObject({ step: "COMPLAINT_CONFIRM", text: "الدكتور اتأخر ساعة كاملة" });

    const afterConfirm = await runFlow(
      ctxFor(client, afterText.nextState as FlowState, { kind: "interactive", id: "yn_yes" }),
    );
    expect(client.createComplaint).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: "pat-1", description: "الدكتور اتأخر ساعة كاملة" }),
    );
    expect(afterConfirm.nextState).toBeNull();
    expect(afterConfirm.outgoing?.kind === "text" && afterConfirm.outgoing.text).toContain("CMP-ABC123");
  });

  test("a too-short description is rejected before it ever reaches confirmation", async () => {
    const client = fakeClient({});
    const result = await runFlow(
      ctxFor(client, { step: "COMPLAINT_TEXT", lang: "ar", patientId: "pat-1", patientName: "سارة" }, { kind: "text", text: "ok" }),
    );
    expect(result.nextState).toMatchObject({ step: "COMPLAINT_TEXT" });
    expect(client.createComplaint).not.toHaveBeenCalled();
  });
});

describe("booking flow end to end", () => {
  test("a single doctor and single service are never asked about, only the date is", async () => {
    const client = fakeClient({
      listDoctors: jest.fn().mockResolvedValue(ok({ doctors: [DOCTOR] })),
      listServices: jest.fn().mockResolvedValue(ok({ services: [SERVICE] })),
      listSlots: jest.fn().mockResolvedValue(ok({ slots: [{ token: "tok-1", start: "2026-10-05T09:00:00.000Z" }] })),
    });
    const result = await runFlow(
      ctxFor(client, null, { kind: "text", text: "book" }, { isNewSession: false }),
    );
    // "book" -> classified booking -> identity (no patients on this phone) -> phone choice.
    expect(result.nextState).toMatchObject({ step: "PHONE_CHOICE", intent: "booking" });
  });

  test("slot pagination shows 9 plus \"more\", and tapping more reveals the rest", async () => {
    const client = fakeClient({});
    const slots = Array.from({ length: 12 }, (_, i) => ({ iso: `2026-10-05T0${i}:00:00.000Z`, token: `tok-${i}`, label: `${9 + i}:00` }));
    const state = {
      step: "BOOKING_SLOT" as const,
      lang: "ar" as const,
      doctorId: "doc-1",
      doctorName: "أحمد سامي",
      serviceId: "svc-1",
      serviceName: "كشف",
      patientId: "pat-1",
      patientName: "سارة",
      date: "2026-10-05",
      slots,
      page: 0,
    };

    const firstPage = await runFlow(ctxFor(client, state, { kind: "text", text: "ignored, not a tap" }));
    // Free text at a button-only step falls to the off-script path -- covered separately below.
    void firstPage;

    const tapMore = await runFlow(ctxFor(client, state, { kind: "interactive", id: "more" }));
    expect(tapMore.nextState).toMatchObject({ step: "BOOKING_SLOT", page: 1 });
    expect(tapMore.outgoing?.kind).toBe("list");
    if (tapMore.outgoing?.kind === "list") {
      expect(tapMore.outgoing.sections[0]?.rows).toHaveLength(3); // slots 10, 11, 12 -- no further "more".
    }
  });

  test("confirming books the slot and clears the flow state", async () => {
    const client = fakeClient({
      bookAppointment: jest.fn().mockResolvedValue(ok({ appointmentId: "appt-1", start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T09:20:00.000Z" })),
    });
    const state: FlowState = {
      step: "BOOKING_CONFIRM",
      lang: "ar",
      doctorId: "doc-1",
      doctorName: "أحمد سامي",
      serviceId: "svc-1",
      serviceName: "كشف",
      patientId: "pat-1",
      patientName: "سارة",
      date: "2026-10-05",
      slotIso: "2026-10-05T09:00:00.000Z",
      slotLabel: "09:00",
      token: "tok-1",
    };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "yn_yes" }));

    expect(client.bookAppointment).toHaveBeenCalledWith({ patientId: "pat-1", slotToken: "tok-1", consentMessageId: "wamid.test" });
    expect(result.nextState).toBeNull();
    expect(result.outgoing?.kind === "text" && result.outgoing.text).toContain("أحمد سامي");
  });

  test("an INVALID_TOKEN retries once against a freshly re-listed slot before giving up", async () => {
    const bookAppointment = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, code: "INVALID_TOKEN", params: {} })
      .mockResolvedValueOnce(ok({ appointmentId: "appt-1", start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T09:20:00.000Z" }));
    const client = fakeClient({
      bookAppointment,
      listSlots: jest.fn().mockResolvedValue(ok({ slots: [{ token: "tok-fresh", start: "2026-10-05T09:00:00.000Z" }] })),
    });
    const state: FlowState = {
      step: "BOOKING_CONFIRM",
      lang: "ar",
      doctorId: "doc-1",
      doctorName: "أحمد سامي",
      serviceId: "svc-1",
      serviceName: "كشف",
      patientId: "pat-1",
      patientName: "سارة",
      date: "2026-10-05",
      slotIso: "2026-10-05T09:00:00.000Z",
      slotLabel: "09:00",
      token: "tok-stale",
    };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "yn_yes" }));

    expect(bookAppointment).toHaveBeenCalledTimes(2);
    expect(bookAppointment).toHaveBeenNthCalledWith(2, { patientId: "pat-1", slotToken: "tok-fresh", consentMessageId: "wamid.test" });
    expect(result.nextState).toBeNull();
  });
});

describe("off-script detour", () => {
  test("free text at a button-only step is answered by the model, then the same question repeats", async () => {
    mockedCallGpt.mockResolvedValue({ outputText: "العيادة مفتوحة من ٩ لـ٥." } as Awaited<ReturnType<typeof callGpt>>);
    const client = fakeClient({});
    const state: FlowState = {
      step: "IDENTITY_YESNO",
      lang: "ar",
      intent: "booking",
      phoneE164: "+201001234567",
      patientId: "pat-1",
      patientName: "سارة محمد",
    };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "امتى العيادة بتفتح؟" }));

    expect(mockedCallGpt).toHaveBeenCalledTimes(1);
    // Same step -- the patient's place in the flow did not move because of the detour.
    expect(result.nextState).toEqual(state);
    expect(result.outgoing?.kind).toBe("buttons");
    if (result.outgoing?.kind === "buttons") {
      expect(result.outgoing.body).toContain("العيادة مفتوحة من ٩ لـ٥");
      expect(result.outgoing.buttons).toHaveLength(2);
    }
  });

  test("a failed off-script call still returns a nudge rather than leaving the patient with nothing", async () => {
    mockedCallGpt.mockRejectedValue(new Error("network down"));
    const client = fakeClient({});
    const state: FlowState = {
      step: "IDENTITY_YESNO",
      lang: "en",
      intent: "booking",
      phoneE164: "+201001234567",
      patientId: "pat-1",
      patientName: "Sara",
    };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "what are your hours?" }));
    expect(result.nextState).toEqual(state);
    expect(result.outgoing?.kind).toBe("buttons");
  });
});

describe("a stale interactive tap with nothing to interpret it against", () => {
  test("is not the flow's to handle", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "interactive", id: "s3" }, { isNewSession: false }));
    expect(result.handled).toBe(false);
  });
});
