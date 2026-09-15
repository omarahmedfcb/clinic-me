import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  ValidateIf,
} from "class-validator";

/**
 * Request shapes for the insurance endpoints. `whitelist: true, forbidNonWhitelisted: true`
 * (CLAUDE.md), so anything not declared here is a 400 rather than a silently dropped field.
 *
 * **Note what is absent: no coverage percentage, no ceiling, no co-payment, and no claim.** The
 * schema has no columns for them and that is deliberate — a percentage invites a service to
 * multiply by it and store the result, which is the derived-money drift D7 exists to prevent, and
 * the payer split belongs with `payments`. Claims are Phase 5, ruled: this screen shows the policy,
 * not the claim.
 */

const RELATIONSHIPS = ["SELF", "CHILD", "SPOUSE", "PARENT", "SIBLING", "OTHER"] as const;

export class RecordCoverageDto {
  /** The registry row this policy names, when the clinic has one (Phase 5 PR 1). Optional: a
   *  clinic that has not filled its registry still records cover by insurer name. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  companyId?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  planName?: string | null;

  @IsOptional() @IsBoolean() isPrimary?: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  insurerName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  policyNumber!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  policyholderName!: string;

  /** `YYYY-MM-DD`. A calendar date, not an instant — a policy runs from a date to a date. */
  @IsISO8601()
  validFrom!: string;

  /**
   * `null` is meaningful and is not the same as omitting it: several Egyptian corporate schemes
   * renew silently and the desk is never told an end date. NULL means open-ended, and must read as
   * neither "expired" nor "unknown".
   */
  @IsOptional()
  @IsISO8601()
  validTo?: string | null;

  @IsIn(RELATIONSHIPS)
  relationshipToPolicyholder!: (typeof RELATIONSHIPS)[number];
}

/** Every field optional — a PATCH, so a screen editing one field need not resend the rest. */
export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  insurerName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  policyNumber?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  policyholderName?: string;

  @IsOptional()
  @IsISO8601()
  validFrom?: string;

  @IsOptional()
  @IsISO8601()
  validTo?: string | null;
}

/**
 * The insurance company registry — `PHASE-5-PLAN.md` PR 1.
 *
 * **Still no coverage percentage and no copay**, which is the ruling rather than an oversight: the
 * payer split is manual until real policies have been seen, and a rate here would make it look
 * automatable while nothing computes it.
 */

const COMPANY_TYPES = ["INSURER", "TPA", "CORPORATE", "GOVERNMENT"] as const;
const CLAIM_METHODS = ["PORTAL", "EMAIL", "PAPER", "OTHER"] as const;

export class CreateInsuranceCompanyDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;

  @IsIn(COMPANY_TYPES) type!: (typeof COMPANY_TYPES)[number];

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100)
  contractNumber?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601({ strict: true })
  contractStart?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601({ strict: true })
  contractEnd?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  contactPerson?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(CLAIM_METHODS)
  claimSubmissionMethod?: (typeof CLAIM_METHODS)[number] | null;

  /** Days, not a date. Zero is real — "on presentation" — so the floor is 0 rather than 1. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(365)
  paymentTermsDays?: number | null;

  @IsOptional() @IsBoolean() priorApprovalRequired?: boolean;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Every field optional: a PATCH. An omitted field is left alone; `null` clears one. */
export class UpdateInsuranceCompanyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;

  @IsOptional() @IsIn(COMPANY_TYPES) type?: (typeof COMPANY_TYPES)[number];

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100)
  contractNumber?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601({ strict: true })
  contractStart?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601({ strict: true })
  contractEnd?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  contactPerson?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(CLAIM_METHODS)
  claimSubmissionMethod?: (typeof CLAIM_METHODS)[number] | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(365)
  paymentTermsDays?: number | null;

  @IsOptional() @IsBoolean() priorApprovalRequired?: boolean;

  @IsOptional() @IsBoolean() isActive?: boolean;
}
