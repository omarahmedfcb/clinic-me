// Request shapes for the profile entry, the prescription and the investigations. Q22, Q24, Q8.
// Clinical free text is never normalised or trimmed here — only emptiness is refused.

import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

const FIELD_MAX = 20_000;
const LINE_MAX = 500;

const PROFILE_FIELDS = [
  "PAST_MEDICAL",
  "PAST_SURGICAL",
  "CHRONIC_CONDITIONS",
  "CHRONIC_MEDICATIONS",
  "FAMILY_HISTORY",
  "RISK_FACTORS",
] as const;

export class AddProfileEntryDto {
  @IsEnum(PROFILE_FIELDS) field!: (typeof PROFILE_FIELDS)[number];
  @IsString() @MinLength(1) @MaxLength(FIELD_MAX) content!: string;
}

export class PrescriptionItemDto {
  @IsString() @MinLength(1) @MaxLength(LINE_MAX) medicationName!: string;
  // Q45 split the line the way an Egyptian prescription is written. Optional, because every
  // prescription already stored has none of them and must keep saving without a rewrite.
  @IsOptional() @IsString() @MaxLength(LINE_MAX) strength?: string;
  @IsOptional() @IsString() @MaxLength(LINE_MAX) form?: string;
  @IsOptional() @IsString() @MaxLength(LINE_MAX) quantity?: string;
  @IsString() @MaxLength(LINE_MAX) dose!: string;
  @IsString() @MaxLength(LINE_MAX) frequency!: string;
  @IsString() @MaxLength(LINE_MAX) duration!: string;
  @IsOptional() @IsString() @MaxLength(LINE_MAX) instructions?: string;
}

export class SavePrescriptionDto {
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) notes?: string;

  /** A cap, not a policy: no consultation writes forty lines, and an unbounded list is a DoS. */
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];
}

export class InvestigationItemDto {
  @IsString() @MinLength(1) @MaxLength(LINE_MAX) name!: string;
  @IsOptional() @IsString() @MaxLength(LINE_MAX) notes?: string;
}

export class SaveInvestigationsDto {
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) freeText?: string;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => InvestigationItemDto)
  items!: InvestigationItemDto[];
}

export class MedicationQueryDto {
  @IsString() @MinLength(1) @MaxLength(LINE_MAX) q!: string;
}

/**
 * The doctor's adjustment to the visit total — R1.
 *
 * Signed and deliberately unbounded in either direction: a doctor who waives a fee and one who
 * charges for a procedure the catalogue has no row for are the same control. `null` clears it; the
 * database refuses zero, because clearing and "adjusting by nothing" are the same act.
 */
export class SaveVisitAdjustmentDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  adjustmentMinor!: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(FIELD_MAX)
  reason?: string | null;
}

/**
 * Sick leave — Q46.
 *
 * `days: null` clears the certificate; the database refuses a half-written one, so the fields move
 * together. The 365-day ceiling is a typo guard, not a policy: a year of sick leave from an
 * outpatient visit is a slipped keystroke, and the constraint that matters (> 0) is in SQL.
 */
export class SaveSickLeaveDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  from!: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(FIELD_MAX)
  note?: string | null;
}
