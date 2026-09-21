import { uuidv7 } from "uuidv7";
import type { PatientRelationship, PatientStatus } from "../../generated/prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { calendarDayIn } from "../appointments/domain/zoned-time.ts";
import {
  standingOf,
  type CalendarDay,
  type PolicyStanding,
} from "../insurance/domain/policy-window.ts";
import { BadRequestException } from "@nestjs/common";
import { refusal, type FieldName } from "../../common/refusals.ts";
import { normalisePhone } from "../auth/phone.ts";
import { latinSearchKey } from "./domain/transliterate.ts";
import { missingIntakeFields, type MissingIntakeField } from "./domain/intake-completeness.ts";

/**
 * Patients: search, create, read, and visit history.
 *
 * ## This is a service, not a controller's helper
 *
 * ARCHITECTURE.md §12: the AI tool layer "never touches the database — it calls the same service
 * layer the HTTP controllers use". `find_patient_by_phone()` is a named tool in that registry, and
 * it will call the function below. So this module has constraints that a controller-shaped service
 * would not:
 *
 * - **No NestJS HTTP types.** No `Request`, no `NotFoundException`, no decorators. A thrown
 *   `NotFoundException` reaching the WhatsApp agent is an HTTP concept arriving somewhere with no
 *   HTTP in it, and the agent would have to catch a framework exception to learn "no such patient".
 * - **Absence is a value, not an exception.** `getPatient()` returns `null`. The controller maps
 *   that to 404; the AI tool maps it to "I could not find that patient". Two callers, one answer.
 *   This is also what makes the cross-tenant 404 correct rather than merely convenient — see below.
 * - **The caller supplies its identity.** `CallerContext` is passed in rather than read from
 *   request-scoped storage, because the AI agent has no request. It runs as a synthetic `AI_AGENT`
 *   actor (§12 rule 2) and must be able to say so explicitly.
 *
 * Writing this controller-first and refactoring in Phase 7 would mean rewriting the layer the
 * product's differentiator depends on, at the point where it is hardest to change.
 *
 * ## Clinical content is not here
 *
 * `listVisitHistory()` returns visit **metadata** — date, doctor, service, status, follow-up date.
 * It does not return diagnosis, examination, plan or notes, and it must never grow them. CLAUDE.md
 * requires that separation to be enforced by separate endpoints and separate DTOs, never by
 * filtering fields out of one response, because a filter is one refactor away from being removed.
 * Clinical content belongs to a visits service with its own doctor-only guard.
 */

/** Who is calling, and for which tenant. Explicit because the AI agent has no HTTP request. */
export interface CallerContext {
  tenantId: string;
  actor: ActorContext;
}

type SupportedCountry = "EG" | "SA" | "AE";

/** The clinic's own country, never a fixed "EG" — CLAUDE.md forbids assuming +20. */
async function tenantCountry(tx: TransactionClient, tenantId: string): Promise<SupportedCountry> {
  const row = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true } });
  return row.country as SupportedCountry;
}

/**
 * A stored phone is E.164 or the write is refused.
 *
 * Storing what was typed made `0100 123 4567` and `+201001234567` two different households for one
 * family, and made a number unreachable by search in any other notation. Phase 6 sends WhatsApp to
 * this column literally, so a number that is not E.164 is a message that never arrives — which is
 * why this refuses rather than falls back to the raw string the way the login identifier does.
 */
function requireE164(typed: string, country: SupportedCountry, field: FieldName): string {
  const normalised = normalisePhone(typed, country);
  if (normalised === null) throw new BadRequestException(refusal("INVALID_FIELD", { field }));
  return normalised;
}

/** The same normalisation on the way in to a lookup, so a search matches however it was typed. */
export function normaliseForSearch(typed: string, country: SupportedCountry): string {
  return normalisePhone(typed, country) ?? typed;
}

/**
 * A search result.
 *
 * `fullNameAr`, `phoneE164` and `dateOfBirth` are **not optional and must not become optional.**
 * D19 accepts that its Arabic normalisation knowingly merges some genuinely different names —
 * عبده with عبدة, حسني with حسنى — and that is survivable *only* because a human choosing between
 * two rows can see the real name alongside a phone number and a date of birth. Removing any of
 * these three from the result shape makes those normalisation rules unsafe.
 */
export interface PatientSearchResult {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
  dateOfBirth: Date | null;
  status: PatientStatus;
  /**
   * D26's required-at-intake fields this row lacks, so the book and search agree about the badge.
   *
   * Carried on the list rather than only on the profile: a badge that appears when browsing and
   * vanishes when searching for the same person reads as a bug in the badge.
   */
  missingIntakeFields: MissingIntakeField[];
}

/** What the raw queries select. Narrower than a profile — only what the flag needs. */
type IntakeJudgeable = Omit<PatientSearchResult, "missingIntakeFields"> & {
  gender: string | null;
  nationality: string | null;
};

const withCompleteness = <T extends IntakeJudgeable>(rows: T[]): (T & PatientSearchResult)[] =>
  rows.map((row) => ({ ...row, missingIntakeFields: missingIntakeFields(row) }));

export interface PatientProfile extends PatientSearchResult {
  secondaryPhone: string | null;
  gender: string | null;
  nationalId: string | null;
  nationality: string | null;
  passportNumber: string | null;
  governorate: string | null;
  referralSource: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  relationshipToContact: PatientRelationship;
  mergedIntoPatientId: string | null;
  createdAt: Date;
  /** Which of D26's required-at-intake fields this row lacks. Empty means complete. */
  missingIntakeFields: MissingIntakeField[];
}

/**
 * What this patient still owes, in integer minor units.
 *
 * **`remainingMinor` is read, never recomputed** — D7. It is
 * `GENERATED ALWAYS AS (amount_due_minor - amount_paid_minor) STORED`, and a service that performs
 * the same subtraction is precisely the drift D7 exists to prevent: it would agree with the column
 * on every test and diverge in production the first time a payment row is adjusted by anything that
 * is not this code path. The column is the answer; this only sums it.
 *
 * `outstandingMinor` is `0` for a patient with nothing owed **and** for a patient with no payment
 * rows at all — those are genuinely the same answer to "what is owed". `paymentCount` is returned
 * beside it so a screen can tell "nothing owed" from "nothing recorded yet", which is a different
 * question and the one Phase 4 will care about.
 */
export interface OutstandingBalance {
  outstandingMinor: number;
  /** How many payment rows exist at all. Zero means nothing has ever been billed. */
  paymentCount: number;
}

/** One row of the appointment history — scheduling facts, never clinical ones. */
export interface AppointmentHistoryEntry {
  id: string;
  scheduledStart: Date;
  status: string;
  source: string;
  doctorId: string;
  doctorName: string | null;
  serviceName: string | null;
}

/** Visit metadata only. Deliberately no clinical fields — see the note on this module. */
export interface VisitHistoryEntry {
  id: string;
  /**
   * The appointment this visit belongs to, so a doctor can open its content.
   *
   * Every clinical read resolves ownership through the appointment (Q18), so a list that carries
   * only visit ids is a list nothing can be opened from — the defect Q18 was written about. Null
   * only for a visit whose appointment has gone, which the schema does not currently allow.
   */
  appointmentId: string | null;
  visitDate: Date;
  doctorId: string;
  doctorName: string | null;
  serviceName: string | null;
  status: string;
  followUpDate: Date | null;
}

export interface CreatePatientInput {
  fullNameAr: string;
  fullNameEn?: string | null;
  phoneE164: string;
  secondaryPhone?: string | null;
  /** Required at intake since D26; still typed optional because the column stays nullable. */
  gender?: string | null;
  dateOfBirth?: Date | null;
  nationality?: string | null;
  nationalId?: string | null;
  passportNumber?: string | null;
  governorate?: string | null;
  referralSource?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  relationshipToContact: PatientRelationship;
}

/** One household, addressed by the phone that identifies it. D28. */
export interface Household {
  contactId: string;
  phoneE164: string;
  members: {
    id: string;
    fullNameAr: string;
    relationshipToContact: PatientRelationship;
    dateOfBirth: Date | null;
  }[];
}

/**
 * One mapping from row to profile, used by every read path.
 *
 * Written once because there were two hand-maintained copies and adding a column meant remembering
 * both — the shape of drift this project keeps finding. `missingIntakeFields` is derived here so a
 * caller cannot forget it.
 */
function toProfile(row: {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
  secondaryPhone: string | null;
  gender: string | null;
  dateOfBirth: Date | null;
  nationalId: string | null;
  nationality: string | null;
  passportNumber: string | null;
  governorate: string | null;
  referralSource: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  relationshipToContact: PatientRelationship;
  status: PatientStatus;
  mergedIntoPatientId: string | null;
  createdAt: Date;
}): PatientProfile {
  return {
    id: row.id,
    fullNameAr: row.fullNameAr,
    fullNameEn: row.fullNameEn,
    phoneE164: row.phoneE164,
    secondaryPhone: row.secondaryPhone,
    gender: row.gender,
    dateOfBirth: row.dateOfBirth,
    nationalId: row.nationalId,
    nationality: row.nationality,
    passportNumber: row.passportNumber,
    governorate: row.governorate,
    referralSource: row.referralSource,
    email: row.email,
    address: row.address,
    notes: row.notes,
    relationshipToContact: row.relationshipToContact,
    status: row.status,
    mergedIntoPatientId: row.mergedIntoPatientId,
    createdAt: row.createdAt,
    missingIntakeFields: missingIntakeFields(row),
  };
}

/**
 * Who already answers to this phone. Intake asks before writing — D28.
 *
 * Returns `null` when the number is new. When it is not, the caller offers two honest choices: add
 * a member to this household, or open the patient who already holds it. What it must never do is
 * create a second patient on the same number without saying so.
 */
export async function householdByPhone(
  ctx: CallerContext,
  phoneE164: string,
): Promise<Household | null> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    // Normalised the same way the write was, so the household is found however reception typed it.
    // Falls back to the raw string rather than refusing: a lookup that cannot parse simply misses.
    const wanted = normaliseForSearch(phoneE164, await tenantCountry(tx, ctx.tenantId));
    const contact = await tx.contact.findFirst({
      where: { phoneE164: wanted },
      select: {
        id: true,
        phoneE164: true,
        patients: {
          where: { status: "ACTIVE" },
          select: { id: true, fullNameAr: true, relationshipToContact: true, dateOfBirth: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (contact === null) return null;
    return { contactId: contact.id, phoneE164: contact.phoneE164, members: contact.patients };
  });
}

/**
 * Trigram threshold. 0.3 is `pg_trgm`'s default and the value D19's measurements were taken at.
 *
 * It is applied to `word_similarity`, **not** `similarity`, and that distinction is not cosmetic —
 * see the note on `searchPatients`.
 */
const SIMILARITY_THRESHOLD = 0.3;

/**
 * How far below the best match a result may be and still be shown.
 *
 * **This is a floor on results, not a stricter match, and the distinction is the whole point.**
 * D19 fixed `SIMILARITY_THRESHOLD` at 0.3 on the founder's reasoning that a miss creates a
 * duplicate, and duplicates split a medical history permanently. That reasoning is untouched here:
 * the threshold above still decides what *matches*, and nothing is excluded unless something
 * strictly better was found for the same query.
 *
 * ## Why it was needed, measured rather than guessed
 *
 * Searching `احمد` returned five محمد patients and no أحمد at all. `احمد` and `محمد` share the
 * trigram `حمد`, and that is the most common name pair in Egypt, so it fires on almost every
 * search. The scores, on real seeded data:
 *
 * ```
 * word_similarity(احمد, محمد) = 0.400   -- above the threshold, hence the noise
 *      similarity(احمد, محمد) = 0.250   -- below it
 * ```
 *
 * The second line is the uncomfortable one: the false positive is a direct consequence of the
 * deliberate Phase-1 switch from `similarity` to `word_similarity`, which was itself right — a
 * first name scored against a three-part full name returns nothing under `similarity`.
 *
 * Measured across every match for `احمد` in both branches:
 *
 * ```
 * Arabic  true 1.000   false 0.400 - 0.600   (محمد …)
 * Latin   true 1.000   false 0.333           (mohamed …, and emad/imad -- عماد)
 * ```
 *
 * True matches sit at 1.000 and false ones at or below 0.600, **in both branches, with no
 * overlap.** So the honest fix is the one the founder named before seeing the numbers: rank on
 * score and cut off relative to the best, rather than raise the global threshold.
 *
 * ## Why relative and not absolute
 *
 * An absolute floor is a second threshold wearing a different hat, and it would reintroduce exactly
 * the miss D19 forbids: a genuinely fuzzy but correct match — a misspelling, an unusual
 * transliteration — scores 0.5, and an absolute floor of 0.7 discards the only row the receptionist
 * was looking for. Relative means **weak matches are suppressed only when something strong exists**;
 * when the best available is itself 0.5, everything down to 0.35 is still offered.
 *
 * 0.7 is chosen against the measurement: it clears the highest observed false positive (0.600)
 * while leaving room beneath a weak-but-genuine best match.
 *
 * **Phone matches are exempt**, because they score zero on both name columns — a relative floor
 * computed from name similarity would silently delete the single most reliable way to find somebody.
 */
const RELATIVE_FLOOR = 0.7;
const DEFAULT_LIMIT = 20;

/**
 * Finds patients by name or phone.
 *
 * Phone is matched as a substring of `phone_e164`, because the receptionist usually has the number
 * and D19 makes phone the primary search affordance precisely because transliteration is imperfect.
 * Names are matched by trigram similarity against both derived columns — `name_search_ar`, which
 * Postgres generates, and `name_search_latin`, which the application maintains.
 *
 * The query is pushed through `latinSearchKey` so that a Latin query is compared against the same
 * transliteration the column holds. A query typed in Arabic is compared against `name_search_ar`
 * via `normalize_arabic_name()`, so both scripts reach the right column without the caller
 * choosing.
 *
 * ## `word_similarity`, not `similarity`
 *
 * `similarity()` compares two strings *as wholes*, so it penalises a short query against a long
 * name — which is every realistic search. Measured against real seeded data:
 *
 * ```
 * similarity('محمد أحمد الشناوي', 'محمد')       = 0.33   -- barely over the threshold
 * similarity('مريض العيادة الأولى', 'مريض')      = 0.28   -- UNDER it: no match at all
 * word_similarity('محمد', 'محمد أحمد الشناوي')  = 1.00
 * word_similarity('مريض', 'مريض العيادة الأولى') = 1.00
 * ```
 *
 * A receptionist typing a first name is the ordinary case, and with `similarity()` it returns
 * nothing for any name of three parts or more. D19 is explicit about what happens then: she
 * concludes the patient is not registered and creates a duplicate, which splits a medical history
 * permanently. `word_similarity(query, target)` asks how well the query matches *some portion* of
 * the target, which is the question actually being asked.
 *
 * This was caught by a test searching for one word of a seeded patient's name and getting an empty
 * result. It would have shipped otherwise, and it would have looked like "search is a bit weak"
 * rather than like a bug.
 *
 * Raw SQL rather than Prisma: `name_search_ar` is `@ignore`d in schema.prisma (D19) and therefore
 * absent from the generated client entirely, and the trigram functions have no Prisma expression.
 * The tenant filter is still explicit here **and** enforced by RLS underneath — belt and braces,
 * the same as everywhere else.
 */
export async function searchPatients(
  ctx: CallerContext,
  rawQuery: string,
  limit: number = DEFAULT_LIMIT,
): Promise<PatientSearchResult[]> {
  const query = rawQuery.trim();
  if (query.length === 0) return [];

  const latin = latinSearchKey(query, null) ?? query.toLowerCase();

  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    // Only the phone comparison uses the normalised form: a name or a national ID must still be
    // matched as typed. `0100 123 4567` becomes `+201001234567`; a partial like `0100` does not
    // parse, falls back to the raw string, and keeps working as the substring search it was.
    const phoneQuery = normaliseForSearch(query, await tenantCountry(tx, ctx.tenantId));

    return withCompleteness(
      await tx.$queryRaw<IntakeJudgeable[]>`
      WITH scored AS (
        SELECT id,
               full_name_ar   AS "fullNameAr",
               full_name_en   AS "fullNameEn",
               phone_e164     AS "phoneE164",
               date_of_birth  AS "dateOfBirth",
               gender,
               nationality,
               status,
               -- A national ID is exact, never fuzzy: it is copied off a card, and a near-match on
               -- a 14-digit number is not a near-match on a person. Treated like a phone hit so it
               -- bypasses the relative floor below (D27).
               -- A national ID is exact, never fuzzy: it is copied off a card, and a near match on
               -- a 14-digit number is not a near match on a person. Grouped with the phone hit so
               -- it bypasses the relative floor below (D27).
               --
               -- coalesce is load-bearing. A comparison against a NULL national_id yields NULL, not
               -- false, so OR-ing it makes phone_hit NULL -- and WHERE NOT phone_hit in the outer
               -- query then matches nothing, emptying every name search. Four specs went red.
               coalesce(
                 phone_e164 ILIKE '%' || ${phoneQuery} || '%' OR national_id = ${query},
                 false
               ) AS phone_hit,
               greatest(
                 word_similarity(normalize_arabic_name(${query}), coalesce(name_search_ar, '')),
                 word_similarity(${latin}, coalesce(name_search_latin, ''))
               ) AS score
          FROM patients
         WHERE tenant_id = ${ctx.tenantId}::uuid
           AND status <> 'MERGED'
           AND (
                phone_e164 ILIKE '%' || ${phoneQuery} || '%'
             OR national_id = ${query}
             OR word_similarity(normalize_arabic_name(${query}), coalesce(name_search_ar, '')) >= ${SIMILARITY_THRESHOLD}
             OR word_similarity(${latin}, coalesce(name_search_latin, '')) >= ${SIMILARITY_THRESHOLD}
           )
      )
      SELECT id, "fullNameAr", "fullNameEn", "phoneE164", "dateOfBirth", gender, nationality, status
        FROM scored
       WHERE phone_hit
          OR score >= ${RELATIVE_FLOOR} * (SELECT max(score) FROM scored WHERE NOT phone_hit)
       ORDER BY score DESC, "fullNameAr" ASC
       LIMIT ${limit}
    `,
    );
  });
}

/**
 * One patient, or `null`.
 *
 * **`null` is the whole point.** A patient belonging to another tenant is invisible to the query —
 * the Prisma extension injects `tenantId` and RLS enforces it underneath — so this returns `null`
 * for "no such patient" and for "that patient belongs to somebody else" identically, because at
 * this layer those are genuinely the same fact. The controller turns `null` into 404, which is
 * therefore the *truthful* status rather than a policy choice: there is no ownership check here
 * that could have produced a 403, and no way to write one without reaching around the extension.
 */
export async function getPatient(ctx: CallerContext, patientId: string): Promise<PatientProfile | null> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const patient = await tx.patient.findUnique({ where: { id: patientId } });
    if (patient === null) return null;
    return toProfile(patient);
  });
}

/**
 * Creates a patient.
 *
 * `nameSearchLatin` is computed here rather than by the database, because it is the volatile half
 * of D19's split — the transliteration table improves and the column is rebuilt by a backfill.
 * `nameSearchAr` is not set at all: Postgres generates it, and the extension rejects any attempt
 * to write it.
 */
export async function createPatient(ctx: CallerContext, input: CreatePatientInput): Promise<PatientProfile> {
  const id = uuidv7();

  await withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const country = await tenantCountry(tx, ctx.tenantId);
    const phoneE164 = requireE164(input.phoneE164, country, "phoneE164");
    const secondaryPhone =
      input.secondaryPhone === undefined || input.secondaryPhone === null
        ? null
        : requireE164(input.secondaryPhone, country, "secondaryPhone");

    // The household, found or created, in the same transaction as the patient — D28. `contacts`
    // carries UNIQUE (tenant_id, phone_e164), so two intakes racing on one number cannot both win.
    const existing = await tx.contact.findFirst({
      where: { phoneE164 },
      select: { id: true },
    });
    const contactId =
      existing?.id ??
      (
        await tx.contact.create({
          data: injected({ id: uuidv7(), phoneE164 }),
          select: { id: true },
        })
      ).id;

    // The file number is allocated by a BEFORE INSERT trigger, not here: eighteen places insert a
    // patient and an allocation in one of them is one the other seventeen skip (Phase 5 PR 2).
    await tx.patient.create({
      data: injected({
        id,
        contactId,
        fullNameAr: input.fullNameAr,
        fullNameEn: input.fullNameEn ?? null,
        nameSearchLatin: latinSearchKey(input.fullNameAr, input.fullNameEn ?? null),
        phoneE164,
        secondaryPhone,
        gender: input.gender ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        nationality: input.nationality ?? null,
        nationalId: input.nationalId ?? null,
        passportNumber: input.passportNumber ?? null,
        governorate: input.governorate ?? null,
        referralSource: input.referralSource ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        relationshipToContact: input.relationshipToContact,
        status: "ACTIVE",
      }),
    });
  });

  const created = await getPatient(ctx, id);
  // Unreachable: the row was just written in a committed transaction under this same tenant.
  // Throwing rather than returning null keeps the signature honest for every caller.
  if (created === null) throw new Error(`Patient ${id} was created but could not be read back.`);
  return created;
}

/**
 * Every field reception may correct. Optional means "not supplied, leave alone"; `null` means
 * "clear it", which is why these are not merged with `undefined`.
 *
 * **`status`, `mergedIntoPatientId` and every clinical field are absent, deliberately.** Merging is
 * `patients.merge`, a different capability that is `NONE` for reception and doctors, and archiving
 * is not an edit. A DTO that accepted `status` would let a correction to a phone number archive a
 * patient, and the mistake would look exactly like a successful save.
 */
export interface UpdatePatientInput {
  fullNameAr?: string;
  fullNameEn?: string | null;
  phoneE164?: string;
  secondaryPhone?: string | null;
  gender?: string | null;
  dateOfBirth?: Date | null;
  nationalId?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  relationshipToContact?: PatientRelationship;
}

/**
 * Corrects a patient's demographics and contact details. Reception's edit path.
 *
 * ## `nameSearchLatin` is recomputed here, and that is the whole risk in this function
 *
 * `createPatient` computes it from `fullNameAr` + `fullNameEn` (D19). Until this function existed
 * there was no way to change either, so there was no way for the column to go stale — which is
 * exactly why the omission would have been so easy to make and so hard to see. A patient renamed
 * from a misspelling would keep the **old** transliteration as their only Latin search key: search
 * would still find them by the wrong spelling and stop finding them by the right one, silently, and
 * the desk would conclude the patient is not registered and create a duplicate. D19 records why
 * that specific outcome is a safety problem rather than a search-quality one — duplicates split a
 * medical history permanently.
 *
 * Recomputed from the **post-update** values of both fields, never from the incoming patch alone:
 * changing only `fullNameEn` still has to fold the unchanged Arabic name back in, and computing
 * from the patch would quietly drop it.
 *
 * `nameSearchAr` is not touched. Postgres generates it from `full_name_ar` (D19) and the scoping
 * extension rejects any attempt to write it, so the database keeps that half in step by itself.
 */
export async function updatePatient(
  ctx: CallerContext,
  patientId: string,
  input: UpdatePatientInput,
): Promise<PatientProfile | null> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    // Read first, under the tenant filter: a patient in another tenant is invisible here, so this
    // returns null and the controller answers 404 -- never 403, which would confirm the row exists.
    const existing = await tx.patient.findUnique({ where: { id: patientId } });
    if (existing === null) return null;

    const country = await tenantCountry(tx, ctx.tenantId);
    const phoneE164 = input.phoneE164 === undefined ? undefined : requireE164(input.phoneE164, country, "phoneE164");
    const secondaryPhone =
      input.secondaryPhone === undefined || input.secondaryPhone === null
        ? input.secondaryPhone
        : requireE164(input.secondaryPhone, country, "secondaryPhone");

    const fullNameAr = input.fullNameAr ?? existing.fullNameAr;
    const fullNameEn = input.fullNameEn === undefined ? existing.fullNameEn : input.fullNameEn;
    const nameChanged = fullNameAr !== existing.fullNameAr || fullNameEn !== existing.fullNameEn;

    await tx.patient.update({
      where: { id: patientId },
      data: {
        ...(input.fullNameAr === undefined ? {} : { fullNameAr: input.fullNameAr }),
        ...(input.fullNameEn === undefined ? {} : { fullNameEn: input.fullNameEn }),
        // Only when a name actually moved. Rewriting it on every save would be harmless but would
        // make the audit trail claim the search key changed when nothing about the name did.
        ...(nameChanged ? { nameSearchLatin: latinSearchKey(fullNameAr, fullNameEn) } : {}),
        ...(phoneE164 === undefined ? {} : { phoneE164 }),
        ...(secondaryPhone === undefined ? {} : { secondaryPhone }),
        ...(input.gender === undefined ? {} : { gender: input.gender }),
        ...(input.dateOfBirth === undefined ? {} : { dateOfBirth: input.dateOfBirth }),
        ...(input.nationalId === undefined ? {} : { nationalId: input.nationalId }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.relationshipToContact === undefined
          ? {}
          : { relationshipToContact: input.relationshipToContact }),
      },
    });

    const updated = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
    return toProfile(updated);
  });
}

/**
 * Visit **metadata** for a patient, newest first. Never clinical content — see the module note.
 *
 * Returns an empty array for a patient in another tenant, for the same reason `getPatient` returns
 * null: the rows are not visible, so there is nothing to distinguish "no visits" from "not yours".
 * A caller that needs to tell those apart should call `getPatient` first, which is the only place
 * that distinction is drawn — and it draws it as 404, not 403.
 */
export async function listVisitHistory(ctx: CallerContext, patientId: string): Promise<VisitHistoryEntry[]> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) =>
    tx.$queryRaw<VisitHistoryEntry[]>`
      SELECT v.id,
             v.appointment_id    AS "appointmentId",
             v.created_at        AS "visitDate",
             v.doctor_id         AS "doctorId",
             u.full_name         AS "doctorName",
             s.name_ar           AS "serviceName",
             v.status::text      AS status,
             v.follow_up_date    AS "followUpDate"
        FROM visits v
        LEFT JOIN doctors d      ON d.id = v.doctor_id
        LEFT JOIN memberships m  ON m.id = d.membership_id
        LEFT JOIN users u        ON u.id = m.user_id
        LEFT JOIN appointments a ON a.id = v.appointment_id
        LEFT JOIN services s     ON s.id = a.service_id
       WHERE v.tenant_id = ${ctx.tenantId}::uuid
         AND v.patient_id = ${patientId}::uuid
       ORDER BY v.created_at DESC
    `,
  );
}

/**
 * Every appointment this patient has had or has coming, newest first.
 *
 * **Scheduling facts only, and it must never grow clinical ones.** `complaint_summary` and
 * `booking_notes` are deliberately absent even though they sit on `appointments`: a complaint is
 * something the patient said about their body, and this endpoint is `patients.write` — reachable by
 * reception. `clinical-leak-guard.integration.spec.ts` sweeps it for exactly that reason.
 *
 * Distinct from `listVisitHistory()`, which is the *visits* a doctor recorded. An appointment that
 * was cancelled or no-showed has no visit and would vanish from that list, while being precisely
 * what reception needs to see when a patient says "but I came last Tuesday".
 */
export async function listAppointmentHistory(
  ctx: CallerContext,
  patientId: string,
): Promise<AppointmentHistoryEntry[]> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) =>
    tx.$queryRaw<AppointmentHistoryEntry[]>`
      SELECT a.id,
             a.scheduled_start AS "scheduledStart",
             a.status::text    AS status,
             a.source::text    AS source,
             a.doctor_id       AS "doctorId",
             u.full_name       AS "doctorName",
             s.name_ar         AS "serviceName"
        FROM appointments a
        LEFT JOIN doctors d     ON d.id = a.doctor_id
        LEFT JOIN memberships m ON m.id = d.membership_id
        LEFT JOIN users u       ON u.id = m.user_id
        LEFT JOIN services s    ON s.id = a.service_id
       WHERE a.tenant_id = ${ctx.tenantId}::uuid
         AND a.patient_id = ${patientId}::uuid
       ORDER BY a.scheduled_start DESC
    `,
  );
}

/**
 * What the patient still owes.
 *
 * The sum is done by Postgres, over the `visit_charge_balances` view. Nothing here subtracts
 * anything — see the note on `OutstandingBalance` and D7 as amended 2026-09-03.
 *
 * It read `sum(payments.remaining_minor)` until Phase 5 PR 5 removed that column: a balance is a
 * sum across payment rows now, which a generated column cannot express. The rule is unchanged and
 * the source of the derived number moved with it.
 */
export async function getOutstandingBalance(
  ctx: CallerContext,
  patientId: string,
): Promise<OutstandingBalance> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const rows = await tx.$queryRaw<{ outstandingMinor: bigint | null; paymentCount: bigint }[]>`
      SELECT coalesce(sum(b.balance_minor), 0) AS "outstandingMinor",
             (SELECT count(*) FROM payments p
               WHERE p.tenant_id = ${ctx.tenantId}::uuid
                 AND p.patient_id = ${patientId}::uuid) AS "paymentCount"
        FROM visit_charge_balances b
       WHERE b.tenant_id = ${ctx.tenantId}::uuid
         AND b.patient_id = ${patientId}::uuid
    `;
    const row = rows[0];
    // `sum()` and `count()` come back as bigint; Number is safe here because minor units of an
    // Egyptian clinic's unpaid balance cannot approach 2^53.
    return {
      outstandingMinor: Number(row?.outstandingMinor ?? 0),
      paymentCount: Number(row?.paymentCount ?? 0),
    };
  });
}

/** One page of the patient book, plus what the caller needs to ask for the next one. */
export interface PatientPage {
  patients: RecentPatient[];
  /** Total matching rows, so the screen can say "60 of 200" rather than guessing at an end. */
  total: number;
}

/**
 * The insurer on a patient's row in the book, and whether that cover is live today.
 *
 * `null` on `RecentPatient.insurance` means **no policy is recorded**, which is a different fact
 * from a policy that has lapsed — reception asking "is this one covered" needs to tell those apart,
 * and an absent field cannot.
 */
export interface PatientInsuranceBadge {
  insurerName: string;
  standing: PolicyStanding;
}

export interface RecentPatient extends PatientSearchResult {
  /**
   * When this patient was last actually seen — the start of their most recent `COMPLETED`
   * appointment — or `null` for someone registered and not yet seen.
   *
   * `COMPLETED` rather than "most recent appointment" on purpose: a patient with a booking next
   * Tuesday has not been seen, and ordering the book by appointments that have not happened puts
   * the future at the top of a list whose whole purpose is "who was here recently".
   */
  lastSeenAt: Date | null;
  /**
   * The most relevant policy for this patient, or `null` when none is recorded.
   *
   * "Most relevant" is the one in force today when there is one, and otherwise the one that ended
   * most recently — because the desk question is "covered?" and, failing that, "were they, and how
   * recently". A patient may legitimately hold two policies at once (a government scheme alongside
   * an employer's, which the schema permits), and this field deliberately does **not** pick a
   * winner for billing: it is a badge on a list. The detail screen shows all of them.
   */
  insurance: PatientInsuranceBadge | null;
}


/**
 * The patient book, ordered by who was seen most recently — `PHASE-4.md`, founder's ruling of
 * 2026-09-03: reception answering a phone call about a balance should not have to open a booking
 * dialog and abandon it.
 *
 * **Deliberately not alphabetical.** `SCHEMA-DECISIONS.md` D19 settles that: under code-point
 * ordering Latin sorts entirely before Arabic, so a mixed list pins the handful of English-named
 * patients to the top and reads as a bug. Ordering by last seen sidesteps the collation question
 * rather than answering it, which is what that decision asks for — and it is also the more useful
 * order, since the patient who phones is usually one who was recently here.
 *
 * Patients never seen sort after everyone seen, most recently registered first, so a walk-in
 * registered this morning is near the top rather than lost at the end.
 */
export async function listRecentPatients(
  ctx: CallerContext,
  limit: number = DEFAULT_LIMIT,
  offset: number = 0,
  /**
   * The instant "covered today" is judged against.
   *
   * Passed in rather than read here, for the rule CLAUDE.md states: a policy's standing is a claim
   * about a day, and a boundary that reads its own clock cannot be tested at the boundary. The
   * clinic's timezone is read from the tenant row below, exactly as `getPatientCoverage` does —
   * it matters as much as the instant, because a policy expiring on the 30th is still in force in
   * Cairo for two hours after UTC has rolled over.
   */
  now: Date = new Date(),
): Promise<PatientPage> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    // Ties are broken by created_at and then id, so paging through the book cannot repeat or skip
    // a row: without a total order, two patients sharing a last-seen instant may come back in
    // either order on either page.
    const patients = await tx.$queryRaw<RecentPatientRow[]>`
      SELECT p.id,
             p.full_name_ar  AS "fullNameAr",
             p.full_name_en  AS "fullNameEn",
             p.phone_e164    AS "phoneE164",
             p.date_of_birth AS "dateOfBirth",
             -- Carried so the row can be judged complete (D26). Not rendered as fields.
             p.gender,
             p.nationality,
             p.status,
             (SELECT max(a.scheduled_start)
                FROM appointments a
               WHERE a.patient_id = p.id
                 AND a.status = 'COMPLETED') AS "lastSeenAt",
             -- The policy to badge this row with. Ordered so an in-force policy wins, and failing
             -- that the one that ended most recently. Sorting valid_to IS NULL first is deliberate:
             -- an open-ended policy has no end date and is the strongest claim to being current,
             -- not the weakest. Standing itself is decided in the domain below, never here --
             -- comparing dates in SQL would be a second implementation of standingOf().
             (SELECT ins.insurer_name
                FROM patient_insurance pi
                JOIN insurance_policies ins ON ins.id = pi.policy_id
               WHERE pi.patient_id = p.id
               ORDER BY (ins.valid_to IS NULL) DESC, ins.valid_to DESC NULLS FIRST, ins.valid_from DESC
               LIMIT 1) AS "insurerName",
             (SELECT ins.valid_from
                FROM patient_insurance pi
                JOIN insurance_policies ins ON ins.id = pi.policy_id
               WHERE pi.patient_id = p.id
               ORDER BY (ins.valid_to IS NULL) DESC, ins.valid_to DESC NULLS FIRST, ins.valid_from DESC
               LIMIT 1) AS "insuranceValidFrom",
             (SELECT ins.valid_to
                FROM patient_insurance pi
                JOIN insurance_policies ins ON ins.id = pi.policy_id
               WHERE pi.patient_id = p.id
               ORDER BY (ins.valid_to IS NULL) DESC, ins.valid_to DESC NULLS FIRST, ins.valid_from DESC
               LIMIT 1) AS "insuranceValidTo"
        FROM patients p
       WHERE p.tenant_id = ${ctx.tenantId}::uuid
       ORDER BY "lastSeenAt" DESC NULLS LAST, p.created_at DESC, p.id DESC
       LIMIT ${limit} OFFSET ${offset}
    `;

    const totals = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM patients WHERE tenant_id = ${ctx.tenantId}::uuid
    `;

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId },
      select: { timezone: true },
    });
    const today = calendarDayIn(now, tenant.timezone);

    return {
      patients: patients.map(({ insurerName, insuranceValidFrom, insuranceValidTo, ...row }) => ({
        ...row,
        missingIntakeFields: missingIntakeFields(row),
        insurance:
          insurerName === null || insuranceValidFrom === null
            ? null
            : {
                insurerName,
                standing: standingOf(
                  {
                    validFrom: asDay(insuranceValidFrom),
                    validTo: insuranceValidTo === null ? null : asDay(insuranceValidTo),
                  },
                  today,
                ),
              },
      })),
      total: Number(totals[0]?.total ?? 0),
    };
  });
}

/** The raw shape the query returns, before the badge is assembled from its three flat columns. */
/** `missingIntakeFields` is omitted because the query cannot produce it — it is derived below. */
interface RecentPatientRow extends Omit<RecentPatient, "insurance" | "missingIntakeFields"> {
  gender: string | null;
  nationality: string | null;
  insurerName: string | null;
  insuranceValidFrom: Date | null;
  insuranceValidTo: Date | null;
}

/** `DATE` columns arrive as `Date` at UTC midnight; the calendar day is the whole of their content. */
function asDay(value: Date): CalendarDay {
  return value.toISOString().slice(0, 10);
}
