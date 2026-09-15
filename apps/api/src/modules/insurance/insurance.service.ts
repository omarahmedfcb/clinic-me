import { randomUUID } from "node:crypto";
import type { PatientRelationship } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { calendarDayIn } from "../appointments/domain/zoned-time.ts";
import { standingOf, type CalendarDay, type PolicyStanding } from "./domain/policy-window.ts";

/**
 * Patient insurance — the service. `PHASE-3.md` Q18, `prisma/sql/21-patient-insurance.sql`.
 *
 * **The policy, not the claim.** Recording and tracking insurer responses is Phase 5, ruled:
 * Egyptian insurers offer a portal each plus paper, so modelling a claim now would build an
 * integration nobody can use. This module answers one question — *is this patient covered today,
 * and by what* — plus the history behind it.
 *
 * Refusals are values with machine-readable reasons rather than framework exceptions, the same
 * shape as `transfers.service.ts`, so the AI tool layer can call these functions without catching
 * HTTP errors.
 */

export type InsuranceRefusalReason =
  | "NOT_FOUND"
  | "NO_CONTACT_RECORD"
  | "INVALID_WINDOW"
  | "DUPLICATE_POLICY";

export type InsuranceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: InsuranceRefusalReason; params: RefusalParams };

export interface CoverageView {
  /** The `patient_insurance` row — what you delete to end a patient's link to a policy. */
  coverageId: string;
  policyId: string;
  insurerName: string;
  policyNumber: string;
  policyholderName: string;
  relationshipToPolicyholder: PatientRelationship;
  validFrom: CalendarDay;
  validTo: CalendarDay | null;
  /** Derived on every read, never stored. See `domain/policy-window.ts`. */
  standing: PolicyStanding;
}

/**
 * What the patient detail screen and the check-in panel both render.
 *
 * Partitioned rather than returned as one list with a flag, because the founder's ruling is about
 * *prominence*: the active policy answers "is this patient covered today" and belongs at the top,
 * and lapsed cover is collapsed history below it — **shown, not hidden**, because a patient whose
 * cover ended last month is a conversation reception has to have, and a screen that says only "no
 * active policy" invites the reader to assume there never was one.
 *
 * `active` is a list, not a single value. A patient may genuinely hold two policies at once — a
 * government scheme alongside an employer's — and the schema deliberately permits it. The screen
 * shows what it finds rather than picking a winner, because picking one would be this system
 * deciding which insurer to bill, which is not its decision to make.
 */
export interface PatientCoverage {
  /** The day the question was asked, on the clinic's calendar. Echoed so a screen can say "as of". */
  asOf: CalendarDay;
  active: CoverageView[];
  /** Ended before `asOf`, newest first. */
  lapsed: CoverageView[];
  /** Starts after `asOf`. Not lapsed, and not a reason to refuse cover today — see the domain note. */
  future: CoverageView[];
}

export interface InsuranceCaller {
  tenantId: string;
  actor: ActorContext;
}

/** `DATE` columns arrive as `Date` at UTC midnight; the calendar day is the whole of their content. */
function asDay(value: Date): CalendarDay {
  return value.toISOString().slice(0, 10);
}

interface CoverageRow {
  id: string;
  relationshipToPolicyholder: PatientRelationship;
  policy: {
    id: string;
    insurerName: string;
    policyNumber: string;
    policyholderName: string;
    validFrom: Date;
    validTo: Date | null;
  };
}

function toView(row: CoverageRow, onDay: CalendarDay): CoverageView {
  const validFrom = asDay(row.policy.validFrom);
  const validTo = row.policy.validTo === null ? null : asDay(row.policy.validTo);
  return {
    coverageId: row.id,
    policyId: row.policy.id,
    insurerName: row.policy.insurerName,
    policyNumber: row.policy.policyNumber,
    policyholderName: row.policy.policyholderName,
    relationshipToPolicyholder: row.relationshipToPolicyholder,
    validFrom,
    validTo,
    standing: standingOf({ validFrom, validTo }, onDay),
  };
}

const COVERAGE_INCLUDE = {
  policy: {
    select: {
      id: true,
      insurerName: true,
      policyNumber: true,
      policyholderName: true,
      validFrom: true,
      validTo: true,
    },
  },
} as const;

/**
 * Every policy this patient is on, partitioned by standing on the clinic's calendar day.
 *
 * `now` is a parameter and the tenant's timezone comes from the row, never a literal — `CLAUDE.md`
 * forbids `Africa/Cairo` outside seed data, and the distinction is real rather than pedantic: a
 * policy lapsing on the 31st is still valid at 01:00 Cairo on the 31st, which is 23:00 UTC on the
 * 30th. Answering that question in UTC would deny cover for the last two hours of every policy.
 */
export async function getPatientCoverage(
  caller: InsuranceCaller,
  patientId: string,
  now: Date,
): Promise<PatientCoverage | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Fetched first so an unknown or other-tenant patient is `null` -> 404, rather than an empty
    // coverage list. An empty list is a different and wrong answer: it asserts "this patient has no
    // insurance", which is a statement about a patient the caller cannot see.
    const patient = await tx.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (patient === null) return null;

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: caller.tenantId },
      select: { timezone: true },
    });
    const onDay = calendarDayIn(now, tenant.timezone);

    const rows = await tx.patientInsurance.findMany({
      where: { patientId },
      include: COVERAGE_INCLUDE,
      orderBy: { policy: { validFrom: "desc" } },
    });

    const views = rows.map((row) => toView(row as CoverageRow, onDay));
    return {
      asOf: onDay,
      active: views.filter((view) => view.standing === "ACTIVE"),
      lapsed: views.filter((view) => view.standing === "LAPSED"),
      future: views.filter((view) => view.standing === "FUTURE"),
    };
  });
}

export interface RecordCoverageInput {
  insurerName: string;
  /** The registry row this policy names, when the clinic has one (Phase 5 PR 1). */
  companyId?: string | null;
  planName?: string | null;
  isPrimary?: boolean;
  policyNumber: string;
  policyholderName: string;
  validFrom: CalendarDay;
  validTo: CalendarDay | null;
  relationshipToPolicyholder: PatientRelationship;
}

/**
 * Records cover for a patient, reusing the household's policy if it is already known.
 *
 * **The policy is found or created by `(insurerName, policyNumber)`, never blindly inserted.** That
 * is the schema's `(tenant_id, insurer_name, policy_number)` unique index expressed as behaviour:
 * one phone, several patients, one policy. Registering a mother and then her two children under the
 * same card produces one `insurance_policies` row and three `patient_insurance` rows, so correcting
 * a mistyped policy number later corrects it for the whole family rather than for whichever member
 * reception happened to open.
 *
 * The policy hangs off the patient's `contact`. A patient with no contact row cannot be put on a
 * household policy, which is refused rather than worked around — inventing a contact here would
 * create a household of one that nothing else knows about.
 */
export async function recordCoverage(
  caller: InsuranceCaller,
  patientId: string,
  input: RecordCoverageInput,
): Promise<InsuranceResult<CoverageView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const patient = await tx.patient.findUnique({
      where: { id: patientId },
      select: { id: true, contactId: true },
    });
    if (patient === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "patient" } as const,
      };
    }
    if (patient.contactId === null) {
      return {
        ok: false as const,
        // NOT a NOT_FOUND: the patient exists. It asks for a different action -- go and add
        // contact details -- so by the ruling it earns its own code.
        code: "NO_CONTACT_RECORD" as const,
        params: {},
      };
    }

    // Checked here as well as by the CHECK constraint, so the desk gets a sentence rather than a
    // constraint violation. The constraint is what makes it impossible; this is what makes it
    // readable -- the same division as the transfer module's ALREADY_OPEN.
    if (input.validTo !== null && input.validTo < input.validFrom) {
      return {
        ok: false as const,
        code: "INVALID_WINDOW" as const,
        params: {},
      };
    }

    // **A named company must belong to this clinic, and this lookup is what enforces it.** The
    // foreign key is not tenant-scoped -- it accepts any companies row -- so without this a
    // receptionist could attach another clinic's insurer by id. Read through the tenant extension,
    // so another tenant's company is indistinguishable from a missing one: 404, never 403.
    if (input.companyId != null) {
      const company = await tx.insuranceCompany.findFirst({
        where: { id: input.companyId },
        select: { id: true },
      });
      if (company === null) {
        return {
          ok: false as const,
          code: "NOT_FOUND" as const,
          params: { resource: "insuranceCompany" } as const,
        };
      }
    }

    const existing = await tx.insurancePolicy.findFirst({
      where: { insurerName: input.insurerName, policyNumber: input.policyNumber },
      select: { id: true, contactId: true },
    });

    let policyId: string;
    if (existing === null) {
      policyId = randomUUID();
      await tx.insurancePolicy.create({
        data: injected({
          id: policyId,
          contactId: patient.contactId,
          insurerName: input.insurerName,
          companyId: input.companyId ?? null,
          planName: input.planName ?? null,
          policyNumber: input.policyNumber,
          policyholderName: input.policyholderName,
          validFrom: new Date(`${input.validFrom}T00:00:00Z`),
          validTo: input.validTo === null ? null : new Date(`${input.validTo}T00:00:00Z`),
        }),
      });
    } else {
      policyId = existing.id;
    }

    const already = await tx.patientInsurance.findFirst({
      where: { patientId, policyId },
      select: { id: true },
    });
    if (already !== null) {
      return {
        ok: false as const,
        code: "DUPLICATE_POLICY" as const,
        params: {},
      };
    }

    const coverageId = randomUUID();
    await tx.patientInsurance.create({
      data: injected({
        id: coverageId,
        patientId,
        policyId,
        relationshipToPolicyholder: input.relationshipToPolicyholder,
        // Default false: the partial unique index allows one primary per patient, and silently
        // promoting a second policy would demote the first without anyone asking for it.
        isPrimary: input.isPrimary ?? false,
      }),
    });

    const row = await tx.patientInsurance.findFirstOrThrow({
      where: { id: coverageId },
      include: COVERAGE_INCLUDE,
    });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: caller.tenantId },
      select: { timezone: true },
    });
    return { ok: true as const, value: toView(row as CoverageRow, calendarDayIn(new Date(), tenant.timezone)) };
  });
}

export interface UpdatePolicyInput {
  insurerName?: string;
  policyNumber?: string;
  policyholderName?: string;
  validFrom?: CalendarDay;
  validTo?: CalendarDay | null;
}

/**
 * Corrects a policy's details. Reception's edit path for the insurance block.
 *
 * **Edits the policy, which is shared.** Correcting a mistyped number fixes it for every patient on
 * that card, which is the point of the shared row — the alternative is four spellings of one policy
 * that drift apart. The audit trigger records both spellings as whole-row JSON, which is what the
 * founder asked for when he asked that an edit to a patient's cover be traceable.
 */
export async function updatePolicy(
  caller: InsuranceCaller,
  policyId: string,
  input: UpdatePolicyInput,
): Promise<InsuranceResult<{ policyId: string }>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.insurancePolicy.findUnique({
      where: { id: policyId },
      select: { id: true, validFrom: true, validTo: true },
    });
    if (existing === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "policy" } as const,
      };
    }

    // Validated against the *post-update* window, not the incoming patch: moving only `validFrom`
    // past an unchanged `validTo` is exactly the mistake the CHECK exists for, and checking the
    // patch alone would miss it.
    const validFrom = input.validFrom ?? asDay(existing.validFrom);
    const validTo =
      input.validTo === undefined
        ? existing.validTo === null
          ? null
          : asDay(existing.validTo)
        : input.validTo;
    if (validTo !== null && validTo < validFrom) {
      return {
        ok: false as const,
        // The same code as the create path. The two sentences differed only in tense, which is
        // a distinction the screen already knows and the user does not need spelled out twice.
        code: "INVALID_WINDOW" as const,
        params: {},
      };
    }

    await tx.insurancePolicy.update({
      where: { id: policyId },
      data: {
        ...(input.insurerName === undefined ? {} : { insurerName: input.insurerName }),
        ...(input.policyNumber === undefined ? {} : { policyNumber: input.policyNumber }),
        ...(input.policyholderName === undefined ? {} : { policyholderName: input.policyholderName }),
        ...(input.validFrom === undefined ? {} : { validFrom: new Date(`${input.validFrom}T00:00:00Z`) }),
        ...(input.validTo === undefined
          ? {}
          : { validTo: input.validTo === null ? null : new Date(`${input.validTo}T00:00:00Z`) }),
      },
    });

    return { ok: true as const, value: { policyId } };
  });
}

/**
 * Removes a patient from a policy.
 *
 * Deletes the `patient_insurance` join row only, never the policy — the policy may still cover the
 * rest of the household. This is also **not** a medical or financial record, so `CLAUDE.md`'s
 * never-hard-delete rule does not reach it: it is a statement that this person is on this card,
 * and the honest correction to "they never were" is removal. The audit trigger keeps the row's
 * whole prior state, so the deletion itself remains accountable.
 */
export async function removeCoverage(
  caller: InsuranceCaller,
  coverageId: string,
): Promise<InsuranceResult<{ coverageId: string }>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.patientInsurance.findUnique({
      where: { id: coverageId },
      select: { id: true },
    });
    if (existing === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "coverage" } as const,
      };
    }
    await tx.patientInsurance.delete({ where: { id: coverageId } });
    return { ok: true as const, value: { coverageId } };
  });
}
