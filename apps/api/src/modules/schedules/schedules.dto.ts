import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from "class-validator";

const WALL_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BreakDto {
  @Matches(WALL_CLOCK, { message: "startTime must be HH:mm" })
  startTime!: string;

  @Matches(WALL_CLOCK, { message: "endTime must be HH:mm" })
  endTime!: string;

  @IsString() @MaxLength(60)
  label!: string;
}

export class TemplateDto {
  /** JS getDay(): Sunday = 0 (PHASE-2.md Q5). Pinned here so a client cannot send ISO numbering. */
  @IsInt() @Min(0) @Max(6)
  weekday!: number;

  @Matches(WALL_CLOCK, { message: "startTime must be HH:mm" })
  startTime!: string;

  /**
   * May be earlier than `startTime` — that means a session crossing midnight, which Q8 rules is
   * supported rather than rejected. Only equality is refused, in the service and again by the
   * database's `schedule_templates_window_not_empty`.
   */
  @Matches(WALL_CLOCK, { message: "endTime must be HH:mm" })
  endTime!: string;

  @Matches(CALENDAR_DATE, { message: "validFrom must be YYYY-MM-DD" })
  validFrom!: string;

  @IsOptional() @Matches(CALENDAR_DATE, { message: "validTo must be YYYY-MM-DD" })
  validTo?: string | null;

  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => BreakDto)
  breaks!: BreakDto[];
}

/**
 * The whole set, replaced at once. Overlap is a property of the set, not of a row, so validating
 * it per-row would either forbid legitimate rearrangements or allow an overlap to exist between
 * two requests.
 */
export class ReplaceTemplatesDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => TemplateDto)
  templates!: TemplateDto[];
}

export class CreateExceptionDto {
  /** Omit for a clinic-wide closure — null means every doctor in the tenant (Q13). */
  @IsOptional() @IsUUID()
  doctorId?: string | null;

  @Matches(CALENDAR_DATE, { message: "date must be YYYY-MM-DD" })
  date!: string;

  @IsEnum(["BLOCKED", "HOLIDAY", "EXTRA_AVAILABILITY"])
  type!: "BLOCKED" | "HOLIDAY" | "EXTRA_AVAILABILITY";

  @IsOptional() @Matches(WALL_CLOCK, { message: "startTime must be HH:mm" })
  startTime?: string | null;

  @IsOptional() @Matches(WALL_CLOCK, { message: "endTime must be HH:mm" })
  endTime?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  reason?: string | null;
}
