// The clinic's insurance company registry — `PHASE-5-PLAN.md` PR 1, from Phase 4's withdrawn 7c.
// No coverage rate and no copay: the payer split is manual until real policies have been seen.

import { randomUUID } from "node:crypto";
import type { ClaimSubmissionMethod, InsuranceCompanyType } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

export type CompanyRefusalReason = "NOT_FOUND" | "DUPLICATE_COMPANY" | "INVALID_WINDOW";

export type CompanyResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CompanyRefusalReason; params: RefusalParams };

export interface InsuranceCompanyView {
  id: string;
  name: string;
  type: InsuranceCompanyType;
  contractNumber: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  claimSubmissionMethod: ClaimSubmissionMethod | null;
  paymentTermsDays: number | null;
  priorApprovalRequired: boolean;
  isActive: boolean;
}

export interface CompanyInput {
  name: string;
  type: InsuranceCompanyType;
  contractNumber?: string | null;
  contractStart?: string | null;
  contractEnd?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  claimSubmissionMethod?: ClaimSubmissionMethod | null;
  paymentTermsDays?: number | null;
  priorApprovalRequired?: boolean;
  isActive?: boolean;
}

const COLUMNS = {
  id: true,
  name: true,
  type: true,
  contractNumber: true,
  contractStart: true,
  contractEnd: true,
  contactPerson: true,
  phone: true,
  email: true,
  claimSubmissionMethod: true,
  paymentTermsDays: true,
  priorApprovalRequired: true,
  isActive: true,
} as const;

interface Row {
  id: string;
  name: string;
  type: InsuranceCompanyType;
  contractNumber: string | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  claimSubmissionMethod: ClaimSubmissionMethod | null;
  paymentTermsDays: number | null;
  priorApprovalRequired: boolean;
  isActive: boolean;
}

/** A DATE column arrives as UTC midnight; sliced rather than formatted, so it stays a calendar day. */
const day = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const view = (row: Row): InsuranceCompanyView => ({
  ...row,
  contractStart: day(row.contractStart),
  contractEnd: day(row.contractEnd),
});

/** `${day}T00:00:00Z`, so a DATE column receives the day that was typed rather than that day shifted. */
const dateValue = (value: string | null | undefined): Date | null =>
  value === null || value === undefined || value === "" ? null : new Date(`${value}T00:00:00.000Z`);

export async function listInsuranceCompanies(
  caller: { tenantId: string; actor: ActorContext },
  includeInactive: boolean,
): Promise<InsuranceCompanyView[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.insuranceCompany.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: COLUMNS,
      orderBy: { name: "asc" },
    });
    return rows.map(view);
  });
}

/**
 * The registry rows a policy may name.
 *
 * Deliberately a separate read from the list above and not a flag on it: this one is what reception
 * picks from, so it never offers a company the clinic has deactivated, and an admin looking at the
 * registry must still be able to see one.
 */
export async function selectableInsuranceCompanies(caller: {
  tenantId: string;
  actor: ActorContext;
}): Promise<{ id: string; name: string }[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) =>
    tx.insuranceCompany.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
}

function windowIsOrdered(input: CompanyInput): boolean {
  const start = dateValue(input.contractStart);
  const end = dateValue(input.contractEnd);
  return start === null || end === null || end.getTime() >= start.getTime();
}

export async function createInsuranceCompany(
  caller: { tenantId: string; actor: ActorContext },
  input: CompanyInput,
): Promise<CompanyResult<InsuranceCompanyView>> {
  if (!windowIsOrdered(input)) {
    return { ok: false, code: "INVALID_WINDOW", params: {} };
  }

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Case-folded, matching the unique index: "MedNet" and "MEDNET" typed by two receptionists are
    // one company, and two rows would split a clinic's policies across both.
    const clash = await tx.insuranceCompany.findFirst({
      where: { name: { equals: input.name.trim(), mode: "insensitive" } },
      select: { id: true },
    });
    if (clash !== null) {
      return { ok: false as const, code: "DUPLICATE_COMPANY" as const, params: { name: input.name.trim() } };
    }

    const row = await tx.insuranceCompany.create({
      data: injected({
        id: randomUUID(),
        name: input.name.trim(),
        type: input.type,
        contractNumber: input.contractNumber ?? null,
        contractStart: dateValue(input.contractStart),
        contractEnd: dateValue(input.contractEnd),
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        claimSubmissionMethod: input.claimSubmissionMethod ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        priorApprovalRequired: input.priorApprovalRequired ?? false,
        isActive: input.isActive ?? true,
      }),
      select: COLUMNS,
    });
    return { ok: true as const, value: view(row) };
  });
}

/** A patch: an omitted field is left alone, and `null` clears one. */
export async function updateInsuranceCompany(
  caller: { tenantId: string; actor: ActorContext },
  companyId: string,
  patch: Partial<CompanyInput>,
): Promise<CompanyResult<InsuranceCompanyView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.insuranceCompany.findFirst({
      where: { id: companyId },
      select: COLUMNS,
    });
    // 404 and not 403 for a company in another clinic: the tenant extension has already made a
    // cross-tenant id indistinguishable from a missing one, which is the rule (CLAUDE.md).
    if (existing === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "insuranceCompany" } };
    }

    const merged = { ...view(existing), ...patch };
    if (!windowIsOrdered(merged)) {
      return { ok: false as const, code: "INVALID_WINDOW" as const, params: {} };
    }

    if (patch.name !== undefined) {
      const clash = await tx.insuranceCompany.findFirst({
        where: { name: { equals: patch.name.trim(), mode: "insensitive" }, id: { not: companyId } },
        select: { id: true },
      });
      if (clash !== null) {
        return { ok: false as const, code: "DUPLICATE_COMPANY" as const, params: { name: patch.name.trim() } };
      }
    }

    const row = await tx.insuranceCompany.update({
      where: { id: companyId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(patch.contractNumber === undefined ? {} : { contractNumber: patch.contractNumber }),
        ...(patch.contractStart === undefined ? {} : { contractStart: dateValue(patch.contractStart) }),
        ...(patch.contractEnd === undefined ? {} : { contractEnd: dateValue(patch.contractEnd) }),
        ...(patch.contactPerson === undefined ? {} : { contactPerson: patch.contactPerson }),
        ...(patch.phone === undefined ? {} : { phone: patch.phone }),
        ...(patch.email === undefined ? {} : { email: patch.email }),
        ...(patch.claimSubmissionMethod === undefined
          ? {}
          : { claimSubmissionMethod: patch.claimSubmissionMethod }),
        ...(patch.paymentTermsDays === undefined ? {} : { paymentTermsDays: patch.paymentTermsDays }),
        ...(patch.priorApprovalRequired === undefined
          ? {}
          : { priorApprovalRequired: patch.priorApprovalRequired }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      },
      select: COLUMNS,
    });
    return { ok: true as const, value: view(row) };
  });
}
