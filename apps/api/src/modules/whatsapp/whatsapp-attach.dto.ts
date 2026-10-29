import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/** What Meta's popup handed back, for a clinic that already exists. The ids are the browser's claim; the service verifies them. */
export class AttachWhatsAppDto {
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
