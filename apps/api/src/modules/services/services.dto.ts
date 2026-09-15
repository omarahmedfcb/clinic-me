import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

/**
 * `priceMinor` is integer minor units and there is no currency field (CLAUDE.md): currency lives
 * on `tenants`, so a clinic cannot end up with two services priced in different ones.
 *
 * The bounds on `durationMinutes`, `bufferMinutes` and `priceMinor` mirror the database CHECKs
 * rather than replacing them — a 400 here is a better error than a 23514 from Postgres, but the
 * constraint is what actually guarantees it.
 *
 * That sentence was **half false until 2026-09-03**, and it is worth leaving the correction here
 * rather than quietly fixing the wording. `services` carried a CHECK on `buffer_minutes` and none
 * on `duration_minutes` or `price_minor`, so for two of the three fields this comment asserted a
 * guarantee that did not exist — which is worse than saying nothing, because it stops anyone
 * looking. Both constraints now exist (`20260903130000_service_price_and_duration_constraints`).
 */
export class CreateServiceDto {
  @IsString() @MinLength(1) @MaxLength(120)
  nameAr!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  nameEn!: string;

  @IsEnum(["NEW", "CONSULTATION", "FOLLOW_UP", "PROCEDURE"])
  type!: "NEW" | "CONSULTATION" | "FOLLOW_UP" | "PROCEDURE";

  @IsInt() @Min(1) @Max(480)
  durationMinutes!: number;

  @IsInt() @Min(0) @Max(240)
  bufferMinutes!: number;

  @IsInt() @Min(0)
  priceMinor!: number;
}

export class UpdateServiceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  nameAr?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  nameEn?: string;

  @IsOptional() @IsEnum(["NEW", "CONSULTATION", "FOLLOW_UP", "PROCEDURE"])
  type?: "NEW" | "CONSULTATION" | "FOLLOW_UP" | "PROCEDURE";

  @IsOptional() @IsInt() @Min(1) @Max(480)
  durationMinutes?: number;

  @IsOptional() @IsInt() @Min(0) @Max(240)
  bufferMinutes?: number;

  @IsOptional() @IsInt() @Min(0)
  priceMinor?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}
