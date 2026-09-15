// The letterhead's own details. Q28.
// Every field optional: this is a PATCH in PUT's clothing, and `null` on the second phone clears it.

import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from "class-validator";

export class SaveClinicIdentityDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(500)
  address?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  phone?: string;

  /** `null` clears it, and is deliberately distinct from omitting the field, which leaves it alone. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(40)
  secondaryPhone?: string | null;

  // Q37. Every one is nullable and free text: a clinic with no commercial register says so by
  // leaving the box empty, and the sheet prints what is filled.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  taxRegistrationNumber?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  commercialRegisterNumber?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40)
  whatsappPhone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  printedWorkingHours?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  tagline?: string | null;

  // Q45: printed documents are English whatever the interface language is. Nullable, because a
  // clinic that has not filled these still prints -- the sheet falls back to the Arabic value.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  nameEn?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  addressEn?: string | null;
}

/** The doctor's printed identity. `null` clears a field; omitting it leaves the stored value. */
export class SaveDoctorPrintFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  printedName?: string | null;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  title?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(60)
  syndicateNumber?: string | null;

  /** Q45: what the English sheet prints under the signature. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120)
  printedNameEn?: string | null;
}
