import type { LocaleCode, MembershipRole, ServiceType } from "../../src/generated/prisma/client.ts";

/**
 * The static shape of the seeded world: two clinics, their staff, their services and their
 * working weeks. Everything here is written by hand; the volume data (patients, appointments,
 * visits, payments) is generated from it in seed-clinic.ts.
 *
 * Two tenants is the point, not a round number. Tenant isolation is the rule the whole system is
 * built around, and with a single clinic in the database a broken `tenantId` filter looks
 * identical to a working one -- every query returns the right rows because there are no wrong
 * rows to return. The founder's Definition of Done requires checking cross-tenant access by hand,
 * and that is only possible with a second clinic holding data he can try to reach and must not.
 */

/**
 * The password every seeded human account shares.
 *
 * The value names itself so that neither a human reviewer nor a secret scanner has to work out
 * whether this is a real credential that leaked into Git -- the same convention as
 * `ci-only-password-not-a-secret` in .github/workflows/ci.yml. It only ever unlocks fake patients
 * in a local development database, and it is printed to the console on every seed run.
 */
export const SEED_PASSWORD = "dev-only-not-a-real-password";

/**
 * The instant the seeded world is generated *around*: appointments run from 90 days before it to
 * 14 days after, and anything ending before it is treated as already happened.
 *
 * It is a fixed constant rather than `new Date()`, and that is the difference between a seed that
 * is deterministic and one that merely looks it. The PRNG seed was already fixed, but the
 * generator also reads the clock: which calendar days in the window are working days depends on
 * what weekday the run starts on, and whether an appointment is past depends on the moment it is
 * compared against. Two runs on different days produced different data from the same PRNG seed --
 * which is what a seed exists to prevent. `docs/PHASE-1.md` recorded 731 visits for months while
 * the seed was actually producing something else, and nobody had changed a line of it.
 *
 * ## This value is a decision, and it ages
 *
 * Because it is fixed, the "two upcoming weeks" of appointments stop being upcoming once real time
 * passes it -- from mid-September 2026, a freshly seeded database has no future appointments at
 * all, and the queue and today screens will look empty. That is a genuine cost, accepted because
 * the alternative is data that cannot be reproduced.
 *
 * **Bump it deliberately when the seeded data needs to look current again**, and re-measure the
 * counts in `docs/PHASE-1.md` in the same commit -- they will change. Do not reach for
 * `new Date()`; `test/unit/seed-determinism.spec.ts` fails if the seed reads the clock again.
 *
 * For a one-off run against a different window, set `SEED_REFERENCE_DATE` in the environment to an
 * ISO date. That is still an explicit, stateable value -- every run can say which date produced
 * its data, which is the property that matters.
 */
export const SEED_REFERENCE_DATE = new Date("2026-08-25T09:00:00.000Z");

/**
 * The reference date this run will use: the constant above, or an ISO date from the environment.
 * Rejects an unparseable value rather than silently falling back, since falling back to the
 * default would produce data that does not match what the caller asked for and never say so.
 */
export function resolveReferenceDate(env: NodeJS.ProcessEnv = process.env): Date {
  const override = env["SEED_REFERENCE_DATE"];
  if (override === undefined || override === "") return SEED_REFERENCE_DATE;

  const parsed = new Date(override);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `SEED_REFERENCE_DATE="${override}" is not a date this can parse. Use an ISO 8601 value such ` +
        'as "2026-08-25" or "2026-08-25T09:00:00Z". Leaving it unset uses the pinned default.',
    );
  }
  return parsed;
}

/**
 * **SEED ONLY — a review convenience, not a product rule (R3, 2026-09-11).**
 *
 * Egypt's working week runs Sunday to Thursday, and the schedule engine is entirely indifferent to
 * which days a clinic works: a real clinic's templates are whatever an admin saves. The seeded
 * doctors cover all seven days so that a review build stood up on a Friday or Saturday still has a
 * day to look at — a reviewer who opens the queue to an empty board on a weekend learns nothing
 * about the queue. Nothing in `src/` reads this. 0 = Sunday, matching JavaScript's getUTCDay().
 */
export const WORKING_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export interface StaffBlueprint {
  /** Stable key used to wire doctors and appointment actors together while seeding. */
  key: string;
  fullName: string;
  phoneE164: string;
  email: string | null;
  role: MembershipRole;
  /** Present only for DOCTOR memberships. */
  doctor?: {
    specialty: string;
    licenseNumber: string;
    title: string;
    /** Q45: what the English sheet prints under the signature. */
    printedNameEn: string;
    /**
     * R1 and R2. Left off for most seeded doctors on purpose: the contrast is the thing worth
     * seeing — one doctor with the controls, the rest without them and refused at the route.
     */
    mayAdjustPrices?: boolean;
    collectsPayments?: boolean;
    /** Local wall-clock working hours, applied on every working weekday. */
    shift: { startHour: number; startMinute: number; endHour: number; endMinute: number };
    break: { startHour: number; startMinute: number; endHour: number; endMinute: number; label: string };
  };
}

export interface ServiceBlueprint {
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  /** Integer minor units -- piastres. Never a float, never formatted (CLAUDE.md). */
  priceMinor: number;
}

export interface InsurerBlueprint {
  name: string;
  type: "INSURER" | "TPA" | "CORPORATE" | "GOVERNMENT";
  contractNumber: string;
  contactPerson: string;
  phone: string;
  email: string;
  claimSubmissionMethod: "PORTAL" | "EMAIL" | "PAPER" | "OTHER";
  paymentTermsDays: number;
  priorApprovalRequired: boolean;
}

export interface ClinicBlueprint {
  slug: string;
  name: string;
  /** Q45: printed documents are English, and the letterhead uses these. */
  nameEn: string;
  phone: string;
  address: string;
  addressEn: string;
  timezone: string;
  locale: LocaleCode;
  currency: string;
  /** Deterministic PRNG seed, so each clinic generates its own stable data. */
  randomSeed: number;
  patientCount: number;
  staff: StaffBlueprint[];
  services: ServiceBlueprint[];
  /** The clinic's insurance registry (Phase 5 PR 1). One insurer and one TPA, which is the pair
   *  an Egyptian clinic actually deals with: a company that carries the risk and an administrator
   *  that processes the claims. */
  insurers: InsurerBlueprint[];
  /**
   * One-off schedule changes, relative to SEED_REFERENCE_DATE so they stay put across runs.
   *
   * Seeded because until now both clinics had zero, which meant the slot engine's whole exception
   * pipeline -- BLOCKED, HOLIDAY, EXTRA_AVAILABILITY, and Q13's clinic-wide `doctorId: null` --
   * was exercised only by unit tests with hand-built inputs and never against a real database.
   * The counts differ between clinics on purpose, like every other fixture count here.
   */
  exceptions: ScheduleExceptionBlueprint[];
}

export interface ScheduleExceptionBlueprint {
  /** Days from SEED_REFERENCE_DATE. Negative is history, positive is upcoming. */
  dayOffset: number;
  type: "BLOCKED" | "HOLIDAY" | "EXTRA_AVAILABILITY";
  /** `null` targets every doctor in the clinic -- the Q13 case. Otherwise a staff blueprint key. */
  doctorKey: string | null;
  startHour: number | null;
  startMinute: number | null;
  endHour: number | null;
  endMinute: number | null;
  reason: string;
}

/**
 * A doctor who works at both clinics. This is not filler: PHASE-1.md's Definition of Done
 * requires proving the tenant switcher works for a user with two memberships, and that is
 * untestable unless such a user exists in the seed. She appears in both blueprints below with the
 * same phone number, which is what makes her one `users` row with two `memberships`.
 */
const SHARED_DOCTOR_PHONE = "+201001234567";

const NILE_FAMILY: ClinicBlueprint = {
  slug: "nile-family-clinic",
  name: "عيادة النيل لطب الأسرة",
  nameEn: "Nile Family Medicine Clinic",
  phone: "+20223456789",
  address: "١٢ شارع النصر، المعادي، القاهرة",
  addressEn: "12 El-Nasr St, Maadi, Cairo",
  timezone: "Africa/Cairo",
  locale: "ar",
  currency: "EGP",
  randomSeed: 20260823,
  patientCount: 120,
  staff: [
    {
      key: "owner",
      fullName: "أحمد عبد الرحمن الشناوي",
      phoneE164: "+201005551001",
      email: "owner@nile-family.example",
      role: "OWNER",
    },
    /**
     * **One person holds one role per clinic — ruled 2026-09-09, superseding 2026-09-06.**
     *
     * There used to be a second membership here: the same human as `owner` above, with a
     * RECEPTIONIST role in the same clinic, so a working owner could switch into the desk after the
     * ruling that took queue actions away from OWNER.
     *
     * That is withdrawn. The admin app is generic: the owner is not assumed to practise or to work
     * the desk, and setup is normally done by the vendor's onboarding team on the clinic's behalf.
     * A seeded account offering to become the receptionist of the clinic you own was manufacturing
     * a person the product no longer assumes exists, and the clinic switcher grew a role suffix to
     * tell the two buttons apart.
     *
     * **The schema is unchanged.** `memberships` still permits several per person per clinic,
     * because a doctor working in two clinics is the case the unique constraint was lifted for —
     * `doctor-shared` below is exactly that, and it still holds two memberships in two clinics.
     */
    {
      key: "admin",
      fullName: "منى سيد فهمي",
      phoneE164: "+201005551002",
      email: "admin@nile-family.example",
      role: "ADMIN",
    },
    {
      key: "reception",
      fullName: "شيماء طارق بدوي",
      phoneE164: "+201005551003",
      email: "reception@nile-family.example",
      role: "RECEPTIONIST",
    },
    {
      key: "doctor-hisham",
      fullName: "هشام محمود الديب",
      phoneE164: "+201005551004",
      email: "h.eldeeb@nile-family.example",
      role: "DOCTOR",
      doctor: {
        specialty: "طب الأسرة",
        licenseNumber: "EG-FM-10482",
        title: "استشاري",
        printedNameEn: "Dr Hisham Mahmoud El-Deeb",
        mayAdjustPrices: true,
        collectsPayments: true,
        shift: { startHour: 9, startMinute: 0, endHour: 14, endMinute: 0 },
        break: { startHour: 11, startMinute: 30, endHour: 12, endMinute: 0, label: "استراحة" },
      },
    },
    {
      key: "doctor-shared",
      fullName: "دينا كريم القاضي",
      phoneE164: SHARED_DOCTOR_PHONE,
      email: "d.elkady@example.com",
      role: "DOCTOR",
      doctor: {
        specialty: "طب الأطفال",
        licenseNumber: "EG-PD-20117",
        printedNameEn: "Dr Nour Adel Shafik",
        title: "أخصائي",
        shift: { startHour: 16, startMinute: 0, endHour: 20, endMinute: 0 },
        break: { startHour: 18, startMinute: 0, endHour: 18, endMinute: 30, label: "استراحة" },
      },
    },
  ],
  insurers: [
    {
      name: "المجموعة العربية المصرية للتأمين (gig)",
      type: "INSURER",
      contractNumber: "GIG-2026-114",
      contactPerson: "هالة عبد العزيز",
      phone: "+20227921000",
      email: "providers@gig.example",
      claimSubmissionMethod: "PORTAL",
      paymentTermsDays: 45,
      priorApprovalRequired: true,
    },
    {
      name: "نكست كير لإدارة المطالبات",
      type: "TPA",
      contractNumber: "NC-88231",
      contactPerson: "شريف منير",
      phone: "+20235381200",
      email: "claims@nextcare.example",
      claimSubmissionMethod: "EMAIL",
      paymentTermsDays: 30,
      priorApprovalRequired: false,
    },
  ],
  services: [
    { nameAr: "كشف جديد", nameEn: "New consultation", type: "NEW", durationMinutes: 30, priceMinor: 30000 },
    // `CONSULTATION` had no seeded service until 2026-09-03, which made a live enum value look dead
    // — invisible while services arrived from the seed, and a support question the moment an admin
    // picks from the type dropdown and finds an option nothing in the system exercises. The
    // founder's ruling was that this is a seed gap rather than a schema one, so the value stays and
    // the fixture grows. The Arabic name is his own from 2026-08-27, when he specified the four
    // values: NEW كشف, CONSULTATION استشارة, FOLLOW_UP إعادة كشف, PROCEDURE إجراء آخر.
    { nameAr: "استشارة", nameEn: "Consultation", type: "CONSULTATION", durationMinutes: 20, priceMinor: 20000 },
    { nameAr: "إعادة كشف", nameEn: "Follow-up", type: "FOLLOW_UP", durationMinutes: 20, priceMinor: 15000 },
    { nameAr: "متابعة ضغط وسكر", nameEn: "Chronic care follow-up", type: "FOLLOW_UP", durationMinutes: 20, priceMinor: 18000 },
    { nameAr: "تطعيم", nameEn: "Vaccination", type: "PROCEDURE", durationMinutes: 15, priceMinor: 12000 },
  ],
  exceptions: [
    // Clinic-wide, whole day: the Q13 case that `doctor_id NULL` exists for. Before D22's
    // migration this could only be expressed as one row per doctor, and the doctor hired next
    // month inherited none of them.
    {
      dayOffset: 9,
      type: "HOLIDAY",
      doctorKey: null,
      startHour: null,
      startMinute: null,
      endHour: null,
      endMinute: null,
      reason: "إجازة رسمية",
    },
    // One doctor, part of a day.
    {
      dayOffset: 4,
      type: "BLOCKED",
      doctorKey: "doctor-hisham",
      startHour: 11,
      startMinute: 0,
      endHour: 13,
      endMinute: 0,
      reason: "مؤتمر طبي",
    },
    // Extra hours on a day the template does not cover, which is what EXTRA_AVAILABILITY is for.
    {
      dayOffset: 6,
      type: "EXTRA_AVAILABILITY",
      doctorKey: "doctor-hisham",
      startHour: 18,
      startMinute: 0,
      endHour: 21,
      endMinute: 0,
      reason: "عيادة مسائية إضافية",
    },
    {
      dayOffset: -12,
      type: "BLOCKED",
      doctorKey: "doctor-shared",
      startHour: null,
      startMinute: null,
      endHour: null,
      endMinute: null,
      reason: "إجازة",
    },
  ],
};

const SHIFA_DERM: ClinicBlueprint = {
  slug: "shifa-derm-center",
  name: "مركز الشفاء للجلدية والتجميل",
  nameEn: "Al-Shifa Dermatology & Aesthetics Centre",
  phone: "+20342345678",
  address: "٤٥ شارع فوزي معاذ، سموحة، الإسكندرية",
  addressEn: "45 Fawzy Moaz St, Smouha, Alexandria",
  timezone: "Africa/Cairo",
  locale: "ar",
  currency: "EGP",
  randomSeed: 77120264,
  patientCount: 80,
  staff: [
    {
      key: "owner",
      fullName: "مصطفى عصام الغباشي",
      phoneE164: "+201115552001",
      email: "owner@shifa-derm.example",
      role: "OWNER",
    },
    {
      key: "reception",
      fullName: "ياسمين وليد الشربيني",
      phoneE164: "+201115552002",
      email: "reception@shifa-derm.example",
      role: "RECEPTIONIST",
    },
    {
      key: "doctor-shared",
      fullName: "دينا كريم القاضي",
      phoneE164: SHARED_DOCTOR_PHONE,
      email: "d.elkady@example.com",
      role: "DOCTOR",
      doctor: {
        specialty: "الأمراض الجلدية",
        licenseNumber: "EG-DM-30455",
        printedNameEn: "Dr Dina Karim El-Kady",
        title: "أخصائي",
        shift: { startHour: 10, startMinute: 0, endHour: 15, endMinute: 0 },
        break: { startHour: 12, startMinute: 30, endHour: 13, endMinute: 0, label: "استراحة" },
      },
    },
  ],
  insurers: [
    {
      name: "مصر للتأمين",
      type: "INSURER",
      contractNumber: "MISR-7741",
      contactPerson: "منى رشدي",
      phone: "+20334861200",
      email: "providers@misrinsurance.example",
      claimSubmissionMethod: "PORTAL",
      paymentTermsDays: 60,
      priorApprovalRequired: true,
    },
    {
      name: "ميد نت مصر",
      type: "TPA",
      contractNumber: "MN-40219",
      contactPerson: "أحمد لطفي",
      phone: "+20334229100",
      email: "claims@mednet.example",
      claimSubmissionMethod: "PORTAL",
      paymentTermsDays: 30,
      priorApprovalRequired: false,
    },
  ],
  services: [
    { nameAr: "كشف جلدية", nameEn: "Dermatology consultation", type: "NEW", durationMinutes: 30, priceMinor: 40000 },
    { nameAr: "متابعة علاج", nameEn: "Treatment follow-up", type: "FOLLOW_UP", durationMinutes: 20, priceMinor: 20000 },
    { nameAr: "جلسة ليزر", nameEn: "Laser session", type: "PROCEDURE", durationMinutes: 45, priceMinor: 90000 },
  ],
  exceptions: [
    {
      dayOffset: 11,
      type: "BLOCKED",
      doctorKey: "doctor-shared",
      startHour: 10,
      startMinute: 0,
      endHour: 12,
      endMinute: 0,
      reason: "صيانة الجهاز",
    },
    {
      dayOffset: 2,
      type: "EXTRA_AVAILABILITY",
      doctorKey: "doctor-shared",
      startHour: 16,
      startMinute: 0,
      endHour: 19,
      endMinute: 0,
      reason: "عيادة إضافية",
    },
  ],
};

export const CLINICS: readonly ClinicBlueprint[] = [NILE_FAMILY, SHIFA_DERM];

/** The user who holds a membership in both clinics, identified the way the seed links them. */
export const SHARED_STAFF_PHONE = SHARED_DOCTOR_PHONE;

/**
 * The seeded operator — pilot-readiness 0a. Holds **no membership in any clinic**, which is the
 * whole point: the platform console is the vendor's surface, not a role inside a customer.
 *
 * Seeded so the review stack has one to sign in as. Production operators are created by
 * `npm run platform:admin`, which reads a file rather than taking a name on the command line.
 */
export const PLATFORM_ADMIN = {
  fullName: "مشغّل المنصة",
  phoneE164: "+201000000000",
  email: "operator@clinic-os.example",
} as const;

// Removed 2026-09-09 with the membership it named: one person holds one role per clinic, so the
// seed no longer creates an owner who is also the receptionist. The schema still permits several.
