import { Type } from "class-transformer";
import { IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

/**
 * Request shapes for the patients endpoints.
 *
 * The global pipe runs `whitelist: true, forbidNonWhitelisted: true`, so anything not declared here
 * is a 400 rather than a silently dropped field — which matters most for `tenantId`, which a caller
 * must never supply and `TenantGuard` logs as a security event if they try.
 *
 * These types exist for the HTTP boundary only. The service takes its own input type, because the
 * AI tool layer calls it without ever constructing a DTO (ARCHITECTURE.md §12).
 */

const NAME_MAX = 200;

export class SearchPatientsDto {
  /**
   * The search text: a name in either script, or a phone number in any notation.
   *
   * No minimum beyond one character. A receptionist typing two letters and getting nothing back
   * would conclude the patient is not registered and create a duplicate — the exact failure D19
   * exists to prevent — so short queries are answered, and trigram similarity decides relevance.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  q!: string;

  /** Capped so one request cannot ask for the whole table. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * «مرضاي» — R-B. Paging, plus a search that narrows within the doctor's own patients rather than
 * across the clinic. `q` is optional here because the tab opens as a list before anyone types.
 */
export class MyPatientsDto {
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Paging for the patient book. Both fields optional, so `GET /patients/recent` with no query string
 * is the first page — the screen's own first request should not need to know the defaults.
 */
export class ListPatientsDto {
  /** Capped at the same 50 as search: one request cannot ask for the whole table. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class CreatePatientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  fullNameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  fullNameEn?: string;

  /**
   * E.164. Normalising a typed number to this shape is the caller's job at the edge — the same
   * `normalisePhone` the login screen uses — because the tenant's country is the hint and this DTO
   * has no tenant.
   */
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phoneE164!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  secondaryPhone?: string;

  /**
   * Required at intake since 2026-09-07 — `SCHEMA-DECISIONS.md` D26, which reverses the 21 August
   * ruling that made this and `dateOfBirth` optional.
   *
   * That ruling expected staff to invent values if forced. The pilot showed the opposite: reception
   * skipped the fields, and a skipped field is invisible where an invented birthday would at least
   * look suspicious. The column stays nullable for rows already recorded.
   */
  @IsIn(["MALE", "FEMALE"])
  gender!: string;

  /** Date only, no time. Required at intake, nullable in the column — D26. */
  @IsISO8601()
  dateOfBirth!: string;

  /** ISO 3166-1 alpha-2, matching the column's CHECK. The form defaults to EG; the column does not. */
  @Matches(/^[A-Z]{2}$/)
  nationality!: string;

  /**
   * Egyptian national ID. Optional, and validated rather than merely length-checked — D27. The
   * parse also fills date of birth, gender and governorate on the client, where a disagreement
   * warns instead of refusing.
   */
  @IsOptional()
  @Matches(/^\d{14}$/)
  nationalId?: string;

  /** Offered instead of `nationalId` for a non-Egyptian patient. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  passportNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  governorate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  referralSource?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsIn(["SELF", "CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"])
  relationshipToContact!: "SELF" | "CHILD" | "SPOUSE" | "PARENT" | "SIBLING" | "OTHER";
}

/**
 * Reception's correction path. `PHASE-3.md` Q18.
 *
 * Every field optional — a PATCH, not a PUT, so a screen editing one field does not have to resend
 * the rest and cannot blank what it did not load.
 *
 * **Note what is absent, and that it is the same discipline as `CreateTransferDto`.** No `status`,
 * no `mergedIntoPatientId`, and no clinical field of any kind. Archiving is not a correction, and
 * merging is `patients.merge` — `NONE` for both reception and doctors. Accepting `status` here
 * would let a phone-number fix archive a patient, and `whitelist: true, forbidNonWhitelisted: true`
 * turns the attempt into a 400 rather than a silently dropped field.
 */
export class UpdatePatientDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  fullNameAr?: string;

  /**
   * Nullable on purpose, unlike on create: clearing a wrongly-entered English name is a real
   * correction. `null` reaches the service as "clear it"; omitting the key means "leave alone".
   */
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  fullNameEn?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phoneE164?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  secondaryPhone?: string | null;

  @IsOptional()
  @IsIn(["MALE", "FEMALE"])
  gender?: string | null;

  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  nationalId?: string | null;

  @IsOptional()
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsIn(["SELF", "CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"])
  relationshipToContact?: "SELF" | "CHILD" | "SPOUSE" | "PARENT" | "SIBLING" | "OTHER";
}

/** The phone intake is about to write, asked about before writing it. D28. */
export class HouseholdQueryDto {
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phoneE164!: string;
}

/** A kinship link between two patients. Q30. */
export class LinkPatientDto {
  @IsString()
  @MinLength(36)
  @MaxLength(36)
  relatedPatientId!: string;

  @IsIn(["HUSBAND", "WIFE", "SON", "DAUGHTER", "FATHER", "MOTHER"])
  relation!: "HUSBAND" | "WIFE" | "SON" | "DAUGHTER" | "FATHER" | "MOTHER";
}
