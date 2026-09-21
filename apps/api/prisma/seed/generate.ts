import { uuidv7 } from "uuidv7";
import type { ClinicBlueprint } from "./blueprint.ts";
import { WORKING_WEEKDAYS } from "./blueprint.ts";
import {
  ADDRESSES,
  BOOKING_NOTES,
  CANCELLATION_REASONS,
  COMPLAINTS,
  FAMILY_NAMES,
  FEMALE_GIVEN_NAMES,
  MALE_GIVEN_NAMES,
} from "./arabic-names.ts";
import type { Prng } from "./prng.ts";
import type { SeededStaff } from "./seed-staff.ts";
import { zonedWallClockToUtc } from "./zoned-time.ts";

/**
 * The pure half of the seed: given a blueprint, a PRNG and a reference date, what patients and
 * appointments exist. No database, no Prisma client, no environment.
 *
 * Split out of seed-clinical.ts on 2026-08-25 for the same reason
 * `modules/appointments/domain/` has zero I/O (CLAUDE.md): these are the functions worth testing
 * directly, and they cannot be tested directly if importing them starts a database client.
 *
 * That was not theoretical. `test/unit/seed-determinism.spec.ts` imported these from
 * seed-clinical.ts, which imports `withTenant` -> `client.ts`, which reads APP_DATABASE_URL at
 * module scope and throws when it is unset. It passed locally, where `apps/api/.env` is loaded by
 * `dotenv/config`, and failed on CI, which has no `.env` -- the exact failure mode PHASE-1.md
 * records three previous instances of. `npm run test:no-dotenv` now reproduces it locally.
 *
 * Nothing here may import from `src/prisma/`. The `SeededStaff` import above is `import type`,
 * which is erased at compile time and creates no runtime dependency; keep it that way.
 */

const APPOINTMENT_HISTORY_DAYS = 90;
const APPOINTMENT_FUTURE_DAYS = 14;
const BOOKING_RATE = 0.55;

/**
 * The share of seeded patients who have an English name recorded at all.
 *
 * Deliberately a minority. Most Egyptian clinics record Arabic only -- an English name turns up
 * when someone copied it off a passport -- so a seed where half the patients had one would let a
 * screen that only renders `full_name_en` look fine in review and then be empty in production.
 * The majority of NULLs is the case worth testing against (SCHEMA-DECISIONS.md D19).
 */
const ENGLISH_NAME_RATE = 0.2;

/**
 * The share of seeded patients who live in a household rather than on their own number.
 *
 * **One phone per family is the Egyptian norm, not an edge case** -- a mother books for a child on
 * her own phone -- and the seed modelled the opposite: every patient their own contact, every
 * relationship SELF. That made the bot's household lookup untestable against review data and made
 * every desk screen show a shape the pilot clinics will not have.
 *
 * A quarter, not all: a clinic has plenty of single adults too, and a seed where every patient sat
 * in a household would hide the other half of each screen.
 */
const HOUSEHOLD_PATIENT_SHARE = 0.25;

/** How many people share one number, when they do. Weighted towards three: a couple and a child. */
const HOUSEHOLD_SIZES = [2, 3, 3, 4];

export type PatientRelationship = "SELF" | "SPOUSE" | "CHILD" | "PARENT";

export interface GeneratedPatient {
  id: string;
  contactId: string;
  fullName: string;
  /** The Latin spelling a human would have entered, or null -- which is the common case. */
  fullNameEn: string | null;
  phoneE164: string;
  gender: string;
  address: string;
  /** `SELF` unless this patient shares somebody else's number. */
  relationshipToContact: PatientRelationship;
}

/**
 * Groups a share of the patients onto one contact each: one number, one family name, mixed
 * relationships.
 *
 * Deterministic like everything else here -- it consumes the same PRNG, which is seeded from the
 * reference date -- so the review build and the sandbox show the same households, and "the mother
 * on +2010…" means one person in a conversation about a bug.
 *
 * The head keeps their own number, contact and family name; the others take all three, because a
 * household that shared a number and not a surname would read as a data-entry error rather than as
 * a family.
 */
interface DraftPatient extends Omit<GeneratedPatient, "fullName" | "fullNameEn"> {
  /** The name as parts, so a household can swap a surname without editing a string. */
  parts: { ar: string; en: string }[];
  hasEnglishName: boolean;
}

function formHouseholds(drafts: DraftPatient[], rng: Prng): void {
  const target = Math.round(drafts.length * HOUSEHOLD_PATIENT_SHARE);
  let grouped = 0;
  let index = 0;

  while (grouped < target && index + 1 < drafts.length) {
    const head = drafts[index];
    if (head === undefined) break;

    const size = Math.min(rng.pick(HOUSEHOLD_SIZES), drafts.length - index, target - grouped + 1);
    if (size < 2) break;

    // The head's family name as a *part*, never as text cut off a rendered name. English family
    // names here contain spaces — "El Sherbiny" — so replacing the last space-separated token
    // produced "El El Sherbiny", and reading the English surname off a head who has none (the
    // common case, ENGLISH_NAME_RATE) left a member's own surname beside somebody else's Arabic
    // one. `seeded-english-names.spec.ts` caught both while this was being written.
    const family = head.parts.at(-1);
    if (family === undefined) break;

    for (let member = 1; member < size; member += 1) {
      const person = drafts[index + member];
      if (person === undefined) break;

      // A spouse first, then children with the occasional elderly parent -- the shapes a
      // receptionist actually meets. At most one spouse: a second would be a different product.
      person.relationshipToContact =
        member === 1 ? "SPOUSE" : rng.chance(0.75) ? "CHILD" : "PARENT";
      person.parts = [...person.parts.slice(0, -1), family];
      person.contactId = head.contactId;
      person.phoneE164 = head.phoneE164;
      person.address = head.address;
    }

    grouped += size;
    index += size;
  }
}

export function generatePatients(clinic: ClinicBlueprint, rng: Prng, phoneBase: number): GeneratedPatient[] {
  const drafts: DraftPatient[] = [];
  for (let index = 0; index < clinic.patientCount; index += 1) {
    const isMale = rng.chance(0.5);
    const given = rng.pick(isMale ? MALE_GIVEN_NAMES : FEMALE_GIVEN_NAMES);
    const fathersName = rng.pick(MALE_GIVEN_NAMES);
    const family = rng.pick(FAMILY_NAMES);
    // A minority of Egyptian records carry only two name parts; including some keeps column
    // widths honest rather than uniformly long.
    const parts = rng.chance(0.8) ? [given, fathersName, family] : [given, family];

    // Built from the same name parts, so the two columns describe one person. A patient whose
    // Arabic name is محمد أحمد الشناوي is Mohamed Ahmed El Shennawy and never someone else.
    const hasEnglishName = rng.chance(ENGLISH_NAME_RATE);

    drafts.push({
      id: uuidv7(),
      contactId: uuidv7(),
      parts,
      hasEnglishName,
      phoneE164: `+2010${String(phoneBase + index).padStart(8, "0")}`,
      gender: isMale ? "MALE" : "FEMALE",
      address: rng.pick(ADDRESSES),
      relationshipToContact: "SELF",
    });
  }

  formHouseholds(drafts, rng);

  // Rendered once, after the households are settled, so both columns always come from one set of
  // parts — which is the whole of D19's "the two columns describe one person".
  return drafts.map(({ parts, hasEnglishName, ...patient }) => ({
    ...patient,
    fullName: parts.map((part) => part.ar).join(" "),
    fullNameEn: hasEnglishName ? parts.map((part) => part.en).join(" ") : null,
  }));
}

export interface GeneratedAppointment {
  id: string;
  patientId: string;
  doctorId: string;
  serviceId: string;
  servicePriceMinor: number;
  scheduledStart: Date;
  scheduledEnd: Date;
  status:
    | "BOOKED"
    | "CONFIRMED"
    | "ARRIVED"
    | "WAITING"
    | "IN_CONSULTATION"
    | "COMPLETED"
    | "CANCELLED"
    | "NO_SHOW";
  source: "WHATSAPP" | "RECEPTION" | "WALK_IN" | "ONLINE";
  complaintSummary: string;
  bookingNotes: string | null;
  cancellationReason: string | null;
  /**
   * The queue timestamps, decided **here** rather than by the writer.
   *
   * They used to be derived in `seed-clinical.ts` from the status alone, with `COMPLETED` the only
   * case that got any — which is precisely why no mid-visit state could exist: a status the writer
   * had no rule for would have been written with three nulls, and `waitedMs` on the queue board is
   * computed from `arrivedAt`. Deriving them where the reference instant is known keeps the
   * arithmetic in one place and lets the writer stay a writer.
   */
  arrivedAt: Date | null;
  waitingStartedAt: Date | null;
  consultationStartedAt: Date | null;
  consultationEndedAt: Date | null;
}

/**
 * Guarantees at least one patient who arrived, was never called, and is now past grace.
 *
 * **A weighted roll is not good enough for this one.** `PHASE-3.md`'s Definition of Done asks for a
 * seeded queue "including a walk-in and a past-grace no-show candidate", and only one doctor works
 * mornings in the first clinic — so the band of appointments that finished before the reference
 * instant is a handful of slots, and a 14% weight lands on zero often enough that the no-show list
 * would be reviewable on some seeds and empty on others. A fixture that is *usually* there is worse
 * than one that is never there, because the first time it is missing everyone assumes the screen.
 *
 * Deterministic: it promotes the **earliest** qualifying appointment, chosen by time rather than by
 * the PRNG, so the same reference date always produces the same candidate and the PRNG stream is
 * untouched. Idempotent too — if the weighted roll already produced one, this does nothing.
 */
function ensureOverdueArrival(appointments: GeneratedAppointment[], referenceDate: Date): void {
  const today = appointments.filter(
    (a) => sameDayAs(a.scheduledStart, referenceDate) && a.scheduledEnd < referenceDate,
  );
  if (today.some((a) => a.status === "WAITING")) return;

  const candidate = today
    .filter((a) => a.status === "COMPLETED")
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())[0];
  if (candidate === undefined) return;

  candidate.status = "WAITING";
  Object.assign(candidate, queueStampsFor("WAITING", candidate.scheduledStart, candidate.scheduledEnd, referenceDate));
}

/** Same clinic-local calendar day. Compared in UTC, which is what the generator already builds in. */
function sameDayAs(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * Which status an appointment has, given where it sits relative to the reference instant.
 *
 * ## Why this exists, and what was actually wrong
 *
 * The rule used to be one line: `scheduledEnd < referenceDate ? terminal : upcoming`. **Binary —
 * past or future, with nothing representing the reference moment itself.** So `ARRIVED`, `WAITING`
 * and `IN_CONSULTATION` were never written by any seed, in any tenant, ever. `PHASE-3.md` records
 * that as "checked and actively false" against the Definition of Done, and it is why every
 * queue-shaped screen reviewed so far has shown a board of patients who have all not arrived yet:
 * no waiting time, no consultation in progress, no no-show candidate, and three status colours that
 * are unreachable.
 *
 * A day around the reference instant now has three bands rather than two:
 *
 * - **finished before it** — terminal, as before, plus a slice of `WAITING` for the patient who
 *   arrived, was never called, and is now past grace. That slice is the entire content of the
 *   no-show candidate list, which is otherwise always empty;
 * - **straddling it** — `IN_CONSULTATION`. Exactly the appointments whose window contains the
 *   reference moment, so there is at most one per doctor and the queue never shows two people in
 *   one room;
 * - **later that day** — mostly upcoming, with some `ARRIVED`/`WAITING`, because patients arrive
 *   early and a waiting room with nobody in it is not a waiting room.
 *
 * Days that are not the reference day keep the original two-band behaviour exactly: a week ago is
 * history and next week is upcoming, and neither should contain a live queue.
 *
 * **Every decision is a function of `referenceDate` and the seeded PRNG.** Nothing reads the clock,
 * which is the rule `CLAUDE.md` states and the reason `SEED_REFERENCE_DATE` exists at all — so
 * seeding twice with the same reference still produces byte-identical data, and seeding with today's
 * date produces a live board for today.
 */
function queueStatusFor(
  scheduledStart: Date,
  scheduledEnd: Date,
  referenceDate: Date,
  rng: { weighted: <T extends string>(pairs: readonly (readonly [T, number])[]) => T },
): GeneratedAppointment["status"] {
  const onReferenceDay = sameDayAs(scheduledStart, referenceDate);

  if (scheduledEnd < referenceDate) {
    // Earlier today, a few are still sitting in the waiting room and are now overdue.
    return onReferenceDay
      ? rng.weighted([["COMPLETED", 68], ["WAITING", 14], ["CANCELLED", 10], ["NO_SHOW", 8]] as const)
      : rng.weighted([["COMPLETED", 72], ["CANCELLED", 16], ["NO_SHOW", 12]] as const);
  }

  if (onReferenceDay && scheduledStart <= referenceDate) return "IN_CONSULTATION";

  return onReferenceDay
    ? rng.weighted([["CONFIRMED", 38], ["BOOKED", 27], ["ARRIVED", 20], ["WAITING", 15]] as const)
    : rng.weighted([["BOOKED", 60], ["CONFIRMED", 40]] as const);
}

/**
 * The queue timestamps for a status, never in the future relative to the reference instant.
 *
 * A patient cannot have arrived at a time that has not happened yet — the board computes "waiting
 * 12 minutes" as `now - arrivedAt`, and an `arrivedAt` after the reference would render a negative
 * wait, which looks like a bug in the screen rather than in the data.
 */
function queueStampsFor(
  status: GeneratedAppointment["status"],
  scheduledStart: Date,
  scheduledEnd: Date,
  referenceDate: Date,
): Pick<
  GeneratedAppointment,
  "arrivedAt" | "waitingStartedAt" | "consultationStartedAt" | "consultationEndedAt"
> {
  const none = {
    arrivedAt: null,
    waitingStartedAt: null,
    consultationStartedAt: null,
    consultationEndedAt: null,
  };

  // Ten minutes early is the ordinary case, and never later than the reference instant.
  const arrived = new Date(
    Math.min(scheduledStart.getTime() - 10 * 60_000, referenceDate.getTime()),
  );

  switch (status) {
    case "ARRIVED":
      return { ...none, arrivedAt: arrived };
    case "WAITING":
      return { ...none, arrivedAt: arrived, waitingStartedAt: arrived };
    case "IN_CONSULTATION":
      return {
        ...none,
        arrivedAt: arrived,
        waitingStartedAt: arrived,
        consultationStartedAt: scheduledStart,
      };
    case "COMPLETED":
      return {
        arrivedAt: arrived,
        waitingStartedAt: arrived,
        consultationStartedAt: scheduledStart,
        consultationEndedAt: scheduledEnd,
      };
    default:
      // BOOKED, CONFIRMED, CANCELLED, NO_SHOW -- nobody ever arrived.
      return none;
  }
}

/**
 * Walks the calendar day by day, doctor by doctor, filling each working shift with back-to-back
 * candidate slots and booking some of them.
 *
 * Slots advance by the chosen service's own duration and skip the doctor's break, so two
 * appointments for the same doctor can never overlap. That is not a stylistic choice: `appointments`
 * carries an exclusion constraint (`no_double_booking`, on tenant + doctor + time range) which
 * rejects an overlapping pair outright. Generating times randomly and hoping would fail the seed
 * partway through, unpredictably.
 */
export function generateAppointments(
  clinic: ClinicBlueprint,
  staff: SeededStaff,
  rng: Prng,
  patients: readonly GeneratedPatient[],
  referenceDate: Date,
): GeneratedAppointment[] {
  const appointments: GeneratedAppointment[] = [];
  const firstDay = new Date(referenceDate.getTime() - APPOINTMENT_HISTORY_DAYS * 86_400_000);
  const lastDay = new Date(referenceDate.getTime() + APPOINTMENT_FUTURE_DAYS * 86_400_000);

  for (const doctorKey of staff.doctorKeys) {
    const doctorId = staff.doctorIdByKey.get(doctorKey);
    const member = clinic.staff.find((candidate) => candidate.key === doctorKey);
    if (doctorId === undefined || member?.doctor === undefined) continue;
    const { shift, break: lunch } = member.doctor;

    for (let day = new Date(firstDay); day <= lastDay; day = new Date(day.getTime() + 86_400_000)) {
      const weekday = day.getUTCDay();
      if (!WORKING_WEEKDAYS.includes(weekday as (typeof WORKING_WEEKDAYS)[number])) continue;

      const year = day.getUTCFullYear();
      const month = day.getUTCMonth() + 1;
      const date = day.getUTCDate();

      let minutes = shift.startHour * 60 + shift.startMinute;
      const shiftEnd = shift.endHour * 60 + shift.endMinute;
      const breakStart = lunch.startHour * 60 + lunch.startMinute;
      const breakEnd = lunch.endHour * 60 + lunch.endMinute;

      while (minutes < shiftEnd) {
        const serviceIndex = rng.int(0, staff.serviceIds.length - 1);
        const duration = staff.serviceDurations[serviceIndex] ?? 30;
        const price = staff.servicePrices[serviceIndex] ?? 0;
        const serviceId = staff.serviceIds[serviceIndex];
        const slotEnd = minutes + duration;

        if (minutes < breakEnd && slotEnd > breakStart) {
          minutes = breakEnd;
          continue;
        }
        if (slotEnd > shiftEnd || serviceId === undefined) break;

        const scheduledStart = zonedWallClockToUtc(
          year, month, date, Math.floor(minutes / 60), minutes % 60, clinic.timezone,
        );
        const scheduledEnd = new Date(scheduledStart.getTime() + duration * 60_000);
        // **A consultation in progress is guaranteed, not rolled for.** The slot containing the
        // reference instant becomes IN_CONSULTATION deterministically, so a review build always has
        // one — a board where nobody is with a doctor is the empty state `seed-queue-states.spec.ts`
        // exists to prevent, and leaving it to `BOOKING_RATE` makes it a property of the dice.
        const straddlesReference = scheduledStart <= referenceDate && scheduledEnd > referenceDate;

        // The draw is taken either way, so the stream — and therefore the whole dataset — stays
        // identical whichever branch wins.
        if (rng.chance(BOOKING_RATE) || straddlesReference) {
          const status = queueStatusFor(scheduledStart, scheduledEnd, referenceDate, rng);
          const stamps = queueStampsFor(status, scheduledStart, scheduledEnd, referenceDate);
          const patient = rng.pick(patients);

          appointments.push({
            id: uuidv7(),
            patientId: patient.id,
            doctorId,
            serviceId,
            servicePriceMinor: price,
            scheduledStart,
            scheduledEnd,
            status,
            source: rng.weighted([["WHATSAPP", 45], ["RECEPTION", 35], ["WALK_IN", 15], ["ONLINE", 5]] as const),
            complaintSummary: rng.pick(COMPLAINTS),
            bookingNotes: rng.chance(0.35) ? rng.pick(BOOKING_NOTES) : null,
            cancellationReason: status === "CANCELLED" ? rng.pick(CANCELLATION_REASONS) : null,
            ...stamps,
          });
        }
        minutes = slotEnd;
      }
    }
  }

  ensureOverdueArrival(appointments, referenceDate);
  return appointments;
}
