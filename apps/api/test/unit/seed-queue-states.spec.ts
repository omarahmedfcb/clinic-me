import { CLINICS, type ClinicBlueprint } from "../../prisma/seed/blueprint.ts";
import { generateAppointments, generatePatients, type GeneratedAppointment } from "../../prisma/seed/generate.ts";
import { Prng } from "../../prisma/seed/prng.ts";
import type { SeededStaff } from "../../prisma/seed/seed-staff.ts";

/**
 * **The seed must produce a queue somebody can actually look at.**
 *
 * `PHASE-3.md`'s Definition of Done asks for a reviewable queue and records the box as *"checked
 * and actively false"*: the generator's status rule was
 * `scheduledEnd < referenceDate ? terminal : upcoming` — binary, past or future, with nothing
 * representing the reference moment itself. So `ARRIVED`, `WAITING` and `IN_CONSULTATION` were
 * never written by any seed, in any tenant, ever.
 *
 * The cost was not a missing row. It was that every queue-shaped screen reviewed for three weeks
 * showed a board where nobody had arrived: no waiting time, no consultation in progress, an empty
 * no-show candidate list, and three status colours that could not be reached. The founder kept
 * being shown empty states and reasonably read them as the screen's fault.
 *
 * These tests are the guard. The vacuity trap is real and specific here — a generator that emitted
 * nothing at all, or ignored the reference date, would satisfy "no forbidden status appears", so
 * every negative assertion below is paired with a positive one.
 */

const FIRST = CLINICS[0];
if (FIRST === undefined) throw new Error("blueprint.ts defines no clinics");
// Narrowed into its own const: the module-level guard above does not narrow inside a closure,
// and strict mode is right to say so.
const CLINIC: ClinicBlueprint = FIRST;

/** The same fixture `seed-determinism.spec.ts` uses, so both specs exercise one shape of staff. */
function fakeStaff(clinic: ClinicBlueprint): SeededStaff {
  const doctorKeys = clinic.staff.filter((member) => member.doctor !== undefined).map((member) => member.key);
  return {
    tenantId: "00000000-0000-7000-8000-000000000000",
    userIdByKey: new Map(clinic.staff.map((member, index) => [member.key, `user-${index}`])),
    doctorIdByKey: new Map(doctorKeys.map((key, index) => [key, `doctor-${index}`])),
    doctorKeys,
    serviceIds: clinic.services.map((_service, index) => `service-${index}`),
    serviceDurations: clinic.services.map((service) => service.durationMinutes),
    servicePrices: clinic.services.map((service) => service.priceMinor),
    receptionUserId: "user-reception",
  };
}

function generateAt(referenceDate: Date): GeneratedAppointment[] {
  const rng = new Prng(CLINIC.randomSeed);
  const patients = generatePatients(CLINIC, rng, 60_000_000);
  return generateAppointments(CLINIC, fakeStaff(CLINIC), rng, patients, referenceDate);
}

// 11:00 Cairo, solidly inside the morning shift (09:00-14:00 local). A reference in the gap
// between shifts has no appointment to straddle, so IN_CONSULTATION would legitimately be absent
// and this file would be testing the fixture rather than the generator.
const REFERENCE = new Date("2026-08-25T08:00:00.000Z");
const day = (value: Date): string => value.toISOString().slice(0, 10);

describe("the seeded queue is reviewable", () => {
  const appointments = generateAt(REFERENCE);
  const onReferenceDay = appointments.filter((a) => day(a.scheduledStart) === day(REFERENCE));

  test("the reference day is populated at all — otherwise everything below is vacuous", () => {
    expect(onReferenceDay.length).toBeGreaterThan(5);
  });

  test("all three mid-visit statuses appear on the reference day", () => {
    // The three that had never been written by any seed, and the whole point of this file.
    const present = new Set(onReferenceDay.map((a) => a.status));
    for (const status of ["ARRIVED", "WAITING", "IN_CONSULTATION"] as const) {
      expect({ status, present: present.has(status) }).toEqual({ status, present: true });
    }
  });

  test("a past-grace no-show candidate exists — somebody arrived and was never called", () => {
    // pendingNoShows() selects on-queue rows whose readiness instant is past grace. Without a
    // WAITING row that finished before the reference instant, that list is always empty and the
    // no-show flow cannot be reviewed at all.
    const overdue = onReferenceDay.filter(
      (a) => a.status === "WAITING" && a.scheduledEnd < REFERENCE,
    );
    expect(overdue.length).toBeGreaterThan(0);
  });

  test("IN_CONSULTATION is only ever an appointment whose window contains the reference instant", () => {
    // Otherwise the board could show two people in one room, or somebody being seen at 4pm at
    // half past eleven.
    for (const a of appointments.filter((x) => x.status === "IN_CONSULTATION")) {
      expect({
        start: a.scheduledStart <= REFERENCE,
        end: a.scheduledEnd > REFERENCE,
      }).toEqual({ start: true, end: true });
    }
  });

  test("nobody has arrived in the future", () => {
    // `waitedMs` is `now - arrivedAt`; an arrival after the reference renders a negative wait,
    // which reads as a broken screen rather than as broken data.
    const future = appointments.filter((a) => a.arrivedAt !== null && a.arrivedAt > REFERENCE);
    expect(future.map((a) => a.arrivedAt?.toISOString())).toEqual([]);
  });

  test("every mid-visit status carries the timestamps its screen reads", () => {
    for (const a of onReferenceDay) {
      if (a.status === "ARRIVED") expect(a.arrivedAt).not.toBeNull();
      if (a.status === "WAITING") {
        expect(a.arrivedAt).not.toBeNull();
        expect(a.waitingStartedAt).not.toBeNull();
      }
      if (a.status === "IN_CONSULTATION") {
        expect(a.arrivedAt).not.toBeNull();
        expect(a.consultationStartedAt).not.toBeNull();
        // Still in the room: it has not ended.
        expect(a.consultationEndedAt).toBeNull();
      }
    }
  });

  test("days that are not the reference day keep the original two-band behaviour", () => {
    // A week ago is history and next week is upcoming. A live queue on either would be nonsense,
    // and it is the obvious way an over-eager fix to this would go wrong.
    const elsewhere = appointments.filter((a) => day(a.scheduledStart) !== day(REFERENCE));
    const live = elsewhere.filter((a) =>
      (["ARRIVED", "WAITING", "IN_CONSULTATION"] as const).includes(
        a.status as "ARRIVED" | "WAITING" | "IN_CONSULTATION",
      ),
    );
    expect(live).toEqual([]);
    // Non-vacuity: there really are appointments on other days.
    expect(elsewhere.length).toBeGreaterThan(50);
  });

  test("the reference date still decides everything — a different date moves the live day", () => {
    const later = new Date("2026-08-27T08:00:00.000Z");
    const shifted = generateAt(later).filter((a) => a.status === "IN_CONSULTATION");
    expect(shifted.length).toBeGreaterThan(0);
    for (const a of shifted) expect(day(a.scheduledStart)).toBe(day(later));
  });

  test("still deterministic: the same reference produces the same statuses", () => {
    // The whole reason SEED_REFERENCE_DATE exists. A live queue must not cost reproducibility.
    const first = generateAt(REFERENCE).map((a) => `${day(a.scheduledStart)}|${a.status}`);
    const second = generateAt(REFERENCE).map((a) => `${day(a.scheduledStart)}|${a.status}`);
    expect(first).toEqual(second);
  });
});
