import { randomUUID } from "node:crypto";
import {
  bookAppointment,
  changeAppointmentStatus,
  findAvailableSlots,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import {
  listNotifications,
  markRead,
  unreadCount,
  type NotificationCaller,
} from "../../src/modules/notifications/notifications.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  deleteTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * Notifications, and the two properties that would be silently wrong if untested.
 *
 * **Read state is per membership.** A person holds memberships in several clinics, so per-user read
 * state would mark a notification read at one clinic by reading it at the other. That is invisible
 * in a single-clinic test, so this file builds a second membership deliberately.
 *
 * **The write is inside the caller's transaction.** A booking that rolls back must not leave a
 * notification claiming it happened — so the count is checked after a failed booking too.
 */
describe("notifications", () => {
  let fixture: ClinicFixture;
  let caller: CallerContext;
  let bell: NotificationCaller;
  /** A second membership in the SAME clinic — reception, who also sees the booking. */
  let receptionMembershipId: string;
  let receptionUserId: string;

  const DATE = "2026-09-01"; // Tuesday
  const NOW = new Date("2026-08-25T06:00:00Z");

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId), role: "RECEPTIONIST", membershipId: fixture.membershipId };

    receptionUserId = await createTestUser();
    const own = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          doctorId: fixture.doctorId,
          weekday: 2,
          startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, 13, 0, 0)),
          validFrom: new Date(Date.UTC(2026, 0, 1)),
          validTo: null,
        }),
      });

      const receptionMembership = randomUUID();
      await tx.membership.create({
        data: injected({
          id: receptionMembership,
          userId: receptionUserId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });

      const doctor = await tx.doctor.findFirstOrThrow({
        where: { id: fixture.doctorId },
        select: { membershipId: true },
      });
      return { doctorMembership: doctor.membershipId, receptionMembership };
    });

    receptionMembershipId = own.receptionMembership;
    bell = {
      tenantId: fixture.tenantId,
      membershipId: own.doctorMembership,
      actor: actorFor(fixture.userId),
    };
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await deleteTestUser(receptionUserId);
    await prisma.$disconnect();
  });

  async function book(): Promise<string> {
    const availability = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error(`availability: ${availability.code}`);

    const result = await bookAppointment(caller, {
      slotToken: availability.slots[0]!.token,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!result.ok) throw new Error(`booking: ${result.code}`);
    return result.appointmentId;
  }

  test("a booking produces exactly one notification", async () => {
    const before = await unreadCount(bell);
    await book();
    expect(await unreadCount(bell)).toBe(before + 1);

    const [latest] = await listNotifications(bell);
    expect(latest?.kind).toBe("APPOINTMENT_BOOKED");
    expect(latest?.read).toBe(false);
  });

  /**
   * The payload is read by reception, so it must carry appointment metadata and nothing clinical.
   * Asserted as a whitelist of keys rather than a check for one forbidden word, so a field added
   * later fails here rather than reaching a screen.
   */
  test("the payload carries only what the list renders", async () => {
    const [latest] = await listNotifications(bell);
    expect(Object.keys(latest?.payload as object).sort()).toEqual(["patientName", "start"]);
  });

  test("cancelling produces a notification carrying the reason §9 requires", async () => {
    const appointmentId = await book();
    await changeAppointmentStatus(caller, appointmentId, "CANCEL", {
      reason: "المريض اعتذر",
      now: NOW,
    });

    const [latest] = await listNotifications(bell);
    expect(latest?.kind).toBe("APPOINTMENT_CANCELLED");
    expect((latest?.payload as { reason: string }).reason).toBe("المريض اعتذر");
  });

  /**
   * The exclusion that keeps the bell usable. Reception is watching the queue board when a patient
   * arrives, so a notification for something already on screen is noise by construction.
   */
  test("queue movement produces no notification", async () => {
    const appointmentId = await book();
    const before = await unreadCount(bell);

    await changeAppointmentStatus(caller, appointmentId, "CONFIRM", { now: NOW });
    await changeAppointmentStatus(caller, appointmentId, "ARRIVE", { now: NOW });

    expect(await unreadCount(bell)).toBe(before);
  });

  describe("read state is per membership, not per user", () => {
    test("marking read for one membership leaves the other's count untouched", async () => {
      await book();
      const reception: NotificationCaller = { ...bell, membershipId: receptionMembershipId };

      const doctorBefore = await unreadCount(bell);
      const receptionBefore = await unreadCount(reception);
      expect(doctorBefore).toBeGreaterThan(0);
      expect(receptionBefore).toBe(doctorBefore);

      const items = await listNotifications(bell);
      await markRead(bell, items.map((item) => item.id));

      expect(await unreadCount(bell)).toBe(0);
      // The whole point: reception has not read anything.
      expect(await unreadCount(reception)).toBe(receptionBefore);
    });

    test("marking the same notification twice is a no-op rather than an error", async () => {
      const items = await listNotifications(bell);
      const ids = items.slice(0, 1).map((item) => item.id);

      await markRead(bell, ids);
      await expect(markRead(bell, ids)).resolves.toBeGreaterThanOrEqual(0);
      expect(await unreadCount(bell)).toBe(0);
    });
  });

  /**
   * The write is inside the caller's transaction, so a booking that fails leaves no trace. A
   * notification written afterwards, or in its own transaction, would claim something happened
   * that did not — and it would do so only on the request that failed, which is the one nobody
   * reproduces.
   */
  test("a failed booking leaves no notification behind", async () => {
    const items = await listNotifications(bell);
    await markRead(bell, items.map((item) => item.id));
    expect(await unreadCount(bell)).toBe(0);

    const result = await bookAppointment(caller, {
      slotToken: "not-a-real-token",
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(await unreadCount(bell)).toBe(0);
  });
});
