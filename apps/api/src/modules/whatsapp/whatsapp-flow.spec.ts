// Drives runFlow() end-to-end against a fake BotApiClient -- no HTTP, no database, no real GPT call
// (jest.mock below replaces gpt-client.ts's callGpt with a stub). This is the first test coverage
// this module has had; it is not exhaustive (see the file-level comment in whatsapp-flow.ts for what
// each step does), but it exercises every kind of turn the step machine has to get right: the
// opener and its greeting, the phone-then-identity order, the mandatory medical complaint, typed
// dates read by the model, past slots, slot pagination, and the off-script detour that must never
// lose the patient's place in the flow.

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
  bot: { membershipId: "bot-membership", userId: "bot-user" },
};

const DOCTOR: BotDoctor = { id: "doc-1", fullName: "أحمد سامي", title: "Dr.", specialty: "أسنان" };
const SERVICE: BotService = { id: "svc-1", nameAr: "كشف", nameEn: "Consultation", durationMinutes: 20, priceMinor: 30000, currency: "EGP" };

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

/** Pins "now" without faking timers the flow's promises depend on -- only `Date` is replaced. */
function freezeNow(iso: string): void {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
      "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
      "setTimeout", "clearTimeout",
    ],
  });
}

/** 2026-10-12 11:00 in Cairo (UTC+3 while Egypt's summer time is on). */
const MORNING = "2026-10-12T08:00:00.000Z";
/** 2026-10-12 15:00 in Cairo. */
const AFTERNOON = "2026-10-12T12:00:00.000Z";

const BOOKING_BASE = {
  lang: "ar" as const,
  doctorId: "doc-1",
  doctorName: "أحمد سامي",
  serviceId: "svc-1",
  serviceName: "كشف",
  patientId: "pat-1",
  patientName: "سارة",
  complaint: "ألم في الضرس",
};

function gptSays(text: string): void {
  mockedCallGpt.mockResolvedValue({ outputText: text } as Awaited<ReturnType<typeof callGpt>>);
}

beforeEach(() => {
  mockedCallGpt.mockReset();
  gptSays("");
});

afterEach(() => {
  jest.useRealTimers();
});

describe("opening a session", () => {
  test("any opener gets the greeting plus the first booking question -- no menu", async () => {
    freezeNow(MORNING);
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "ازيك" }, { isNewSession: true }));

    expect(result.handled).toBe(true);
    expect(result.nextState).toEqual({ step: "PHONE_CHOICE", lang: "ar" });
    expect(result.outgoing?.kind).toBe("buttons");
    if (result.outgoing?.kind === "buttons") {
      expect(result.outgoing.body).toContain(TENANT.clinicName);
      expect(result.outgoing.body).toContain("+201001234567");
      expect(result.outgoing.buttons.map((b) => b.id)).toEqual(["yn_yes", "yn_no"]);
    }
    // Opening never needs the model any more.
    expect(mockedCallGpt).not.toHaveBeenCalled();
  });

  test("says صباح before 12:00 Cairo time and مساء from 12:00", async () => {
    const client = fakeClient({});

    freezeNow(MORNING);
    const morning = await runFlow(ctxFor(client, null, { kind: "text", text: "ازيك" }, { isNewSession: true }));
    expect(morning.outgoing?.kind === "buttons" && morning.outgoing.body).toContain("صباح الخير");

    jest.useRealTimers();
    freezeNow(AFTERNOON);
    const afternoon = await runFlow(ctxFor(client, null, { kind: "text", text: "ازيك" }, { isNewSession: true }));
    expect(afternoon.outgoing?.kind === "buttons" && afternoon.outgoing.body).toContain("مساء الخير");
  });

  test("an English opener is answered in English", async () => {
    freezeNow(MORNING);
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "hi there" }, { isNewSession: true }));
    expect(result.nextState).toEqual({ step: "PHONE_CHOICE", lang: "en" });
    expect(result.outgoing?.kind === "buttons" && result.outgoing.body).toContain("Good morning");
  });

  test("a thank-you after a finished booking is acknowledged, not answered with a new booking", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text: "شكرا" }));
    expect(result.nextState).toBeNull();
    expect(result.outgoing?.kind).toBe("text");
  });

  test.each([".", "تمام", "ok"])("a new session opening with %j is welcomed, not signed off", async (text) => {
    freezeNow(MORNING);
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, null, { kind: "text", text }, { isNewSession: true }));
    expect(result.nextState?.step).toBe("PHONE_CHOICE");
    expect(result.outgoing?.kind === "buttons" && result.outgoing.body).toContain(TENANT.clinicName);
  });

  test("a state left by the old complaint flow is dropped and a fresh booking starts", async () => {
    const client = fakeClient({});
    const legacy = { step: "COMPLAINT_TEXT", lang: "ar", patientId: "pat-1", patientName: "سارة" } as unknown as FlowState;
    const result = await runFlow(ctxFor(client, legacy, { kind: "text", text: "الدكتور اتأخر" }));
    expect(result.nextState).toEqual({ step: "PHONE_CHOICE", lang: "ar" });
  });
});

describe("identity: the number first, then the patient's own full name", () => {
  const known = { patientId: "pat-1", displayName: "سارة محمد علي", relationshipToContact: "SELF", intakeIncomplete: false };
  const nameAsk = { step: "NAME_ASK", lang: "ar", phoneE164: "+201001234567" } as const;

  test("yes to 'this number' goes straight to asking the name -- nothing stored is looked up or shown", async () => {
    const findPatientsByPhone = jest.fn().mockResolvedValue(ok({ patients: [known] }));
    const client = fakeClient({ findPatientsByPhone });
    const result = await runFlow(ctxFor(client, { step: "PHONE_CHOICE", lang: "ar" }, { kind: "interactive", id: "yn_yes" }));

    expect(findPatientsByPhone).not.toHaveBeenCalled();
    expect(result.nextState).toEqual({ step: "NAME_ASK", lang: "ar", phoneE164: "+201001234567" });
    expect(result.outgoing?.kind).toBe("text");
    expect(JSON.stringify(result.outgoing)).not.toContain("سارة");
  });

  test("no to 'this number' asks for the actual number, and nothing is looked up yet", async () => {
    const findPatientsByPhone = jest.fn();
    const client = fakeClient({ findPatientsByPhone });
    const result = await runFlow(ctxFor(client, { step: "PHONE_CHOICE", lang: "ar" }, { kind: "interactive", id: "yn_no" }));
    expect(result.nextState).toEqual({ step: "PHONE_ASK", lang: "ar" });
    expect(findPatientsByPhone).not.toHaveBeenCalled();
  });

  test("a typed 'ايوه' at the number question counts as yes", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, { step: "PHONE_CHOICE", lang: "ar" }, { kind: "text", text: "ايوه" }));
    expect(result.nextState).toMatchObject({ step: "NAME_ASK", phoneE164: "+201001234567" });
  });

  test("the number the patient types is normalised and carried to the name step", async () => {
    const client = fakeClient({});
    const result = await runFlow(ctxFor(client, { step: "PHONE_ASK", lang: "ar" }, { kind: "text", text: "01012345678" }));
    expect(result.nextState).toEqual({ step: "NAME_ASK", lang: "ar", phoneE164: "+201012345678" });
  });

  test("a one-word name is asked for again", async () => {
    const findPatientsByPhone = jest.fn();
    const client = fakeClient({ findPatientsByPhone });
    const result = await runFlow(ctxFor(client, nameAsk, { kind: "text", text: "سارة" }));
    expect(result.nextState).toEqual(nameAsk);
    expect(findPatientsByPhone).not.toHaveBeenCalled();
  });

  test("a name that is not on the number creates a new patient (and the model is not asked)", async () => {
    const createProvisionalPatient = jest.fn().mockResolvedValue(ok({ patientId: "pat-2", displayName: "منى حسن" }));
    const client = fakeClient({
      findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [known] })),
      createProvisionalPatient,
    });
    const result = await runFlow(ctxFor(client, nameAsk, { kind: "text", text: "منى حسن" }));
    expect(createProvisionalPatient).toHaveBeenCalledWith({ fullNameAr: "منى حسن", phoneE164: "+201001234567" });
    expect(result.nextState).toMatchObject({ step: "BOOKING_COMPLAINT", patientId: "pat-2" });
    expect(mockedCallGpt).not.toHaveBeenCalled();
  });

  test("the same name reuses the patient, and the patient only ever sees the name they typed", async () => {
    const createProvisionalPatient = jest.fn();
    const client = fakeClient({
      findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [known] })),
      createProvisionalPatient,
    });
    // Spelling and word order differ; a middle name is left out. All settled locally.
    const result = await runFlow(ctxFor(client, nameAsk, { kind: "text", text: "سارة علي" }));
    expect(createProvisionalPatient).not.toHaveBeenCalled();
    expect(mockedCallGpt).not.toHaveBeenCalled();
    expect(result.nextState).toMatchObject({ step: "BOOKING_COMPLAINT", patientId: "pat-1", patientName: "سارة علي" });
  });

  test("a related but unclear name goes to the model, which can only pick from the names on the number", async () => {
    gptSays("1");
    const createProvisionalPatient = jest.fn();
    const client = fakeClient({
      findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [known] })),
      createProvisionalPatient,
    });
    const result = await runFlow(ctxFor(client, nameAsk, { kind: "text", text: "Sara Mohamed Aly" }));
    expect(mockedCallGpt).toHaveBeenCalledTimes(1);
    expect(createProvisionalPatient).not.toHaveBeenCalled();
    expect(result.nextState).toMatchObject({ step: "BOOKING_COMPLAINT", patientId: "pat-1", patientName: "Sara Mohamed Aly" });
  });

  test("a model answer that is not one of the offered numbers means a new patient", async () => {
    gptSays("7");
    const createProvisionalPatient = jest.fn().mockResolvedValue(ok({ patientId: "pat-3", displayName: "Sara Mohamed Aly" }));
    const client = fakeClient({
      findPatientsByPhone: jest.fn().mockResolvedValue(ok({ patients: [known] })),
      createProvisionalPatient,
    });
    const result = await runFlow(ctxFor(client, nameAsk, { kind: "text", text: "Sara Mohamed Aly" }));
    expect(createProvisionalPatient).toHaveBeenCalledTimes(1);
    expect(result.nextState).toMatchObject({ patientId: "pat-3" });
  });
});

describe("the medical complaint", () => {
  test("is required: a too-short answer is asked again and nothing moves on", async () => {
    const client = fakeClient({});
    const state: FlowState = { step: "BOOKING_COMPLAINT", lang: "ar", patientId: "pat-1", patientName: "سارة" };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "." }));
    expect(result.nextState).toEqual(state);
    expect(client.listDoctors).not.toHaveBeenCalled();
  });

  test("a real answer is carried into the next step's state", async () => {
    freezeNow(MORNING);
    const client = fakeClient({
      listSlots: jest.fn().mockResolvedValue(ok({ slots: [{ token: "t", start: "2026-10-12T11:00:00.000Z" }] })),
    });
    const state: FlowState = { step: "BOOKING_COMPLAINT", lang: "ar", patientId: "pat-1", patientName: "سارة" };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "ألم في الضرس من يومين" }));
    // One doctor and one service are never asked about, so the date list is next.
    expect(result.nextState).toMatchObject({ step: "BOOKING_DATE", patientId: "pat-1", complaint: "ألم في الضرس من يومين" });
  });
});

describe("dates and slots", () => {
  test("today is not offered once its last slot has already started", async () => {
    freezeNow(AFTERNOON); // 15:00 in Cairo
    const listSlots = jest.fn().mockImplementation(async ({ date }: { date: string }) =>
      ok({
        slots:
          date === "2026-10-12"
            ? [{ token: "past", start: "2026-10-12T11:00:00.000Z" }] // 14:00 Cairo -- gone
            : [{ token: `t-${date}`, start: `${date}T09:00:00.000Z` }],
      }),
    );
    const client = fakeClient({ listSlots });
    const state: FlowState = { step: "BOOKING_COMPLAINT", lang: "ar", patientId: "pat-1", patientName: "سارة" };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "كشف عادي" }));

    expect(result.outgoing?.kind).toBe("list");
    if (result.outgoing?.kind === "list") {
      const ids = result.outgoing.sections[0]!.rows.map((r) => r.id);
      expect(ids).not.toContain("date_2026-10-12");
      expect(ids).toContain("date_2026-10-13");
    }
  });

  test("on the day itself, slots before the current time are not listed", async () => {
    freezeNow(AFTERNOON); // 15:00 in Cairo
    const client = fakeClient({
      listSlots: jest.fn().mockResolvedValue(
        ok({
          slots: [
            { token: "a", start: "2026-10-12T09:00:00.000Z" }, // 12:00
            { token: "b", start: "2026-10-12T11:00:00.000Z" }, // 14:00
            { token: "c", start: "2026-10-12T13:00:00.000Z" }, // 16:00
          ],
        }),
      ),
    });
    const state: FlowState = { step: "BOOKING_DATE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "date_2026-10-12" }));

    expect(result.nextState).toMatchObject({ step: "BOOKING_SLOT", slots: [{ token: "c" }] });
    if (result.outgoing?.kind === "list") {
      expect(result.outgoing.sections[0]?.rows).toHaveLength(1);
    }
  });

  test("a day with nothing left puts the date list back in front of the patient", async () => {
    freezeNow(AFTERNOON);
    const client = fakeClient({
      listSlots: jest.fn().mockImplementation(async ({ date }: { date: string }) =>
        ok({ slots: date === "2026-10-12" ? [{ token: "past", start: "2026-10-12T09:00:00.000Z" }] : [{ token: "t", start: `${date}T09:00:00.000Z` }] }),
      ),
    });
    const state: FlowState = { step: "BOOKING_DATE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "date_2026-10-12" }));
    expect(result.nextState).toMatchObject({ step: "BOOKING_DATE", complaint: "ألم في الضرس" });
    expect(result.outgoing?.kind).toBe("list");
  });

  test("typed text instead of a row is sent to the model and its date is used", async () => {
    freezeNow(MORNING);
    gptSays("2026-10-15");
    const listSlots = jest.fn().mockResolvedValue(ok({ slots: [{ token: "t", start: "2026-10-15T09:00:00.000Z" }] }));
    const client = fakeClient({ listSlots });
    const state: FlowState = { step: "BOOKING_DATE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "الخميس الجاي" }));

    expect(mockedCallGpt).toHaveBeenCalledTimes(1);
    expect(mockedCallGpt.mock.calls[0]![0].instructions).toContain("2026-10-12");
    expect(listSlots).toHaveBeenCalledWith({ doctorId: "doc-1", serviceId: "svc-1", date: "2026-10-15" });
    expect(result.nextState).toMatchObject({ step: "BOOKING_SLOT", date: "2026-10-15" });
  });

  test("a model answer that is not a real date is not trusted", async () => {
    freezeNow(MORNING);
    gptSays("2026-02-31");
    const listSlots = jest.fn().mockResolvedValue(ok({ slots: [] }));
    const client = fakeClient({ listSlots });
    const state: FlowState = { step: "BOOKING_DATE_FREE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "الحادي والثلاثين من فبراير" }));
    expect(result.nextState).toEqual(state);
    expect(listSlots).not.toHaveBeenCalled();
  });

  test("a plain date still works if the model call fails", async () => {
    freezeNow(MORNING);
    mockedCallGpt.mockRejectedValue(new Error("network down"));
    const listSlots = jest.fn().mockResolvedValue(ok({ slots: [{ token: "t", start: "2026-10-20T09:00:00.000Z" }] }));
    const client = fakeClient({ listSlots });
    const state: FlowState = { step: "BOOKING_DATE_FREE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "20-10-2026" }));
    expect(result.nextState).toMatchObject({ step: "BOOKING_SLOT", date: "2026-10-20" });
  });

  test("a bare number under the date list is a row choice, not a date for the model", async () => {
    freezeNow(MORNING);
    const client = fakeClient({
      listSlots: jest.fn().mockResolvedValue(ok({ slots: [{ token: "t", start: "2026-10-13T09:00:00.000Z" }] })),
    });
    const state: FlowState = { step: "BOOKING_DATE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "1" }));
    expect(mockedCallGpt).not.toHaveBeenCalled();
    expect(result.nextState).toMatchObject({ step: "BOOKING_SLOT" });
  });

  test("a date in the past is refused", async () => {
    freezeNow(MORNING);
    gptSays("2026-10-01");
    const client = fakeClient({});
    const state: FlowState = { step: "BOOKING_DATE_FREE", ...BOOKING_BASE };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "أول أكتوبر" }));
    expect(result.nextState).toEqual(state);
    expect(client.listSlots).not.toHaveBeenCalled();
  });
});

describe("booking flow end to end", () => {
  test("slot pagination shows 9 plus \"more\", and tapping more reveals the rest", async () => {
    const client = fakeClient({});
    const slots = Array.from({ length: 12 }, (_, i) => ({ iso: `2026-10-05T0${i}:00:00.000Z`, token: `tok-${i}`, label: `${9 + i}:00` }));
    const state: FlowState = { step: "BOOKING_SLOT", ...BOOKING_BASE, date: "2026-10-05", slots, page: 0 };

    const tapMore = await runFlow(ctxFor(client, state, { kind: "interactive", id: "more" }));
    expect(tapMore.nextState).toMatchObject({ step: "BOOKING_SLOT", page: 1, complaint: "ألم في الضرس" });
    expect(tapMore.outgoing?.kind).toBe("list");
    if (tapMore.outgoing?.kind === "list") {
      expect(tapMore.outgoing.sections[0]?.rows).toHaveLength(3); // slots 10, 11, 12 -- no further "more".
    }
  });

  test("picking a slot shows the complaint on the confirmation", async () => {
    const client = fakeClient({});
    const slots = [{ iso: "2026-10-13T09:00:00.000Z", token: "tok-1", label: "12:00" }];
    const state: FlowState = { step: "BOOKING_SLOT", ...BOOKING_BASE, date: "2026-10-13", slots, page: 0 };
    const result = await runFlow(ctxFor(client, state, { kind: "interactive", id: "s1" }));
    expect(result.nextState).toMatchObject({ step: "BOOKING_CONFIRM", complaint: "ألم في الضرس", token: "tok-1" });
    expect(result.outgoing?.kind === "buttons" && result.outgoing.body).toContain("ألم في الضرس");
  });

  const confirmState: FlowState = {
    step: "BOOKING_CONFIRM",
    ...BOOKING_BASE,
    date: "2026-10-05",
    slotIso: "2026-10-05T09:00:00.000Z",
    slotLabel: "09:00",
    token: "tok-1",
  };

  test("confirming books the slot with the complaint and clears the flow state", async () => {
    const client = fakeClient({
      bookAppointment: jest.fn().mockResolvedValue(ok({ appointmentId: "appt-1", start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T09:20:00.000Z" })),
    });
    const result = await runFlow(ctxFor(client, confirmState, { kind: "interactive", id: "yn_yes" }));

    expect(client.bookAppointment).toHaveBeenCalledWith({
      patientId: "pat-1",
      slotToken: "tok-1",
      consentMessageId: "wamid.test",
      complaintSummary: "ألم في الضرس",
    });
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
    const result = await runFlow(ctxFor(client, { ...confirmState, token: "tok-stale" } as FlowState, { kind: "interactive", id: "yn_yes" }));

    expect(bookAppointment).toHaveBeenCalledTimes(2);
    expect(bookAppointment).toHaveBeenNthCalledWith(2, {
      patientId: "pat-1",
      slotToken: "tok-fresh",
      consentMessageId: "wamid.test",
      complaintSummary: "ألم في الضرس",
    });
    expect(result.nextState).toBeNull();
  });
});

describe("off-script detour", () => {
  test("free text at a button-only step is answered by the model, then the same question repeats", async () => {
    gptSays("العيادة مفتوحة من ٩ لـ٥.");
    const client = fakeClient({});
    const state: FlowState = { step: "PHONE_CHOICE", lang: "ar" };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "امتى العيادة بتفتح؟" }));

    expect(mockedCallGpt).toHaveBeenCalledTimes(1);
    // Same step -- the patient's place in the flow did not move because of the detour (only the
    // miss counter went up).
    expect(result.nextState).toMatchObject(state);
    expect(result.outgoing?.kind).toBe("buttons");
    if (result.outgoing?.kind === "buttons") {
      expect(result.outgoing.body).toContain("العيادة مفتوحة من ٩ لـ٥");
      expect(result.outgoing.buttons).toHaveLength(2);
    }
  });

  test("a failed off-script call still returns a nudge rather than leaving the patient with nothing", async () => {
    mockedCallGpt.mockRejectedValue(new Error("network down"));
    const client = fakeClient({});
    const state: FlowState = { step: "PHONE_CHOICE", lang: "en" };
    const result = await runFlow(ctxFor(client, state, { kind: "text", text: "what are your hours?" }));
    expect(result.nextState).toMatchObject(state);
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
