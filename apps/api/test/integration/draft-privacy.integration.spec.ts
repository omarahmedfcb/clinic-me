import { randomUUID } from "node:crypto";
import { openDraft, saveDraft } from "../../src/modules/clinical/visit-draft.ts";
import { getClinicalHistory } from "../../src/modules/clinical/clinical.service.ts";
import { getAppointmentVisit } from "../../src/modules/clinical/visit-detail.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * A draft is private to its author — `PHASE-4.md` Q2 and Q15, `PHASE-4-PLAN.md` PR 3.
 *
 * The sentinel is the point. Asserting "the other doctor's read returned nothing" passes just as
 * well against a read that returned nothing because it was broken; asserting that a **distinctive
 * string never appears in their payload** fails only when the text actually leaked.
 */

const SENTINEL = "SENTINEL-DRAFT-PRIVATE-fracture-of-the-left-scaphoid";

describe("draft privacy", () => {
  let clinic: ClinicFixture;
  let author: { tenantId: string; actor: ReturnType<typeof actorFor>; role: "DOCTOR"; membershipId: string };
  let colleague: typeof author;
  let reception: { tenantId: string; actor: ReturnType<typeof actorFor>; role: "RECEPTIONIST"; membershipId: string };

  let appointmentId = "";
  let draftId = "";
  let colleagueDoctorId = "";

  /** A second doctor in the same clinic, with their own membership and doctor row. */
  const addDoctor = async (): Promise<{ userId: string; membershipId: string; doctorId: string }> => {
    const userId = await createTestUser();
    let membershipId = "";
    let doctorId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId, role: "DOCTOR", status: "ACTIVE" }),
      });
      doctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: doctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${doctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });
    return { userId, membershipId, doctorId };
  };

  const appointmentFor = async (doctorId: string, minutesFromNow: number): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() + minutesFromNow * 60_000);
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    author = {
      tenantId: clinic.tenantId,
      actor: actorFor(clinic.userId),
      role: "DOCTOR",
      membershipId: clinic.membershipId,
    };

    const second = await addDoctor();
    colleagueDoctorId = second.doctorId;
    colleague = {
      tenantId: clinic.tenantId,
      actor: actorFor(second.userId),
      role: "DOCTOR",
      membershipId: second.membershipId,
    };

    const deskUser = await createTestUser();
    let deskMembership = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      deskMembership = randomUUID();
      await tx.membership.create({
        data: injected({ id: deskMembership, userId: deskUser, role: "RECEPTIONIST", status: "ACTIVE" }),
      });
    });
    reception = {
      tenantId: clinic.tenantId,
      actor: actorFor(deskUser),
      role: "RECEPTIONIST",
      membershipId: deskMembership,
    };

    // The author writes a draft carrying the sentinel.
    appointmentId = await appointmentFor(clinic.doctorId, 0);
    const opened = await openDraft(author, appointmentId, new Date());
    if (!opened.ok) throw new Error("fixture: the author could not open a draft");
    draftId = opened.value.id;
    const saved = await saveDraft(author, draftId, opened.value.revision, { diagnosis: SENTINEL });
    if (!saved.ok) throw new Error("fixture: the author could not save the draft");
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the fixture is real — the author reads their own sentinel back", async () => {
    // Without this the whole file could pass because the text was never written anywhere.
    const opened = await openDraft(author, appointmentId, new Date());
    expect(opened.ok && opened.value.diagnosis).toBe(SENTINEL);
  });

  test("a colleague with no care relationship is refused outright", async () => {
    // Refused before privacy even arises. Worth separating from the transfer case below, because
    // they fail differently: this one must never reach a draft at all.
    const theirs = await openDraft(colleague, appointmentId, new Date());
    expect(theirs.ok).toBe(false);
    if (theirs.ok) return;
    expect(theirs.refusal.code).toBe("NOT_PRESENT");
  });

  test("accepting a transfer gives the receiving doctor their OWN empty draft", async () => {
    // Q15. The mechanism is `visitScope`: the originating doctor's draft is invisible to them, so
    // their open creates a new row rather than resuming somebody else's unfinished notes.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patientTransfer.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          fromDoctorId: clinic.doctorId,
          toDoctorId: colleagueDoctorId,
          appointmentId,
          status: "ACCEPTED",
          initiatedByMembershipId: clinic.membershipId,
          decidedByMembershipId: colleague.membershipId,
          decidedAt: new Date(),
        }),
      });
    });

    const theirs = await openDraft(colleague, appointmentId, new Date());
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;

    expect(theirs.value.id).not.toBe(draftId);
    expect(theirs.value.diagnosis).toBeNull();
    expect(JSON.stringify(theirs.value)).not.toContain(SENTINEL);
  });

  test("the author's draft is not attached to the colleague's finished record either", async () => {
    const history = await getClinicalHistory(colleague, "DOCTOR", appointmentId);
    expect(JSON.stringify(history)).not.toContain(SENTINEL);

    const visit = await getAppointmentVisit(colleague, "DOCTOR", appointmentId, new Date());
    expect(JSON.stringify(visit)).not.toContain(SENTINEL);
  });

  test("reception cannot reach it through any clinical read", async () => {
    // Reception is refused at the route by the permission matrix; this asserts the layer beneath,
    // so a capability wrongly widened later still cannot surface the text.
    const history = await getClinicalHistory(reception, "RECEPTIONIST", appointmentId);
    expect(JSON.stringify(history)).not.toContain(SENTINEL);

    const visit = await getAppointmentVisit(reception, "RECEPTIONIST", appointmentId, new Date());
    expect(JSON.stringify(visit)).not.toContain(SENTINEL);
  });

  test("a pending transfer changes nothing — the author can still write", async () => {
    // PHASE-3.md Q16: the patient is still in the originating doctor's queue while a request waits.
    const opened = await openDraft(author, appointmentId, new Date());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const saved = await saveDraft(author, draftId, opened.value.revision, {
      doctorNotes: "still writing while a request waits",
    });
    expect(saved.ok).toBe(true);
  });

  test("a draft survives its appointment being cancelled, and its author still sees it", async () => {
    const cancelledAppointment = await appointmentFor(clinic.doctorId, 240);
    const opened = await openDraft(author, cancelledAppointment, new Date());
    if (!opened.ok) throw new Error("fixture: could not open the second draft");
    await saveDraft(author, opened.value.id, opened.value.revision, { diagnosis: "written before the cancellation" });

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.appointment.update({
        where: { id: cancelledAppointment },
        data: { status: "CANCELLED", cancellationReason: "patient left" },
      });
    });

    // The row is still there and still the author's. Medical records are never hard-deleted, and a
    // cancellation is a scheduling fact rather than a reason to lose what a doctor wrote.
    const still = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.visit.findFirst({ where: { id: opened.value.id }, select: { diagnosis: true, createdBy: true } }),
    );
    expect(still?.diagnosis).toBe("written before the cancellation");
    expect(still?.createdBy).toBe(clinic.userId);
  });

  test("abandonment is derived from the instant passed in, with nothing stored", async () => {
    // The test moves only the clock. Nothing is written between these two reads.
    const now = await openDraft(author, appointmentId, new Date());
    expect(now.ok && now.value.abandoned).toBe(false);

    const muchLater = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const later = await openDraft(author, appointmentId, muchLater);
    expect(later.ok && later.value.abandoned).toBe(true);
  });
});
