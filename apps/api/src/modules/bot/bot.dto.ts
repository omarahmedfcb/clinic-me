// The bot's request bodies. Narrow on purpose: the global pipe runs `forbidNonWhitelisted`, so a
// field that is not here is a 400 naming it rather than a value that is quietly dropped.

import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from "class-validator";

const E164 = /^\+[1-9]\d{6,14}$/;

export class BotPhoneQueryDto {
  /**
   * A full E.164 number and nothing else — no partial, no name.
   *
   * The pattern is the capability: a prefix search would turn a lookup into a way to walk the
   * clinic's book one digit at a time, which §3 of the contract forbids.
   */
  @Matches(E164, { message: "phone must be a full E.164 number, for example +201001234567" })
  phone!: string;
}

export class BotProvisionalPatientDto {
  /** The name as the patient gave it in chat. Arabic or Latin; stored as the record's name. */
  @IsString()
  @Length(2, 120)
  fullNameAr!: string;

  @Matches(E164, { message: "phoneE164 must be a full E.164 number, for example +201001234567" })
  phoneE164!: string;
}

export class BotSlotsQueryDto {
  @IsUUID()
  doctorId!: string;

  @IsUUID()
  serviceId!: string;

  /** `YYYY-MM-DD` in the clinic's zone. A day, never an instant. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;
}

export class BotBookDto {
  /**
   * The chat message the patient booked from, recorded as the evidence for their WhatsApp consent.
   *
   * Required, ruled 2026-09-18: a booking made in chat is where consent is given, and a consent
   * with no evidence is an assertion. Nothing is ever sent to a patient who has none.
   */
  @IsString()
  @Length(1, 200)
  consentMessageId!: string;

  @IsString()
  @MaxLength(4096)
  slotToken!: string;

  @IsUUID()
  patientId!: string;
}

export class BotRescheduleDto {
  @IsString()
  @MaxLength(4096)
  slotToken!: string;
}

export class BotCancelDto {
  /**
   * Why, in the patient's words or the bot's summary. Optional, capped, and never clinical: this
   * lands in the appointment's cancellation reason, which reception reads.
   */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export class BotConsentDto {
  /**
   * `WHATSAPP_COMMS` only, for now. The other purposes are captured at the desk with a person
   * present; a bot recording TREATMENT consent from a chat message is a different conversation.
   */
  @IsIn(["WHATSAPP_COMMS"])
  purpose!: "WHATSAPP_COMMS";

  @IsBoolean()
  granted!: boolean;

  /** WhatsApp's own message id, so the evidence points at the message the patient sent. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalMessageId?: string;
}
