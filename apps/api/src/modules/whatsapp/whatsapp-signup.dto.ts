import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

const MAX_FIELD = 200;

/** Everything the signup page sends. The Meta ids are the browser's claim; the service verifies them. */
export class WhatsAppSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_FIELD)
  clinicName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FIELD)
  clinicNameEn?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(400)
  address!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(30)
  clinicPhone!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(MAX_FIELD)
  ownerFullName!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(30)
  ownerPhone!: string;

  // Same floor as a staff password change (auth.dto.ts).
  @IsString()
  @MinLength(12)
  @MaxLength(MAX_FIELD)
  password!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  code!: string;

  // Meta ids are numeric strings; refusing anything else keeps them out of a URL path unchecked.
  @IsString()
  @Matches(/^\d{5,32}$/)
  wabaId!: string;

  @IsString()
  @Matches(/^\d{5,32}$/)
  phoneNumberId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{5,32}$/)
  businessId?: string;

  @IsBoolean()
  skipRegistration!: boolean;
}
