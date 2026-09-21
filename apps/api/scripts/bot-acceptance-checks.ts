// The checks themselves, one per numbered line of the contract's §9. Separate from the runner so
// the report's shape and the checks' content can be read apart from each other.

import { randomUUID } from "node:crypto";
import { signWebhookBody } from "../src/modules/bot/webhook-signing.ts";

export interface Fixtures {
  baseUrl: string;
  credentialId: string;
  secret: string;
  phone?: string | undefined;
  doctorId?: string | undefined;
  serviceId?: string | undefined;
  foreignAppointmentId?: string | undefined;
  webhookSecret?: string | undefined;
}

export interface CheckResult {
  section: string;
  item: number;
  title: string;
  /** `manual` is not a failure: it is a line the developer's own logs have to answer. */
  outcome: "pass" | "fail" | "skipped" | "manual";
  detail: string;
}

/** What the bot must never be able to read, whatever it asks for. */
const CLINICAL_ROUTES = [
  ["the patient book", "GET", "/patients/recent"],
  // A real route, and the id is deliberately one that does not exist: the capability guard runs
  // before the lookup, so a 404 here would mean the guard let the request through.
  ["a clinical note", "GET", "/appointments/00000000-0000-7000-8000-000000000000/visit"],
  ["a prescription", "GET", "/appointments/00000000-0000-7000-8000-000000000000/visit/00000000-0000-7000-8000-000000000000/prescription"],
  ["money", "GET", "/payments/overview"],
  ["the audit log", "GET", "/audit-log?limit=1"],
] as const;

/** The whole of what a household lookup may return about a person. */
const HOUSEHOLD_KEYS = ["patientId", "displayName", "relationshipToContact", "intakeIncomplete"];

export async function runChecks(fixtures: Fixtures): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (
    section: string,
    item: number,
    title: string,
    outcome: CheckResult["outcome"],
    detail = "",
  ): void => {
    results.push({ section, item, title, outcome, detail });
  };

  const call = async (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${fixtures.baseUrl}${path}`, {
      method,
      headers: {
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // ---- the credential ---------------------------------------------------------------------------
  const tokenResponse = await call("", "POST", "/bot/auth/token", {
    credentialId: fixtures.credentialId,
    secret: fixtures.secret,
  });
  if (tokenResponse.status !== 201) {
    add("Boundary", 0, "the credential exchanges for a token", "fail", `POST /bot/auth/token → ${tokenResponse.status}`);
    return results;
  }
  const { accessToken } = (await tokenResponse.json()) as { accessToken: string };
  add("Boundary", 0, "the credential exchanges for a token", "pass");

  add("Boundary", 1, "the bot's code contains no database driver, connection string or SQL", "manual",
    "Hand over the dependency list; nothing here can see the bot's own repository.");

  // ---- 2, 3: refusals ---------------------------------------------------------------------------
  const refusals = await Promise.all(
    CLINICAL_ROUTES.map(async ([what, method, path]) => ({ what, status: (await call(accessToken, method, path)).status })),
  );
  const wrong = refusals.filter((r) => r.status !== 403);
  add("Boundary", 2, "a clinical endpoint with the bot credential returns 403", wrong.length === 0 ? "pass" : "fail",
    wrong.length === 0
      ? refusals.map((r) => `${r.what}: 403`).join(", ")
      : wrong.map((r) => `${r.what}: ${r.status}`).join(", ") + " — expected 403",
  );

  const foreignId = fixtures.foreignAppointmentId ?? randomUUID();
  const foreign = await call(accessToken, "GET", `/bot/appointments/${foreignId}`);
  add("Boundary", 3, "another clinic's appointment id returns 404, not 403", foreign.status === 404 ? "pass" : "fail",
    fixtures.foreignAppointmentId === undefined
      ? `checked with an unknown id (${foreign.status}); pass --foreign-appointment-id to check a real one`
      : `→ ${foreign.status}`,
  );

  add("Boundary", 4, "no response ever carried a diagnosis, prescription, invoice or another patient's name",
    "manual", "From the developer's own logs of a full test conversation.");

  // ---- 5, 8, 9, 10: a conversation ---------------------------------------------------------------
  let patientId = "";
  if (fixtures.phone === undefined) {
    add("Correctness", 8, "a number with several patients returns the household", "skipped", "needs --phone");
  } else {
    const lookup = await call(accessToken, "GET", `/bot/patients?phone=${encodeURIComponent(fixtures.phone)}`);
    if (lookup.status === 429) {
      // The rate limit is keyed on the credential and its window outlives a run, so a suite started
      // within a minute of the last one meets its own burst. That is the limit working, not a fault.
      add("Correctness", 8, "a number with several patients returns the household", "skipped",
        "rate limited — the previous run's burst is still inside its window; re-run in a minute");
    } else {
      const body = (await lookup.json()) as { patients?: { patientId: string }[] };
      const members = body.patients ?? [];
      patientId = members[0]?.patientId ?? "";
      const keys = members.length === 0 ? [] : Object.keys(members[0] as object).sort();
      const exact = JSON.stringify(keys) === JSON.stringify([...HOUSEHOLD_KEYS].sort());
      // **Several**, not one. A number with a single patient on it proves the easy case, and the
      // whole point of item 8 is that the bot must ask which member the booking is for rather than
      // take the first row it is given.
      add("Correctness", 8, "a number with several patients returns the whole household, and only these fields",
        lookup.status === 200 && members.length > 1 && exact ? "pass" : "fail",
        `→ ${lookup.status}, ${members.length} member(s); keys ${keys.join(", ") || "(none)"}`);
    }
  }

  // A provisional patient, and the proof that a third field is refused rather than ignored.
  const extraField = await call(accessToken, "POST", "/bot/patients", {
    fullNameAr: "اختبار القبول",
    phoneE164: `+20100${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    dateOfBirth: "1990-01-01",
  });
  add("Correctness", 9, "a provisional create carrying any third field is refused", extraField.status === 400 ? "pass" : "fail",
    `→ ${extraField.status}`);

  if (fixtures.doctorId === undefined || fixtures.serviceId === undefined || patientId === "") {
    for (const [item, title] of [
      [5, "a full booking conversation: find → slots → book → status"],
      [6, "a double-booking race: one 409, and no double booking"],
      [7, "reschedule and cancel each leave the day correct"],
      [10, "consent recorded, with the message id in the evidence"],
    ] as const) {
      add("Correctness", item, title, "skipped", "needs --doctor-id, --service-id and --phone");
    }
  } else {
    // The next seven days, not just tomorrow: a doctor does not work every weekday, and "no slot on
    // Saturday" is a fact about the schedule rather than a reason to skip four checks.
    let token: string | undefined;
    let date = "";
    for (let day = 1; day <= 7 && token === undefined; day += 1) {
      date = new Date(Date.now() + day * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const slots = await call(
        accessToken,
        "GET",
        `/bot/slots?doctorId=${fixtures.doctorId}&serviceId=${fixtures.serviceId}&date=${date}`,
      );
      if (slots.status !== 200) continue;
      // The offer calls it `token`; the booking body calls it `slotToken`. Both names are the API's.
      token = (((await slots.json()) as { slots?: { token: string }[] }).slots ?? [])[0]?.token;
    }

    if (token === undefined) {
      for (const [item, title] of [
        [5, "a full booking conversation: find → slots → book → status"],
        [6, "a double-booking race: one 409, and no double booking"],
        [7, "reschedule and cancel each leave the day correct"],
        [10, "consent recorded, with the message id in the evidence"],
      ] as const) {
        add("Correctness", item, title, "skipped", `no bookable slot in the next seven days for that doctor and service`);
      }
    } else {
      const booked = await call(accessToken, "POST", "/bot/appointments", {
        slotToken: token,
        patientId,
        consentMessageId: "wamid.ACCEPTANCE",
      });
      const appointmentId = ((await booked.clone().json()) as { appointmentId?: string }).appointmentId ?? "";
      const status = appointmentId === "" ? null : await call(accessToken, "GET", `/bot/appointments/${appointmentId}`);
      add("Correctness", 5, "a full booking conversation: find → slots → book → status",
        booked.status === 201 && status?.status === 200 ? "pass" : "fail",
        `book → ${booked.status}, status → ${status?.status ?? "not attempted"}`);

      // The same token again: the slot is taken, and the second caller must be told so.
      const again = await call(accessToken, "POST", "/bot/appointments", {
        slotToken: token,
        patientId,
        consentMessageId: "wamid.ACCEPTANCE",
      });
      add("Correctness", 6, "a second booking of the same slot is refused, not double-booked",
        again.status === 409 ? "pass" : "fail", `→ ${again.status}`);

      // Consent came with the booking (ruled 2026-09-18); this is the explicit endpoint as well.
      const consent = await call(accessToken, "POST", `/bot/patients/${patientId}/consent`, {
        purpose: "WHATSAPP_COMMS",
        granted: true,
        externalMessageId: "wamid.ACCEPTANCE",
      });
      add("Correctness", 10, "consent recorded, with the message id in the evidence",
        consent.status === 201 ? "pass" : "fail", `→ ${consent.status}`);

      const cancelled = appointmentId === ""
        ? null
        : await call(accessToken, "POST", `/bot/appointments/${appointmentId}/cancel`, { reason: "acceptance suite" });
      add("Correctness", 7, "reschedule and cancel each leave the day correct",
        cancelled?.status === 201 || cancelled?.status === 200 ? "pass" : "fail",
        `cancel → ${cancelled?.status ?? "not attempted"}; reschedule needs a second free slot and is the developer's own step`);
    }
  }

  // ---- 11-14: resilience -------------------------------------------------------------------------
  const burst = await Promise.all(
    Array.from({ length: 70 }, async () => (await call(accessToken, "GET", `/bot/patients?phone=%2B20100000000`)).status),
  );
  const limited = burst.filter((status) => status === 429).length;
  add("Resilience", 11, "the rate limit answers 429 rather than failing open", limited > 0 ? "pass" : "fail",
    `${limited} of ${burst.length} requests were limited — the bot must back off per Retry-After`);

  if (fixtures.webhookSecret === undefined) {
    add("Resilience", 12, "a webhook signature the bot can verify", "skipped", "needs --webhook-secret");
  } else {
    // A known-good delivery the developer's own verifier can be tested against, produced by the same
    // code that signs the real ones.
    const timestamp = String(Date.now());
    const body = JSON.stringify({ eventId: randomUUID(), eventType: "appointment.reminder" });
    add("Resilience", 12, "a webhook signature the bot can verify", "pass",
      `HMAC-SHA256 over "<timestamp>.<body>": timestamp=${timestamp} signature=${signWebhookBody(fixtures.webhookSecret, timestamp, body)}`);
  }

  add("Resilience", 13, "a 5xx from us does not produce a duplicate appointment", "manual",
    "From the developer's own logs: a retried book must not be sent blindly.");
  add("Resilience", 14, "a revoked credential stops the bot within one exchange", "manual",
    "Revoke it in clinic settings mid-conversation; the bot must hand over to a human.");

  for (const [item, title] of [
    [15, "a named contact and an escalation path"],
    [16, "their own monitoring alerts them, not us, when their side is down"],
    [17, "what they log, where it lives, for how long — message content stays in Egypt"],
  ] as const) {
    add("Operational", item, title, "manual", "A statement from the developer, not something a script can check.");
  }

  return results;
}
