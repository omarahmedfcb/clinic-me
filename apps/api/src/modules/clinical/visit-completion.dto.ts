// Request shapes for finishing a visit, correcting a finished one, and recording procedures.
// Clinical free text is never normalised or trimmed here; only the amendment's reason is checked.

import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

const FIELD_MAX = 20_000;

export class CompleteVisitDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  /** `YYYY-MM-DD` in the clinic's own zone, never an instant — a follow-up is a day, not a moment. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "followUpDate must be YYYY-MM-DD" })
  followUpDate?: string;

  /** Two years is past any follow-up a consultation produces, and stops a typo booking 2085. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  followUpIntervalDays?: number;
}

export class AmendVisitDto {
  @IsString() @MinLength(1) @MaxLength(1_000) reason!: string;

  @IsOptional() @IsString() @MaxLength(FIELD_MAX) complaint?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) medicalHistory?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) examination?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) diagnosis?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) treatmentPlan?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) doctorNotes?: string;
}

export class AddProcedureDto {
  @IsUUID() serviceId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;
}
