import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

export class CreateDoctorDto {
  @IsUUID()
  membershipId!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  specialty!: string;

  @IsString() @MinLength(1) @MaxLength(60)
  licenseNumber!: string;

  @IsString() @MinLength(1) @MaxLength(40)
  title!: string;
}

/** Every field optional: PATCH. `isActive: false` is deactivation — there is no delete route. */
export class UpdateDoctorDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  specialty?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  licenseNumber?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  title?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /**
   * `YYYY-MM-DD`, or `null` to clear it.
   *
   * `null` is meaningful and deliberately distinct from omitting the field: omitting leaves the
   * stored value alone, `null` says it was recorded in error. A PATCH that can only ever set is one
   * an admin cannot use to undo a typo.
   *
   * There is no upper or lower bound. A licence that expired last year must be recordable —
   * refusing past dates would make the one case worth surfacing the one case that cannot be stored.
   */
  @IsOptional() @IsISO8601()
  licenseExpiry?: string | null;

  /** Free text: rooms are called "2", "2أ" and "الأشعة". `null` clears it. */
  @IsOptional() @IsString() @MaxLength(40)
  roomNumber?: string | null;

  /** The name as it should appear on a prescription, when that differs from the login name. Q28. */
  @IsOptional() @IsString() @MaxLength(120)
  printedName?: string | null;

  @IsOptional() @IsString() @MaxLength(60)
  syndicateNumber?: string | null;

  /**
   * R1 and R2: «يُسمح له بتعديل الأسعار» and «يحصّل المدفوعات بنفسه».
   *
   * Set by an admin here, on the doctor's own record, because both are facts about one person
   * rather than about the DOCTOR role — the capability matrix cannot express either.
   */
  @IsOptional() @IsBoolean()
  mayAdjustPrices?: boolean;

  @IsOptional() @IsBoolean()
  collectsPayments?: boolean;

  /**
   * The cap on that permission — percent of the visit, a flat amount, or both. `null` clears it and
   * means unlimited, which is what the field is when an admin leaves it empty.
   *
   * The bounds here are a typo guard; the binding rule is the CHECK and the trigger, which refuse a
   * cap of zero and an adjustment above the cap however the row is written.
   */
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(1) @Max(100)
  priceAdjustmentCapPercent?: number | null;

  @IsOptional() @ValidateIf((_, value) => value !== null) @IsInt() @Min(1)
  priceAdjustmentCapMinor?: number | null;
}
