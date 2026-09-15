import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLINICS,
  resolveReferenceDate,
  SEED_REFERENCE_DATE,
  type ClinicBlueprint,
} from "../../prisma/seed/blueprint.ts";
import { generateAppointments, generatePatients } from "../../prisma/seed/generate.ts";
import { Prng } from "../../prisma/seed/prng.ts";
import type { SeededStaff } from "../../prisma/seed/seed-staff.ts";

/**
 * The seed has always had a fixed PRNG seed, and `docs/PHASE-1.md` has always called it
 * deterministic. It was not. The generator also read the wall clock, in two places that both feed
 * the data:
 *
 *   - the 104-day window runs from 90 days before "now" to 14 days after, and which calendar days
 *     inside it are working days (Sun-Thu) depends on what weekday the run starts on, so the
 *     number of generated appointments -- and therefore the whole downstream PRNG stream -- moves
 *     with the date;
 *   - an appointment is COMPLETED, CANCELLED or NO_SHOW if it ends before "now", and BOOKED or
 *     CONFIRMED otherwise, so the split moves with the clock too.
 *
 * The symptom was a Definition of Done line claiming 731 visits while the seed produced something
 * else, with nobody having touched the seed in between. A seed that cannot reproduce yesterday's
 * data cannot reproduce yesterday's bug, which is the only reason to fix the PRNG at all.
 *
 * These tests are the guard on that. The second one matters as much as the first: without it, a
 * generator that ignored the reference date entirely -- or returned nothing -- would pass the
 * determinism check perfectly.
 *
 * ## What "deterministic" does and does not cover
 *
 * Row **ids are not** deterministic and are excluded below. They are UUIDv7 (D6), which encodes a
 * millisecond timestamp plus randomness, so they differ on every run by design -- and that reaches
 * further than the appointment's own id, because an appointment carries the `patientId` of a
 * patient whose id was generated the same way.
 *
 * So the comparison identifies a patient by **position** in the generated list rather than by id.
 * That still asserts the thing that matters -- the 47th appointment belongs to the 12th patient on
 * every run -- while ignoring the value that is designed never to repeat. Determinism here means
 * the shape of the world: how many appointments, on which days, in which state, for which patient
 * and doctor. Two seeded databases are equivalent, not byte-identical, and reproducing a bug
 * depends on the former.
 */

/**
 * Everything about a generated appointment except the two UUIDv7 values that never repeat: its own
 * id, and the patient id, which is replaced by that patient's position in the generated list.
 */
function shapeOf(world: GeneratedWorld): unknown[] {
  const positionOf = new Map(world.patients.map((patient, index) => [patient.id, index]));
  return world.appointments.map(({ id: _id, patientId, ...rest }) => ({
    ...rest,
    patientIndex: positionOf.get(patientId),
  }));
}

/** Block and line comments removed, so prose about `new Date()` is not mistaken for a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** A SeededStaff standing in for one that has been written to the database. */
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

interface GeneratedWorld {
  patients: ReturnType<typeof generatePatients>;
  appointments: ReturnType<typeof generateAppointments>;
}

function generateFor(clinic: ClinicBlueprint, referenceDate: Date): GeneratedWorld {
  const rng = new Prng(clinic.randomSeed);
  const patients = generatePatients(clinic, rng, 60_000_000);
  return { patients, appointments: generateAppointments(clinic, fakeStaff(clinic), rng, patients, referenceDate) };
}

const CLINIC = CLINICS[0];
if (CLINIC === undefined) throw new Error("blueprint.ts defines no clinics");

describe("seed determinism", () => {
  describe("the reference date is pinned, not read from the clock", () => {
    test("resolveReferenceDate() returns the same instant every call", () => {
      expect(resolveReferenceDate({}).toISOString()).toBe(SEED_REFERENCE_DATE.toISOString());
      expect(resolveReferenceDate({}).toISOString()).toBe(resolveReferenceDate({}).toISOString());
    });

    test("an explicit override is honoured, so a run can always state which date produced it", () => {
      const overridden = resolveReferenceDate({ SEED_REFERENCE_DATE: "2027-01-15T00:00:00.000Z" });
      expect(overridden.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    });

    test("an unparseable override throws instead of falling back to the default", () => {
      // Falling back would produce data that does not match what the caller asked for, and never
      // say so -- the same silent-wrong-default this whole change exists to remove.
      expect(() => resolveReferenceDate({ SEED_REFERENCE_DATE: "last tuesday" })).toThrow("is not a date");
    });

    test("the seed generators never read the clock themselves", () => {
      // A source check rather than a behavioural one, because reintroducing `new Date()` here
      // would not fail any other test -- it would just quietly restore the drift.
      //
      // Comments are stripped first, or this fails on the doc comment in blueprint.ts that
      // explains the rule. It did, on the first run, which is at least evidence the scan works.
      const seedDir = path.resolve(__dirname, "..", "..", "prisma", "seed");
      for (const file of ["generate.ts", "seed-clinical.ts", "seed-staff.ts", "blueprint.ts"]) {
        const source = stripComments(readFileSync(path.join(seedDir, file), "utf8"));
        const offenders = [...source.matchAll(/\bnew Date\(\s*\)|\bDate\.now\(\s*\)/g)].map((m) => m[0]);
        expect({ file, offenders }).toEqual({ file, offenders: [] });
      }
    });

    test("the seed entry point does not build a date from the clock either", () => {
      // index.ts is where `new Date()` actually was, so leaving it out would guard everywhere
      // except the one place it went wrong. `Date.now()` is still allowed here and only here: it
      // times the run for the console output and never reaches the generated data.
      const source = stripComments(
        readFileSync(path.resolve(__dirname, "..", "..", "prisma", "seed", "index.ts"), "utf8"),
      );
      const offenders = [...source.matchAll(/\bnew Date\(\s*\)/g)].map((m) => m[0]);
      expect(offenders).toEqual([]);
    });
  });

  describe("generation is a pure function of the reference date", () => {
    test("two runs at the same reference date produce the same world", () => {
      expect(shapeOf(generateFor(CLINIC, SEED_REFERENCE_DATE))).toEqual(
        shapeOf(generateFor(CLINIC, SEED_REFERENCE_DATE)),
      );
    });

    test("two runs a day apart produce a different world", () => {
      // This is the drift the pin removes, demonstrated rather than asserted. If this ever stops
      // failing to match, the reference date has stopped being load-bearing and the test above
      // has become vacuous.
      const nextDay = new Date(SEED_REFERENCE_DATE.getTime() + 86_400_000);
      expect(shapeOf(generateFor(CLINIC, nextDay))).not.toEqual(shapeOf(generateFor(CLINIC, SEED_REFERENCE_DATE)));
    });

    test("a few hours later on the same day already moves appointments out of the future", () => {
      // The coarser of the two mechanisms is the weekday alignment of the window; this is the
      // finer one, and it is why "run it twice this afternoon" was never a sufficient check.
      const countCompleted = (referenceDate: Date): number =>
        generateFor(CLINIC, referenceDate).appointments.filter((a) => a.status === "COMPLETED").length;

      const morning = countCompleted(SEED_REFERENCE_DATE);
      const evening = countCompleted(new Date(SEED_REFERENCE_DATE.getTime() + 8 * 3_600_000));
      expect(morning).not.toBe(evening);
    });
  });
});
