// The client file — contacts, sales owner, contracts, agreed commercials, notes, and the account's
// commercial state. The vendor's data about a clinic; RLS keeps the clinic itself out of it.

import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { prisma } from "../../prisma/client.ts";
import { withPlatformActor, type ActorContext } from "../../prisma/with-tenant.ts";
import { normalisePhone } from "../auth/phone.ts";
import { contractKeyFor } from "./contract-key.ts";
import type { SupportedCountry } from "./new-clinic.ts";

/** TRIAL | ACTIVE | OVERDUE | SUSPENDED, mirroring the CHECK. A fifth is a migration. */
export const ACCOUNT_STATUSES = ["TRIAL", "ACTIVE", "OVERDUE", "SUSPENDED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const isAccountStatus = (value: string): value is AccountStatus =>
  (ACCOUNT_STATUSES as readonly string[]).includes(value);

/**
 * How far ahead the console warns that a renewal is coming — the founder's ruling of 2026-09-15.
 *
 * Fourteen days is long enough to have the conversation and short enough that the flag still means
 * something when it appears. One constant, read by the list and by the client file alike.
 */
export const RENEWAL_REMINDER_DAYS = 14;

export type ClientFileRefusal =
  | "NOT_FOUND"
  | "INVALID_AMOUNT"
  | "INVALID_DATE_RANGE"
  | "INVALID_PHONE"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "EMPTY_FILE";

export type ClientFileResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ClientFileRefusal; params: RefusalParams };

export interface ClientFile {
  tenantId: string;
  salesOwnerUserId: string | null;
  salesOwnerName: string | null;
  agreedPlan: string | null;
  agreedMonthlyMinor: number | null;
  discountPercent: number | null;
  accountStatus: string;
  trialEndsOn: string | null;
  renewalOn: string | null;
  notes: string | null;
  contacts: {
    id: string;
    fullName: string;
    role: string | null;
    phoneE164: string | null;
    email: string | null;
  }[];
  contracts: {
    id: string;
    fileName: string;
    sizeBytes: number;
    startsOn: string;
    endsOn: string;
    uploadedAt: string;
  }[];
}

/** A `DATE` column as `YYYY-MM-DD`, with no timezone in the middle of it. */
const asDay = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));

/**
 * Whole days from `today` to `on`, or null when there is no date.
 *
 * `today` is a parameter and never the clock: a countdown that reads `new Date()` inside makes a
 * test that pins "14 days out" pass on one day of the month and fail on another, which is the
 * failure `CLAUDE.md` names about anything called reproducible.
 */
export function daysUntil(on: Date | null, today: Date): number | null {
  if (on === null) return null;
  const DAY = 24 * 60 * 60 * 1000;
  const from = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const to = Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
  return Math.round((to - from) / DAY);
}

/** Whether a renewal is inside the reminder window — including one already past. */
export const renewalIsDue = (days: number | null): boolean =>
  days !== null && days <= RENEWAL_REMINDER_DAYS;

/** The commercial state of every clinic at once, for the list. Keyed by tenant id. */
export async function accountStatesFor(
  actor: ActorContext,
  today: Date,
): Promise<Map<string, { accountStatus: string; renewalOn: string | null; renewalInDays: number | null; renewalDue: boolean }>> {
  const files = await withPlatformActor(actor, (tx) =>
    tx.platformClinicFile.findMany({
      select: { tenantId: true, accountStatus: true, renewalOn: true },
    }),
  );

  return new Map(
    files.map((file) => {
      const days = daysUntil(file.renewalOn, today);
      return [
        file.tenantId,
        {
          accountStatus: file.accountStatus,
          renewalOn: asDay(file.renewalOn),
          renewalInDays: days,
          renewalDue: renewalIsDue(days),
        },
      ];
    }),
  );
}

/** The whole file for one clinic. Creates nothing: a clinic with no file reads as an empty one. */
export async function readClientFile(actor: ActorContext, tenantId: string): Promise<ClientFileResult<ClientFile>> {
  return withPlatformActor<ClientFileResult<ClientFile>>(actor, async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true } });
    if (tenant === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } };
    }

    const [file, contacts, contracts] = await Promise.all([
      tx.platformClinicFile.findFirst({
        where: { tenantId },
        include: { salesOwner: { select: { fullName: true } } },
      }),
      tx.platformClinicContact.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
      tx.platformClinicContract.findMany({ where: { tenantId }, orderBy: { startsOn: "desc" } }),
    ]);

    return {
      ok: true as const,
      value: {
        tenantId,
        salesOwnerUserId: file?.salesOwnerUserId ?? null,
        salesOwnerName: file?.salesOwner?.fullName ?? null,
        agreedPlan: file?.agreedPlan ?? null,
        agreedMonthlyMinor: file?.agreedMonthlyMinor ?? null,
        discountPercent: file?.discountPercent ?? null,
        accountStatus: file?.accountStatus ?? "TRIAL",
        trialEndsOn: asDay(file?.trialEndsOn ?? null),
        renewalOn: asDay(file?.renewalOn ?? null),
        notes: file?.notes ?? null,
        contacts: contacts.map((contact) => ({
          id: contact.id,
          fullName: contact.fullName,
          role: contact.role,
          phoneE164: contact.phoneE164,
          email: contact.email,
        })),
        contracts: contracts.map((contract) => ({
          id: contract.id,
          fileName: contract.fileName,
          sizeBytes: contract.sizeBytes,
          startsOn: asDay(contract.startsOn) ?? "",
          endsOn: asDay(contract.endsOn) ?? "",
          uploadedAt: contract.createdAt.toISOString(),
        })),
      },
    };
  });
}

export interface ClientFileEdit {
  salesOwnerUserId?: string | null;
  agreedPlan?: string | null;
  agreedMonthlyMinor?: number | null;
  discountPercent?: number | null;
  accountStatus?: AccountStatus;
  trialEndsOn?: string | null;
  renewalOn?: string | null;
  notes?: string | null;
}

/** `YYYY-MM-DD` as a UTC midnight, or null. Returns undefined for a string that is not a date. */
function asDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Writes the file, creating it on first save.
 *
 * Every field is optional and `undefined` means "leave it": two operators editing different halves
 * of the same file must not overwrite each other with blanks, which is what a whole-object PUT does
 * when the client sends a field it never displayed.
 */
export async function saveClientFile(
  actor: ActorContext,
  tenantId: string,
  edit: ClientFileEdit,
): Promise<ClientFileResult<{ tenantId: string }>> {
  if (edit.agreedMonthlyMinor !== undefined && edit.agreedMonthlyMinor !== null && edit.agreedMonthlyMinor < 0) {
    return { ok: false, code: "INVALID_AMOUNT", params: { field: "agreedMonthlyMinor" } };
  }
  if (
    edit.discountPercent !== undefined &&
    edit.discountPercent !== null &&
    (edit.discountPercent < 0 || edit.discountPercent > 100)
  ) {
    return { ok: false, code: "INVALID_AMOUNT", params: { field: "discountPercent" } };
  }

  const trialEndsOn = asDate(edit.trialEndsOn);
  if (trialEndsOn === undefined && edit.trialEndsOn !== undefined) {
    return { ok: false, code: "INVALID_DATE_RANGE", params: { field: "startsOn" } };
  }
  const renewalOn = asDate(edit.renewalOn);
  if (renewalOn === undefined && edit.renewalOn !== undefined) {
    return { ok: false, code: "INVALID_DATE_RANGE", params: { field: "renewalOn" } };
  }

  return withPlatformActor<ClientFileResult<{ tenantId: string }>>(actor, async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true } });
    if (tenant === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } };
    }

    const existing = await tx.platformClinicFile.findFirst({ where: { tenantId }, select: { id: true } });

    // Only the keys actually supplied reach the database, so an untouched field keeps its value.
    const data = {
      ...(edit.salesOwnerUserId === undefined ? {} : { salesOwnerUserId: edit.salesOwnerUserId }),
      ...(edit.agreedPlan === undefined ? {} : { agreedPlan: edit.agreedPlan }),
      ...(edit.agreedMonthlyMinor === undefined ? {} : { agreedMonthlyMinor: edit.agreedMonthlyMinor }),
      ...(edit.discountPercent === undefined ? {} : { discountPercent: edit.discountPercent }),
      ...(edit.accountStatus === undefined ? {} : { accountStatus: edit.accountStatus }),
      ...(trialEndsOn === undefined ? {} : { trialEndsOn }),
      ...(renewalOn === undefined ? {} : { renewalOn }),
      ...(edit.notes === undefined ? {} : { notes: edit.notes }),
    };

    if (existing === null) {
      await tx.platformClinicFile.create({ data: { id: uuidv7(), tenantId, ...data } });
    } else {
      await tx.platformClinicFile.update({ where: { id: existing.id }, data });
    }

    return { ok: true as const, value: { tenantId } };
  });
}

export async function addContact(
  actor: ActorContext,
  tenantId: string,
  input: { fullName: string; role?: string; phone?: string; email?: string },
): Promise<ClientFileResult<{ id: string }>> {
  const country = await withPlatformActor(actor, (tx) =>
    tx.tenant.findFirst({ where: { id: tenantId }, select: { country: true } }),
  );
  if (country === null) return { ok: false, code: "NOT_FOUND", params: { resource: "clinic" } };

  // The clinic's own country as the hint, §18b — the same rule the console's create form follows.
  const phoneE164 =
    input.phone === undefined || input.phone.trim() === ""
      ? null
      : normalisePhone(input.phone, country.country as SupportedCountry);
  if (input.phone !== undefined && input.phone.trim() !== "" && phoneE164 === null) {
    return { ok: false, code: "INVALID_PHONE", params: { field: "contactPhone" } };
  }

  const email = input.email === undefined || input.email.trim() === "" ? null : input.email.trim();
  if (phoneE164 === null && email === null) {
    return { ok: false, code: "INVALID_PHONE", params: { field: "contactPhone" } };
  }

  const id = uuidv7();
  await withPlatformActor(actor, (tx) =>
    tx.platformClinicContact.create({
      data: {
        id,
        tenantId,
        fullName: input.fullName,
        role: input.role ?? null,
        phoneE164,
        email,
      },
    }),
  );
  return { ok: true, value: { id } };
}

export async function removeContact(
  actor: ActorContext,
  tenantId: string,
  contactId: string,
): Promise<ClientFileResult<{ id: string }>> {
  return withPlatformActor<ClientFileResult<{ id: string }>>(actor, async (tx) => {
    const contact = await tx.platformClinicContact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true },
    });
    if (contact === null) return { ok: false as const, code: "NOT_FOUND" as const, params: {} };

    // Deleted, not archived: a contact is not a medical or financial record, and CLAUDE.md's
    // never-hard-delete rule is about those. The audit trigger keeps the row's last state anyway.
    await tx.platformClinicContact.delete({ where: { id: contactId } });
    return { ok: true as const, value: { id: contactId } };
  });
}

/** Contracts are PDFs. One type, checked against the bytes as well as the claim. */
export const CONTRACT_MIME = "application/pdf";
export const MAX_CONTRACT_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = Buffer.from("%PDF-");

export async function addContract(
  actor: ActorContext,
  tenantId: string,
  input: {
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    startsOn: string;
    endsOn: string;
  },
  put: (key: string, bytes: Buffer) => Promise<void>,
): Promise<ClientFileResult<{ id: string }>> {
  if (input.bytes.length === 0) return { ok: false, code: "EMPTY_FILE", params: {} };
  if (input.bytes.length > MAX_CONTRACT_BYTES) {
    return { ok: false, code: "TOO_LARGE", params: { limit: MAX_CONTRACT_BYTES, actual: input.bytes.length } };
  }
  // The declared type and the bytes must agree. A renamed `.exe` is the case this is for, and the
  // attachments module already refuses on the same basis.
  if (input.mimeType !== CONTRACT_MIME || !input.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return { ok: false, code: "UNSUPPORTED_TYPE", params: { claimed: input.mimeType, detected: "unknown" } };
  }

  const startsOn = asDate(input.startsOn);
  const endsOn = asDate(input.endsOn);
  if (startsOn === undefined || startsOn === null) {
    return { ok: false, code: "INVALID_DATE_RANGE", params: { field: "startsOn" } };
  }
  if (endsOn === undefined || endsOn === null || endsOn <= startsOn) {
    return { ok: false, code: "INVALID_DATE_RANGE", params: { field: "endsOn" } };
  }

  const tenant = await withPlatformActor(actor, (tx) =>
    tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true } }),
  );
  if (tenant === null) return { ok: false, code: "NOT_FOUND", params: { resource: "clinic" } };

  const id = uuidv7();
  const storageKey = contractKeyFor({ tenantId, contractId: id });

  // Bytes first: a row pointing at an object that was never written is the worse of the two
  // half-states, because the file reads as present and downloads as a 404.
  await put(storageKey, input.bytes);

  await withPlatformActor(actor, (tx) =>
    tx.platformClinicContract.create({
      data: {
        id,
        tenantId,
        fileName: input.fileName,
        storageKey,
        mimeType: CONTRACT_MIME,
        sizeBytes: input.bytes.length,
        startsOn,
        endsOn,
        uploadedByUserId: actor.userId,
      },
    }),
  );

  return { ok: true, value: { id } };
}

/** The stored object for one contract, for streaming back through the API. Never a URL. */
export async function readContract(
  actor: ActorContext,
  tenantId: string,
  contractId: string,
): Promise<ClientFileResult<{ fileName: string; storageKey: string }>> {
  const contract = await withPlatformActor(actor, (tx) =>
    tx.platformClinicContract.findFirst({
      where: { id: contractId, tenantId },
      select: { fileName: true, storageKey: true },
    }),
  );
  if (contract === null) return { ok: false, code: "NOT_FOUND", params: { resource: "attachment" } };
  return { ok: true, value: contract };
}
