import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

const MAX_FIELD = 200;

/** Everything the console's new-clinic form sends. The Meta ids are the browser's claim; the service verifies them. */
export class WhatsAppSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_FIELD)
  clinicName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_FIELD)
  clinicNameEn?: string;

  // Lower-case, digits and hyphens, the same rule as the console's own create-clinic.
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  @MaxLength(60)
  slug!: string;

  @IsString()
  @MaxLength(60)
  timezone!: string;

  @IsIn(["EG", "SA", "AE"])
  country!: "EG" | "SA" | "AE";

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

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

  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  code!: string;

  // Meta ids are numeric strings; refusing anything else keeps them out of a URL path unchecked.
  @IsString()
  @Matches(/^\d{5,32}$/)
  wabaId!: string;

  // Absent for a number moved over from the WhatsApp Business app: Meta's event names only the WABA.
  @IsOptional()
  @IsString()
  @Matches(/^\d{5,32}$/)
  phoneNumberId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{5,32}$/)
  businessId?: string;

  @IsBoolean()
  skipRegistration!: boolean;
}
