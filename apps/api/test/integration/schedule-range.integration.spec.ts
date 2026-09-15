import {
  describeDoctorDay,
  describeDoctorWeek,
  MAX_RANGE_DAYS,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The weekly grid's endpoint, and the one property it must never lose.
 *
 * `describeDoctorWeek` exists so the grid costs one request and one snapshot instead of seven. The
 * risk in any such optimisation is that it quietly becomes a *second* implementation of
 * availability — and then the calendar and the booking flow disagree, with nothing on screen to
 * say which is lying.
 *
 * So the test is not "does the range endpoint return seven things". It is **"does each day it
 * returns equal what the single-day endpoint returns for that date"**, asserted field by field.
 * If someone reimplements the loop, this fails.
 */
describe("schedule range", () => {
  let fixture: ClinicFixture;
  let caller: CallerContext;

  const FROM = "2026-09-01"; // Tuesday
  const TO = "2026-09-07";

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId), role: "RECEPTIONIST", membershipId: fixture.membershipId };

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      // Two working days with different hours, so the range has variety rather than seven
      // identical boxes — seven copies of one answer would pass a comparison that means nothing.
      for (const [weekday, startHour, endHour] of [
        [2, 9, 13],
        [3, 16, 20],
      ] as const) {
        await tx.scheduleTemplate.create({
          data: injected({
            doctorId: fixture.doctorId,
            weekday,
            startTime: new Date(Date.UTC(1970, 0, 1, startHour, 0, 0)),
            endTime: new Date(Date.UTC(1970, 0, 1, endHour, 0, 0)),
            validFrom: new Date(Date.UTC(2026, 0, 1)),
            validTo: null,
          }),
        });
      }

      // A clinic-wide holiday inside the range: it must show up identically both ways.
      await tx.scheduleException.create({
        data: injected({
          doctorId: null,
          date: new Date("2026-09-03T00:00:00Z"),
          type: "HOLIDAY",
          startTime: null,
          endTime: null,
          reason: "seeded",
        }),
      });
    });
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  test("every day in the range equals the single-day answer for that date", async () => {
    const week = await describeDoctorWeek(caller, fixture.doctorId, FROM, TO);
    expect(week.ok).toBe(true);
    if (!week.ok) return;
    expect(week.days).toHaveLength(7);

    for (const day of week.days) {
      const single = await describeDoctorDay(caller, fixture.doctorId, day.date);
      expect(single).not.toBeNull();

      // Compared as JSON so Date instances are compared by value, and so a field added to one
      // path and not the other fails rather than being silently ignored.
      expect(JSON.stringify({ ...day, date: undefined })).toBe(
        JSON.stringify({ ...single, date: undefined }),
      );
    }
  });

  /**
   * Guards the comparison above from passing vacuously. Seven identical empty days would satisfy
   * it while proving nothing, so the fixture is asserted to actually vary.
   */
  test("the range under test is not seven copies of one answer", async () => {
    const week = await describeDoctorWeek(caller, fixture.doctorId, FROM, TO);
    if (!week.ok) throw new Error("range failed");

    const shapes = new Set(week.days.map((d) => `${d.working.length}/${d.free.length}`));
    expect(shapes.size).toBeGreaterThan(1);

    const working = week.days.filter((d) => d.working.length > 0);
    const idle = week.days.filter((d) => d.working.length === 0);
    expect(working.length).toBeGreaterThan(0);
    expect(idle.length).toBeGreaterThan(0);
  });

  test("the clinic-wide holiday closes that day and only that day", async () => {
    const week = await describeDoctorWeek(caller, fixture.doctorId, FROM, TO);
    if (!week.ok) throw new Error("range failed");

    const holiday = week.days.find((d) => d.date === "2026-09-03");
    expect(holiday?.working).toEqual([]);

    // 2026-09-02 is the Wednesday template; the holiday must not have touched it.
    const wednesday = week.days.find((d) => d.date === "2026-09-02");
    expect(wednesday?.working.length).toBeGreaterThan(0);
  });

  describe("range bounds", () => {
    test("a single day is a valid range", async () => {
      const one = await describeDoctorWeek(caller, fixture.doctorId, FROM, FROM);
      expect(one.ok).toBe(true);
      if (one.ok) expect(one.days).toHaveLength(1);
    });

    test("accepts exactly the maximum", async () => {
      const last = new Date(Date.parse(`${FROM}T00:00:00Z`) + (MAX_RANGE_DAYS - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const result = await describeDoctorWeek(caller, fixture.doctorId, FROM, last);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.days).toHaveLength(MAX_RANGE_DAYS);
    });

    test("refuses one day beyond it", async () => {
      const past = new Date(Date.parse(`${FROM}T00:00:00Z`) + MAX_RANGE_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(await describeDoctorWeek(caller, fixture.doctorId, FROM, past)).toMatchObject({
        ok: false,
        code: "RANGE_TOO_LONG",
      });
    });

    test("refuses a backwards range", async () => {
      expect(await describeDoctorWeek(caller, fixture.doctorId, TO, FROM)).toMatchObject({
        ok: false,
        code: "RANGE_TOO_LONG",
      });
    });
  });

  test("an unknown doctor is not found, not an empty week", async () => {
    expect(
      await describeDoctorWeek(caller, "00000000-0000-7000-8000-00000000dead", FROM, TO),
    ).toMatchObject({ ok: false, code: "NOT_FOUND", params: { resource: "doctor" } });
  });
});
