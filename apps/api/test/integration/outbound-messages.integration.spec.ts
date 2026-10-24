import { randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { ensureWhatsAppConsent } from "../../src/modules/bot/bot.service.ts";
import { runOutboundPass, type OutboundDeps } from "../../src/modules/whatsapp/outbound-messages.ts";
import { handleReminderTap } from "../../src/modules/whatsapp/reminder-reply.ts";
import { resolveTenantByPhoneNumberId } from "../../src/modules/whatsapp/whatsapp-tenants.ts";
import { reminderPayloads } from "../../src/modules/whatsapp/whatsapp-templates.ts";
import type { WhatsAppTemplateSend } from "../../src/modules/whatsapp/whatsapp-graph-client.ts";
import { resolveDocumentToken } from "../../src/modules/visit-documents/visit-document-links.ts";
import { loadVisitDocuments } from "../../src/modules/visit-documents/visit-documents.service.ts";
import type { StorageProvider } from "../../src/modules/attachments/storage/storage-provider.ts";
import { generateFixturePhone } from "../fixture-phone.ts";
import { actorFor, createTestUser, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * The WhatsApp outbox end to end: the sweeper that finds due reminders, the patient's tap, the silence that
 * cancels, the two messages the database enqueues by trigger, and the documents link.
 *
 * Meta is a fake. What is under test is which message goes to whom and when, never Meta's behaviour.
 */
describe("the WhatsApp outbox", () => {
  let clinic: ClinicFixture;
  let phoneNumberId = "";
  const HOUR = 60 * 60_000;

  const templates: { to: string; template: WhatsAppTemplateSend }[] = [];
  const texts: { to: string; body: string }[] = [];
  let failNext: Error | null = null;

  const deps: OutboundDeps = {
    sendTemplate: async (_id, to, template) => {
      if (failNext !== null) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      templates.push({ to, template });
      return { externalMessageId: `wamid.${randomUUID()}` };
    },
    sendText: async (_id, to, body) => {
      texts.push({ to, body });
      return { externalMessageId: `wamid.${randomUUID()}` };
    },
  };

  const asClinic = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>): Promise<T> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), fn);

  // Every test books the same doctor, and the database refuses two appointments in one slot, so each gets its own.
  //
  // Tomorrow from 11:00 UTC (13:00-14:00 in Cairo), an hour apart. Pinned to the middle of the clinic's day
  // rather than "N hours from now" on purpose: reminders are never sent at night, so a spec that derived its
  // appointments from the wall clock would pass in the afternoon and fail after 21:00.
  let slotCount = 0;
  const firstSlot = new Date();
  firstSlot.setUTCDate(firstSlot.getUTCDate() + 1);
  firstSlot.setUTCHours(11, 0, 0, 0);
  const slot = (): Date => new Date(firstSlot.getTime() + slotCount++ * HOUR);

  const book = async (
    start: Date,
    status: "BOOKED" | "CONFIRMED" = "BOOKED",
    createdAt?: Date,
    patientId: string = clinic.patientId,
  ): Promise<string> => {
    const id = uuidv7();
    await asClinic((tx) =>
      tx.appointment.create({
        data: injected({
          id,
          patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status,
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
          ...(createdAt === undefined ? {} : { createdAt }),
        }),
      }),
    );
    return id;
  };

  const intents = (appointmentId: string) =>
    asClinic((tx) => tx.outboundMessageIntent.findMany({ where: { appointmentId }, orderBy: { createdAt: "asc" } }));

  const statusOf = async (appointmentId: string): Promise<string> =>
    asClinic(async (tx) => (await tx.appointment.findFirstOrThrow({ where: { id: appointmentId } })).status);

  const patientPhone = async (): Promise<string> =>
    asClinic(async (tx) => (await tx.patient.findFirstOrThrow({ where: { id: clinic.patientId } })).phoneE164);

  const enable = async (data: Record<string, boolean | number | string>): Promise<void> => {
    // A tenant update is audited, so it needs an actor bound like any other write.
    await asClinic((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data }));
  };

  beforeAll(async () => {
    process.env["WHATSAPP_ACCESS_TOKEN"] = "test-token";
    process.env["BOT_CREDENTIAL_ID"] = "test-credential";
    process.env["BOT_CREDENTIAL_SECRET"] = "test-secret";

    clinic = await seedClinic();
    phoneNumberId = `pn-${randomUUID()}`;
    await enable({ whatsappPhoneNumberId: phoneNumberId, timezone: "Africa/Cairo" });

    const botUserId = await createTestUser();
    await asClinic((tx) =>
      tx.membership.create({ data: injected({ id: randomUUID(), userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }) }),
    );
  });

  afterAll(async () => {
    await teardownClinic(clinic);
  });

  beforeEach(async () => {
    templates.length = 0;
    texts.length = 0;
    failNext = null;
    await enable({ appointmentRemindersEnabled: false, callInMessageEnabled: false, visitDocumentsLinkEnabled: false });
  });

  const consent = async (): Promise<void> => {
    await ensureWhatsAppConsent(
      { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) },
      clinic.patientId,
      `wamid.${randomUUID()}`,
      new Date(),
    );
  };

  describe("the reminder", () => {
    it("is sent once, as a template with Confirm, Edit and Cancel, and the deadline is in it", async () => {
      await enable({ appointmentRemindersEnabled: true });
      await consent();
      // Noon-to-evening so quiet hours cannot move it: booked a week ago, 3 hours from now is inside the
      // lead window, so use 6 hours with the clock moved to when the reminder is due.
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR));

      // Run the pass at the instant the reminder is due (start - 5h), so quiet hours cannot be in play.
      const due = new Date(start.getTime() - 5 * HOUR + 60_000);
      const first = await runOutboundPass(due, deps);
      const second = await runOutboundPass(new Date(due.getTime() + 60_000), deps);

      expect(first.remindersQueued).toBeGreaterThanOrEqual(1);
      expect(second.remindersQueued).toBe(0);

      const sent = templates.filter((t) => t.template.name.startsWith("appointment_reminder"));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.template.quickReplyPayloads).toHaveLength(3);

      const [row] = await intents(id);
      expect(row?.status).toBe("SENT");
      expect(row?.respondBy).not.toBeNull();
    });

    it("is not sent to a patient who has not consented to WhatsApp", async () => {
      await enable({ appointmentRemindersEnabled: true });
      // A patient of their own: consent is append-only, so a withdrawal cannot be undone for the shared one.
      const withdrawn = uuidv7();
      await asClinic((tx) =>
        tx.patient.create({
          data: injected({
            id: withdrawn,
            fullNameAr: "Withdrawn Patient",
            phoneE164: generateFixturePhone("+2011"),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR), withdrawn);
      await asClinic((tx) =>
        tx.consent.create({
          data: injected({
            id: uuidv7(),
            patientId: withdrawn,
            purpose: "WHATSAPP_COMMS",
            granted: false,
            grantedAt: new Date(),
            withdrawnAt: new Date(),
            capturedByUserId: clinic.userId,
            evidence: { channel: "test" },
          }),
        }),
      );

      await runOutboundPass(new Date(start.getTime() - 5 * HOUR + 60_000), deps);

      expect(templates.filter((t) => t.template.name.startsWith("appointment_reminder"))).toHaveLength(0);
      expect((await intents(id))[0]?.skippedReason).toBe("NO_CONSENT");
    });

    it("cancels the appointment when nobody answers by the deadline, and tells the patient", async () => {
      await enable({ appointmentRemindersEnabled: true });
      await consent();
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR));
      const sendAt = new Date(start.getTime() - 5 * HOUR + 60_000);

      await runOutboundPass(sendAt, deps);
      const [reminder] = await intents(id);
      expect(reminder?.respondBy).not.toBeNull();

      // Silence until after the deadline.
      const afterDeadline = new Date((reminder?.respondBy as Date).getTime() + 60_000);
      const pass = await runOutboundPass(afterDeadline, deps);

      expect(pass.autoCancelled).toBe(1);
      expect(await statusOf(id)).toBe("CANCELLED");
      expect(templates.some((t) => t.template.name === "appointment_auto_cancelled")).toBe(true);
    });

    it("does not cancel an appointment reception confirmed in the meantime", async () => {
      await enable({ appointmentRemindersEnabled: true });
      await consent();
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR));
      await runOutboundPass(new Date(start.getTime() - 5 * HOUR + 60_000), deps);
      const [reminder] = await intents(id);

      await asClinic((tx) => tx.appointment.update({ where: { id }, data: { status: "CONFIRMED" } }));
      await runOutboundPass(new Date((reminder?.respondBy as Date).getTime() + 60_000), deps);

      expect(await statusOf(id)).toBe("CONFIRMED");
    });

    it("confirms when the patient taps Confirm, and refuses the same tap from another number", async () => {
      await enable({ appointmentRemindersEnabled: true });
      await consent();
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR));
      await runOutboundPass(new Date(start.getTime() - 5 * HOUR + 60_000), deps);
      const [reminder] = await intents(id);
      const tenant = await resolveTenantByPhoneNumberId(phoneNumberId);
      expect(tenant).not.toBeNull();
      const [confirm] = reminderPayloads(reminder?.id as string);
      const phone = await patientPhone();

      const fakeReply = async (_id: string, to: string, body: string) => {
        texts.push({ to, body });
        return { externalMessageId: `wamid.${randomUUID()}` };
      };
      const tap = (waId: string, phoneE164: string) =>
        handleReminderTap(
          {
            tenant: tenant!,
            waId,
            phoneE164,
            externalMessageId: `wamid.${randomUUID()}`,
            payload: confirm,
            title: "تأكيد الحضور",
            occurredAt: new Date(),
          },
          new Date(),
          fakeReply,
        );

      const stranger = await tap("201099999999", "+201099999999");
      expect(stranger).toBe("REJECTED");
      expect(await statusOf(id)).toBe("BOOKED");

      const real = await tap(phone.replace(/\D/g, ""), phone);
      expect(real).toBe("CONFIRMED");
      expect(await statusOf(id)).toBe("CONFIRMED");

      // The deadline passing afterwards finds it answered and does nothing.
      const pass = await runOutboundPass(new Date((reminder?.respondBy as Date).getTime() + 60_000), deps);
      expect(pass.autoCancelled).toBe(0);
    });

    it("gives up loudly when Meta says the template does not exist, and tells the desk", async () => {
      await enable({ appointmentRemindersEnabled: true });
      await consent();
      const start = slot();
      const id = await book(start, "BOOKED", new Date(Date.now() - 7 * 24 * HOUR));
      const { WhatsAppSendError } = await import("../../src/modules/whatsapp/whatsapp-graph-client.ts");
      failNext = new WhatsAppSendError(400, 132001, "template does not exist");

      const pass = await runOutboundPass(new Date(start.getTime() - 5 * HOUR + 60_000), deps);

      expect(pass.failed).toBe(1);
      expect((await intents(id))[0]?.status).toBe("FAILED");
      const notices = await asClinic((tx) =>
        tx.notification.findMany({ where: { kind: "WHATSAPP_MESSAGE_FAILED", appointmentId: id } }),
      );
      expect(notices).toHaveLength(1);
    });
  });

  describe("the messages the database enqueues", () => {
    const moveTo = async (id: string, from: string, to: string): Promise<void> => {
      await asClinic(async (tx) => {
        await tx.appointment.update({ where: { id }, data: { status: to as never } });
        await tx.appointmentEvent.create({
          data: injected({
            id: uuidv7(),
            appointmentId: id,
            eventType: "STATUS_CHANGED",
            fromStatus: from as never,
            toStatus: to as never,
            actorUserId: clinic.userId,
          }),
        });
      });
    };

    it("tells the patient which room when the doctor starts, only if the clinic switched it on", async () => {
      await consent();
      await asClinic((tx) => tx.doctor.update({ where: { id: clinic.doctorId }, data: { roomNumber: "2" } }));

      const off = await book(slot(), "CONFIRMED");
      await moveTo(off, "CONFIRMED", "WAITING");
      await moveTo(off, "WAITING", "IN_CONSULTATION");
      expect(await intents(off)).toHaveLength(0);

      await enable({ callInMessageEnabled: true });
      const on = await book(slot(), "CONFIRMED");
      await moveTo(on, "CONFIRMED", "WAITING");
      await moveTo(on, "WAITING", "IN_CONSULTATION");
      const [row] = await intents(on);
      expect(row?.kind).toBe("CALL_IN");

      await enable({ appointmentRemindersEnabled: true });
      await runOutboundPass(new Date(), deps);

      const callIn = templates.find((t) => t.template.name === "patient_call_in") ?? null;
      const text = texts.find((t) => t.body.includes("غرفة 2")) ?? null;
      expect(callIn !== null || text !== null).toBe(true);
    });

    it("does not call a patient in when the visit was completed in the same transaction", async () => {
      await enable({ callInMessageEnabled: true, appointmentRemindersEnabled: true });
      await consent();
      const id = await book(slot(), "CONFIRMED");
      await moveTo(id, "CONFIRMED", "WAITING");
      await moveTo(id, "WAITING", "IN_CONSULTATION");
      await moveTo(id, "IN_CONSULTATION", "COMPLETED");

      await runOutboundPass(new Date(), deps);

      expect((await intents(id)).find((row) => row.kind === "CALL_IN")?.skippedReason).toBe("NOT_IN_CONSULTATION");
    });

    it("sends a documents link, resolvable, and a retry revokes the previous one", async () => {
      await enable({ visitDocumentsLinkEnabled: true, appointmentRemindersEnabled: true });
      await consent();
      const id = await book(new Date(Date.now() - (3 + 2 * slotCount++) * HOUR), "CONFIRMED");
      await asClinic((tx) =>
        tx.visit.create({
          data: injected({
            id: uuidv7(),
            appointmentId: id,
            patientId: clinic.patientId,
            doctorId: clinic.doctorId,
            status: "COMPLETED",
            completedAt: new Date(),
            createdBy: clinic.userId,
          }),
        }),
      );
      await moveTo(id, "CONFIRMED", "COMPLETED");

      const { WhatsAppSendError } = await import("../../src/modules/whatsapp/whatsapp-graph-client.ts");
      failNext = new WhatsAppSendError(500, 1, "temporary");
      const first = await runOutboundPass(new Date(), deps);
      expect(first.retrying).toBe(1);

      const second = await runOutboundPass(new Date(Date.now() + 2 * 60_000), deps);
      expect(second.sent).toBe(1);

      const sent = templates.find((t) => t.template.name === "visit_documents_v2");
      const token = sent?.template.urlButtonSuffix as string;
      expect(token).toHaveLength(43);

      const resolved = await resolveDocumentToken(token, new Date());
      expect(resolved?.tenantId).toBe(clinic.tenantId);
      expect(await resolveDocumentToken("x".repeat(43), new Date())).toBeNull();

      const links = await asClinic((tx) => tx.visitDocumentLink.findMany({ where: { visitId: resolved?.visitId } }));
      // The failed first attempt issued nothing before failing at send time? It did: one link per attempt,
      // and only the last is live.
      expect(links.filter((link) => link.revokedAt === null)).toHaveLength(1);

      // What the link opens: the paper the patient would have been handed, and no clinical extras.
      const documents = await loadVisitDocuments(clinic.tenantId, resolved!.visitId, {} as StorageProvider);
      expect(documents?.patient.fileNumber).toBeGreaterThan(0);
      const everything = JSON.stringify(documents);
      for (const privateField of ["doctorNotes", "medicalHistory", "examination", "revision", "vitals"]) {
        expect(everything).not.toContain(privateField);
      }
      // A link to a visit that is not completed shows nothing.
      expect(await loadVisitDocuments(clinic.tenantId, uuidv7(), {} as StorageProvider)).toBeNull();
    });
  });
});
