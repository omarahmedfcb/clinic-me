// Clinic identity and the doctor's print fields — Q28, pulled forward from Phase 5 because
// printing needs them. Images go through the `StorageProvider` seam; a second upload path would be
// a second thing to secure.

import { uuidv7 } from "uuidv7";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import {
  brandingKeyFor,
  isSafeBrandingKey,
  type BrandingKind,
} from "../attachments/domain/branding-key.ts";
import { sniff } from "../attachments/domain/sniff.ts";
import { ObjectNotFound, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { normalisePhone } from "../auth/phone.ts";
import { permissionLevel } from "../../common/permissions.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";

export interface ClinicIdentity {
  name: string;
  address: string;
  phone: string;
  secondaryPhone: string | null;
  /** Q37. All nullable and all free text: the sheet prints what is filled and omits what is not. */
  taxRegistrationNumber: string | null;
  commercialRegisterNumber: string | null;
  email: string | null;
  whatsappPhone: string | null;
  printedWorkingHours: string | null;
  tagline: string | null;
  /** Q45: the English letterhead. Null falls back to the Arabic value at print time. */
  nameEn: string | null;
  addressEn: string | null;
  /** Whether a logo is stored. The bytes come from the route, never a URL — see `branding-key.ts`. */
  hasLogo: boolean;
}

export interface DoctorPrintIdentity {
  doctorId: string;
  printedName: string | null;
  /** Q45: what the English sheet prints under the signature. */
  printedNameEn: string | null;
  title: string;
  syndicateNumber: string | null;
  licenseNumber: string;
  hasSignature: boolean;
  hasStamp: boolean;
}

export type IdentityRefusal =
  // "membership" is the profile-photo case: the person whose photo it is, reached through the
  // membership that proves they work in this clinic.
  | { code: "NOT_FOUND"; params: { resource: "doctor" | "membership" } }
  | { code: "UNSUPPORTED_TYPE"; params: Record<string, never> }
  | { code: "EMPTY_FILE"; params: Record<string, never> }
  | { code: "HEIC_NOT_CONVERTED"; params: Record<string, never> }
  | { code: "TOO_LARGE"; params: { limit: number; actual: number } };

export type IdentityResult<T> = { ok: true; value: T } | { ok: false; refusal: IdentityRefusal };

/** A letterhead image is small. Two megabytes is generous for a logo and refuses a scanned page. */
export const MAX_BRANDING_BYTES = 2 * 1024 * 1024;

export async function getClinicIdentity(caller: CallerContext): Promise<ClinicIdentity> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: caller.tenantId },
      select: {
        name: true,
        address: true,
        phone: true,
        secondaryPhone: true,
        taxRegistrationNumber: true,
        commercialRegisterNumber: true,
        email: true,
        whatsappPhone: true,
        printedWorkingHours: true,
        tagline: true,
        nameEn: true,
        addressEn: true,
        logoStorageKey: true,
      },
    });
    const { logoStorageKey, ...printed } = tenant;
    return { ...printed, hasLogo: logoStorageKey !== null };
  });
}

export interface ClinicIdentityPatch {
  name?: string;
  address?: string;
  phone?: string;
  secondaryPhone?: string | null;
  taxRegistrationNumber?: string | null;
  commercialRegisterNumber?: string | null;
  email?: string | null;
  whatsappPhone?: string | null;
  printedWorkingHours?: string | null;
  tagline?: string | null;
  nameEn?: string | null;
  addressEn?: string | null;
}

/** The Q37 fields, which are stored exactly as typed. Only the phones are parsed. */
const VERBATIM = [
  "taxRegistrationNumber",
  "commercialRegisterNumber",
  "email",
  "printedWorkingHours",
  "tagline",
  "nameEn",
  "addressEn",
] as const;

/**
 * Save the clinic's letterhead details.
 *
 * **A clinic number is normalised when it parses and kept as typed when it does not.** Landlines do
 * parse — `02 2735 1234` becomes `+20227351234` — so the fallback is narrower than it looks: it is
 * for the five-digit hotlines and extensions a letterhead also carries, which are not E.164 numbers
 * and never will be. Refusing those would make one of the numbers a clinic actually prints the one
 * number that cannot be stored. It mirrors `auth.controller.ts`, which already falls back to what
 * was typed when parsing fails.
 */
export async function saveClinicIdentity(
  caller: CallerContext,
  patch: ClinicIdentityPatch,
  defaultCountry: "EG" | "SA" | "AE",
): Promise<ClinicIdentity> {
  const printable = (typed: string): string => normalisePhone(typed, defaultCountry) ?? typed;

  await withTenant(caller.tenantId, caller.actor, async (tx) => {
    await tx.tenant.update({
      where: { id: caller.tenantId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.address === undefined ? {} : { address: patch.address }),
        ...(patch.phone === undefined ? {} : { phone: printable(patch.phone) }),
        ...(patch.secondaryPhone === undefined
          ? {}
          : {
              secondaryPhone:
                patch.secondaryPhone === null ? null : printable(patch.secondaryPhone),
            }),
        // WhatsApp is a phone and is parsed like the others; the rest are stored as typed.
        ...(patch.whatsappPhone === undefined
          ? {}
          : {
              whatsappPhone:
                patch.whatsappPhone === null ? null : printable(patch.whatsappPhone),
            }),
        ...Object.fromEntries(
          VERBATIM.filter((field) => patch[field] !== undefined).map((field) => [field, patch[field]]),
        ),
      },
    });
  });
  return getClinicIdentity(caller);
}

/**
 * The doctor row this caller may write to, or null.
 *
 * The same shape `schedules.service.ts` uses for `doctorSchedules.manage`, and for the same reason:
 * **the scope is applied to the lookup, not to a decision afterwards.** Another doctor's row is "no
 * such thing" rather than a refused authorisation, so a 404 cannot be read as confirmation that the
 * row exists. `doctorProfile.manage` is `own` for DOCTOR and `full` for OWNER and ADMIN.
 */
async function resolveOwnDoctor(
  tx: TransactionClient,
  caller: CallerContext,
  doctorId: string,
): Promise<{ id: string } | null> {
  const doctor = await tx.doctor.findFirst({
    where: { id: doctorId },
    select: { id: true, membershipId: true },
  });
  if (doctor === null) return null;
  if (permissionLevel(caller.role as never, "doctorProfile.manage") === "own") {
    return doctor.membershipId === caller.membershipId ? { id: doctor.id } : null;
  }
  return { id: doctor.id };
}

export interface DoctorPrintPatch {
  printedName?: string | null;
  printedNameEn?: string | null;
  title?: string;
  syndicateNumber?: string | null;
}

/** Q36. The name, title and syndicate number that appear on a printed sheet. */
export async function saveDoctorPrintFields(
  caller: CallerContext,
  doctorId: string,
  patch: DoctorPrintPatch,
): Promise<IdentityResult<DoctorPrintIdentity>> {
  const written = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctor = await resolveOwnDoctor(tx, caller, doctorId);
    if (doctor === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "doctor" as const } } };
    }
    await tx.doctor.update({
      where: { id: doctor.id },
      data: {
        ...(patch.printedName === undefined ? {} : { printedName: patch.printedName }),
        ...(patch.printedNameEn === undefined ? {} : { printedNameEn: patch.printedNameEn }),
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.syndicateNumber === undefined ? {} : { syndicateNumber: patch.syndicateNumber }),
      },
    });
    return { ok: true as const };
  });
  if (!written.ok) return { ok: false, refusal: written.refusal };

  const identity = await getDoctorPrintIdentity(caller, doctorId);
  if (identity === null) {
    return { ok: false, refusal: { code: "NOT_FOUND", params: { resource: "doctor" } } };
  }
  return { ok: true, value: identity };
}

/**
 * Stop using a branding image. **The stored object is left exactly where it is.**
 *
 * `StorageProvider` has no `delete()` by design (Q11), and this does not reach around it: what is
 * removed is the row's pointer. A sheet printed last week was made with that file, and destroying it
 * to clear a logo would be the one irreversible thing on this screen.
 */
export async function removeBrandingImage(
  caller: CallerContext,
  target: { kind: BrandingKind; doctorId?: string },
): Promise<IdentityResult<{ removed: true }>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    if (target.kind === "logo") {
      await tx.tenant.update({ where: { id: caller.tenantId }, data: { logoStorageKey: null } });
      return { ok: true as const, value: { removed: true as const } };
    }
    const doctor = await resolveOwnDoctor(tx, caller, target.doctorId ?? "");
    if (doctor === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "doctor" as const } } };
    }
    await tx.doctor.update({
      where: { id: doctor.id },
      data: target.kind === "signature" ? { signatureStorageKey: null } : { stampStorageKey: null },
    });
    return { ok: true as const, value: { removed: true as const } };
  });
}

export async function getDoctorPrintIdentity(
  caller: CallerContext,
  doctorId: string,
): Promise<DoctorPrintIdentity | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctor = await tx.doctor.findFirst({
      where: { id: doctorId },
      select: {
        id: true,
        printedName: true,
        printedNameEn: true,
        title: true,
        syndicateNumber: true,
        licenseNumber: true,
        signatureStorageKey: true,
        stampStorageKey: true,
      },
    });
    if (doctor === null) return null;
    return {
      doctorId: doctor.id,
      printedName: doctor.printedName,
      printedNameEn: doctor.printedNameEn,
      title: doctor.title,
      syndicateNumber: doctor.syndicateNumber,
      licenseNumber: doctor.licenseNumber,
      hasSignature: doctor.signatureStorageKey !== null,
      hasStamp: doctor.stampStorageKey !== null,
    };
  });
}

/**
 * What the bytes actually are decides admission — never what the uploader declared.
 *
 * Exported because profile photos use **this** guard rather than one of their own: the founder's
 * review asked for "the same image guard as the logo", and two guards are how the size limit or the
 * HEIC refusal ends up true of one upload path and not the other.
 */
export function admitImage(bytes: Buffer): IdentityResult<{ extension: string }> {
  if (bytes.length === 0) return { ok: false, refusal: { code: "EMPTY_FILE", params: {} } };
  if (bytes.length > MAX_BRANDING_BYTES) {
    return {
      ok: false,
      refusal: { code: "TOO_LARGE", params: { limit: MAX_BRANDING_BYTES, actual: bytes.length } },
    };
  }
  const sniffed = sniff(bytes);
  if (!sniffed.ok) {
    if (sniffed.reason === "HEIC") {
      return { ok: false, refusal: { code: "HEIC_NOT_CONVERTED", params: {} } };
    }
    return { ok: false, refusal: { code: "UNSUPPORTED_TYPE", params: {} } };
  }
  // A letterhead image is an image. A PDF passes the sniffer and is not one.
  if (sniffed.mimeType === "application/pdf") {
    return { ok: false, refusal: { code: "UNSUPPORTED_TYPE", params: {} } };
  }
  return { ok: true, value: { extension: sniffed.extension } };
}

/**
 * Store a branding image and point the row at it.
 *
 * The previous object is **left where it is** rather than overwritten or removed: `StorageProvider`
 * has no `delete()` by design, and a key is written fresh each time, so replacing a logo cannot
 * destroy the one a printed sheet was made with.
 */
export async function putBrandingImage(
  caller: CallerContext,
  storage: StorageProvider,
  target: { kind: BrandingKind; doctorId?: string },
  bytes: Buffer,
): Promise<IdentityResult<{ stored: true }>> {
  const admitted = admitImage(bytes);
  if (!admitted.ok) return admitted;

  const ownerId = target.kind === "logo" ? caller.tenantId : (target.doctorId ?? "");
  const key = brandingKeyFor({
    tenantId: caller.tenantId,
    kind: target.kind,
    ownerId,
    imageId: uuidv7(),
    extension: admitted.value.extension,
  });

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    if (target.kind === "logo") {
      await storage.put(key, bytes);
      await tx.tenant.update({ where: { id: caller.tenantId }, data: { logoStorageKey: key } });
      return { ok: true as const, value: { stored: true as const } };
    }

    // Scoped by the tenant extension *and* by `doctorProfile.manage`: another clinic's doctor id is
    // absent, and so is a colleague's when the caller only holds `own`.
    const doctor = await resolveOwnDoctor(tx, caller, ownerId);
    if (doctor === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "doctor" as const } } };
    }

    await storage.put(key, bytes);
    await tx.doctor.update({
      where: { id: doctor.id },
      data: target.kind === "signature" ? { signatureStorageKey: key } : { stampStorageKey: key },
    });
    return { ok: true as const, value: { stored: true as const } };
  });
}

export interface BrandingImage {
  bytes: Buffer;
  mimeType: string;
}

/**
 * The bytes behind a branding key, or null when there are none.
 *
 * The key is re-validated on the way out even though this system wrote it: a database is a place
 * values arrive from a restore, a migration, or a future writer, and the thing this prevents is
 * reading an arbitrary file off the host. Same argument as `isSafeStorageKey`, separate validator.
 */
export async function readBrandingImage(
  caller: CallerContext,
  storage: StorageProvider,
  target: { kind: BrandingKind; doctorId?: string },
): Promise<BrandingImage | null> {
  const key = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    if (target.kind === "logo") {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: caller.tenantId },
        select: { logoStorageKey: true },
      });
      return tenant.logoStorageKey;
    }
    const doctor = await tx.doctor.findFirst({
      where: { id: target.doctorId ?? "" },
      select: { signatureStorageKey: true, stampStorageKey: true },
    });
    if (doctor === null) return null;
    return target.kind === "signature" ? doctor.signatureStorageKey : doctor.stampStorageKey;
  });

  if (key === null || !isSafeBrandingKey(key)) return null;

  try {
    const bytes = await storage.get(key);
    const sniffed = sniff(bytes);
    return { bytes, mimeType: sniffed.ok ? sniffed.mimeType : "application/octet-stream" };
  } catch (error) {
    if (error instanceof ObjectNotFound) return null;
    throw error;
  }
}
