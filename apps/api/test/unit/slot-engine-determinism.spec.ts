import { generateSlots } from "../../src/modules/appointments/domain/generate-slots.ts";
import type {
  GenerateSlotsInput,
  OccupancyRow,
  ScheduleBreakRow,
  ScheduleExceptionRow,
  ScheduleTemplateRow,
} from "../../src/modules/appointments/domain/types.ts";
import { Prng } from "../../prisma/seed/prng.ts";

/**
 * "Deterministic" is measured here, not asserted.
 *
 * The engine receives arrays straight from Prisma, and Prisma returns rows in whatever order
 * Postgres gives. That order is stable in practice and guaranteed nowhere — it changes with a
 * plan change, an index addition, or a vacuum. So the engine sorts its own inputs (PHASE-2.md
 * Q27), and this proves it by feeding the same world in many different orders.
 *
 * The shuffle uses the project's existing mulberry32 `Prng` with an **explicit seed**, sitting
 * next to an **explicit reference date**. Both are stated for the same reason: CLAUDE.md records
 * that a fixed PRNG seed next to a `new Date()` is what made the seed script look reproducible
 * while producing different data every day. A shuffle from `Math.random()` would make a failure
 * here unreproducible, which is the one thing a determinism test must never be.
 */

const SHUFFLE_SEED = 20260828;
const NOW = new Date("2026-09-01T05:00:00Z");
const DOCTOR = "doctor-1";

/** Fisher-Yates, driven by the seeded generator so a failure can be replayed exactly. */
function shuffled<T>(items: readonly T[], prng: Prng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = prng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A deliberately awkward world: two overlapping templates, a break, a clinic-wide holiday that
 * does not apply to the queried date, extra availability, and three appointments of which one is
 * cancelled and one is an authorised overlap. Enough moving parts that a sort-order dependency
 * anywhere in the pipeline would surface.
 */
const TEMPLATES: ScheduleTemplateRow[] = [
  { id: "t-b", doctorId: DOCTOR, weekday: 2, startTime: "12:00", endTime: "17:00", validFrom: "2025-01-01", validTo: null },
  { id: "t-a", doctorId: DOCTOR, weekday: 2, startTime: "09:00", endTime: "13:00", validFrom: "2025-01-01", validTo: null },
  { id: "t-x", doctorId: "doctor-2", weekday: 2, startTime: "08:00", endTime: "18:00", validFrom: "2025-01-01", validTo: null },
];

const BREAKS: ScheduleBreakRow[] = [
  { id: "b-2", scheduleTemplateId: "t-a", startTime: "11:00", endTime: "11:30" },
  { id: "b-1", scheduleTemplateId: "t-b", startTime: "15:00", endTime: "15:30" },
];

const EXCEPTIONS: ScheduleExceptionRow[] = [
  { id: "e-3", doctorId: null, date: "2026-09-03", type: "HOLIDAY", startTime: null, endTime: null },
  { id: "e-1", doctorId: DOCTOR, date: "2026-09-01", type: "EXTRA_AVAILABILITY", startTime: "17:00", endTime: "18:30" },
  { id: "e-2", doctorId: DOCTOR, date: "2026-09-01", type: "BLOCKED", startTime: "09:30", endTime: "10:00" },
];

const appointment = (
  id: string,
  start: string,
  end: string,
  extra: Partial<OccupancyRow> = {},
): OccupancyRow => ({
  id,
  doctorId: DOCTOR,
  scheduledStart: new Date(start),
  scheduledEnd: new Date(end),
  status: "BOOKED",
  allowOverlap: false,
  serviceBufferMinutes: 0,
  ...extra,
});

const APPOINTMENTS: OccupancyRow[] = [
  appointment("a-3", "2026-09-01T11:30:00Z", "2026-09-01T12:00:00Z", { status: "CANCELLED" }),
  appointment("a-1", "2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { serviceBufferMinutes: 15 }),
  appointment("a-2", "2026-09-01T13:00:00Z", "2026-09-01T13:30:00Z", { allowOverlap: true }),
];

const world = (prng: Prng): GenerateSlotsInput => ({
  timezone: "Africa/Cairo",
  date: "2026-09-01", // a Tuesday: weekday 2 under JS getDay()
  doctorId: DOCTOR,
  templates: shuffled(TEMPLATES, prng),
  breaks: shuffled(BREAKS, prng),
  exceptions: shuffled(EXCEPTIONS, prng),
  existingAppointments: shuffled(APPOINTMENTS, prng),
  service: { durationMinutes: 30, bufferMinutes: 0 },
  granularityMinutes: 30,
  leadMinutes: 0,
  now: NOW,
});

describe("slot engine is deterministic under input reordering", () => {
  const signature = (input: GenerateSlotsInput): string =>
    generateSlots(input)
      .map((s) => `${s.start.toISOString()}/${s.end.toISOString()}/${s.utcOffsetMinutes}`)
      .join(" ");

  it("produces identical output for 200 shuffles of the same world", () => {
    const prng = new Prng(SHUFFLE_SEED);
    const first = signature(world(prng));

    // A signature of nothing would make every comparison below trivially true.
    expect(first.length).toBeGreaterThan(0);

    const distinct = new Set<string>([first]);
    for (let run = 0; run < 200; run += 1) distinct.add(signature(world(prng)));

    expect([...distinct]).toEqual([first]);
  });

  /**
   * The shuffle has to actually shuffle. Without this, a `shuffled()` that returned its input
   * unchanged would make the test above pass while proving nothing at all — the same class of
   * silent no-op the purity scan's "is actually scanning the engine" assertion guards against.
   */
  it("uses a shuffle that genuinely reorders", () => {
    const prng = new Prng(SHUFFLE_SEED);
    const orders = new Set<string>();
    for (let run = 0; run < 50; run += 1) {
      orders.add(shuffled(TEMPLATES, prng).map((t) => t.id).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  /** Same seed, same shuffles — so a failure above is replayable rather than a one-off. */
  it("is itself reproducible from the seed", () => {
    const a = shuffled(APPOINTMENTS, new Prng(SHUFFLE_SEED)).map((x) => x.id);
    const b = shuffled(APPOINTMENTS, new Prng(SHUFFLE_SEED)).map((x) => x.id);
    expect(a).toEqual(b);
  });
});
