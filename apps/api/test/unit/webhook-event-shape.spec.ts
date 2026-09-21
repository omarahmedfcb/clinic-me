import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildWebhookEvent,
  firstName,
  WEBHOOK_EVENT_KEYS,
  WEBHOOK_EVENT_TYPES,
  type EventSource,
} from "../../src/modules/bot/webhook-event.ts";
import { MAX_SIGNATURE_AGE_MS, signWebhookBody, verifyWebhookSignature } from "../../src/modules/bot/webhook-signing.ts";

/**
 * **The exact key set of an outbound event**, ruled 2026-09-18: a first name, a time, a doctor or
 * service, a status and our ids. Never a full name, a diagnosis, a note or an invoice.
 *
 * Pinned as an exact set rather than a list of forbidden fields, because the failure this guards
 * against is an added key, and no list of things-not-to-add can anticipate the next one.
 */
const SOURCE: EventSource = {
  eventId: "01a0b514-c525-7652-a24f-c5e63298a96d",
  eventType: "appointment.reminder",
  occurredAt: new Date("2026-09-18T08:00:00.000Z"),
  clinicId: "15b3937e-2bb0-4b13-b36d-9bbac97b10d1",
  appointmentId: "6f1d9a2c-8d2f-4d35-9d0f-0c1d2e3f4a5b",
  patientId: "9c8b7a65-4321-4f0e-9d8c-7b6a5f4e3d2c",
  patientFullName: "أحمد عبد الرحمن الشناوي",
  scheduledStart: new Date("2026-09-20T09:30:00.000Z"),
  doctorName: "د. منى سعيد",
  serviceName: "كشف",
  appointmentStatus: "BOOKED",
};

describe("an outbound event carries the minimum and nothing else", () => {
  test("its key set is exactly the eleven the ruling allows", () => {
    expect(Object.keys(buildWebhookEvent(SOURCE)).sort()).toEqual([...WEBHOOK_EVENT_KEYS].sort());
  });

  test("the name that leaves is the first one only", () => {
    expect(buildWebhookEvent(SOURCE).patientFirstName).toBe("أحمد");
    expect(JSON.stringify(buildWebhookEvent(SOURCE))).not.toContain("الشناوي");
    expect(firstName("  فاطمة  الزهراء ")).toBe("فاطمة");
  });

  test("nothing clinical or financial can be named in the body", () => {
    // The second direction, and the cheap one: these words are what a leak would look like.
    const forbidden = ["diagnosis", "notes", "prescription", "invoice", "amount", "complaint", "vitals"];
    const keys = WEBHOOK_EVENT_KEYS.map((key) => key.toLowerCase());
    for (const word of forbidden) expect(keys.some((key) => key.includes(word))).toBe(false);
  });

  test("the four event types are the contract's four", () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      "appointment.confirmed",
      "appointment.cancelled",
      "appointment.rescheduled",
      "appointment.reminder",
    ]);
  });

  test("the contract documents the same key set", () => {
    // Two readers, one shape: the external developer builds against the document, not this file.
    const contract = readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "docs", "WHATSAPP-BOT-CONTRACT.md"),
      "utf8",
    );
    const missing = WEBHOOK_EVENT_KEYS.filter((key) => !contract.includes("`" + key + "`"));
    expect(missing).toEqual([]);
  });
});

describe("a delivery is signed so it cannot be forged or replayed", () => {
  const secret = "a-signing-secret";
  const body = JSON.stringify(buildWebhookEvent(SOURCE));
  const now = new Date("2026-09-18T08:00:00.000Z");
  const timestamp = String(now.getTime());

  test("the signature verifies, and a changed body does not", () => {
    const signature = signWebhookBody(secret, timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature, now)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, `${body} `, signature, now)).toBe(false);
    expect(verifyWebhookSignature("another-secret", timestamp, body, signature, now)).toBe(false);
  });

  test("a replay outside the five-minute window does not verify", () => {
    // The timestamp is inside the signed string, so an attacker cannot re-date a captured delivery.
    const signature = signWebhookBody(secret, timestamp, body);
    const later = new Date(now.getTime() + MAX_SIGNATURE_AGE_MS + 1000);
    expect(verifyWebhookSignature(secret, timestamp, body, signature, later)).toBe(false);
  });
});
