import { generateSlots } from "../../src/modules/appointments/domain/generate-slots.ts";
import type {
  GenerateSlotsInput,
  ScheduleExceptionRow,
  ScheduleTemplateRow,
} from "../../src/modules/appointments/domain/types.ts";

const TUESDAY = "2026-09-01";
const UTC = "Etc/UTC";

const template = (id: string, branchId: string, startTime: string, endTime: string): ScheduleTemplateRow => ({
  id,
  doctorId: "d1",
  weekday: 2,
  startTime,
  endTime,
  validFrom: "2026-01-01",
  validTo: null,
  branchId,
});

const exception = (over: Partial<ScheduleExceptionRow>): ScheduleExceptionRow => ({
  id: "e",
  doctorId: null,
  date: TUESDAY,
  type: "BLOCKED",
  startTime: null,
  endTime: null,
  branchId: null,
  ...over,
});

const MORNING_IN_A = template("t-a", "A", "09:00", "10:00");
const EVENING_IN_B = template("t-b", "B", "17:00", "18:00");

function slots(over: Partial<GenerateSlotsInput> = {}): string[] {
  return generateSlots({
    timezone: UTC,
    date: TUESDAY,
    doctorId: "d1",
    templates: [MORNING_IN_A, EVENING_IN_B],
    breaks: [],
    exceptions: [],
    existingAppointments: [],
    service: { durationMinutes: 30, bufferMinutes: 0 },
    granularityMinutes: 30,
    leadMinutes: 0,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  }).map((s) => `${s.branchId} ${s.start.toISOString().slice(11, 16)}`);
}

describe("a slot carries the branch of the template it was cut from", () => {
  test("a doctor working in two branches is offered both, each labelled", () => {
    expect(slots()).toEqual(["A 09:00", "A 09:30", "B 17:00", "B 17:30"]);
  });
});

describe("exceptions follow BRANCHES-DESIGN §4.4", () => {
  test("doctor and branch both null closes the clinic", () => {
    expect(slots({ exceptions: [exception({})] })).toEqual([]);
  });

  test("a branch alone closes that branch, for every doctor", () => {
    expect(slots({ exceptions: [exception({ branchId: "B" })] })).toEqual(["A 09:00", "A 09:30"]);
  });

  test("a doctor alone is away everywhere", () => {
    expect(slots({ exceptions: [exception({ doctorId: "d1" })] })).toEqual([]);
  });

  test("a doctor and a branch is away in that branch only", () => {
    expect(slots({ exceptions: [exception({ doctorId: "d1", branchId: "A" })] })).toEqual(["B 17:00", "B 17:30"]);
  });

  test("extra availability lands in its own branch", () => {
    const extra = exception({ type: "EXTRA_AVAILABILITY", doctorId: "d1", branchId: "B", startTime: "12:00", endTime: "12:30" });
    expect(slots({ exceptions: [extra] })).toContain("B 12:00");
  });

  test("extra availability naming no branch opens nothing: no branch is guessed for it", () => {
    const extra = exception({ type: "EXTRA_AVAILABILITY", doctorId: "d1", startTime: "12:00", endTime: "12:30" });
    expect(slots({ exceptions: [extra] })).toEqual(slots({}));
  });
});

describe("one doctor is in one place at a time", () => {
  test("an appointment in one branch takes that time from every branch", () => {
    const overlapping = template("t-b2", "B", "09:00", "10:00");
    const booked = {
      id: "a1",
      doctorId: "d1",
      scheduledStart: new Date(`${TUESDAY}T09:00:00Z`),
      scheduledEnd: new Date(`${TUESDAY}T09:30:00Z`),
      status: "BOOKED",
      allowOverlap: false,
      serviceBufferMinutes: 0,
    };
    expect(slots({ templates: [MORNING_IN_A, overlapping], existingAppointments: [booked] })).toEqual(["A 09:30", "B 09:30"]);
  });
});
