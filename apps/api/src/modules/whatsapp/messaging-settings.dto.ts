import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

/** A PATCH in PUT's clothing, like the clinic identity: what is omitted is left alone. */
export class SaveMessagingSettingsDto {
  @IsOptional() @IsBoolean()
  appointmentRemindersEnabled?: boolean;

  /** Hours before the appointment. Quiet hours can still move the send later. */
  @IsOptional() @IsInt() @Min(1) @Max(48)
  reminderLeadHours?: number;

  /** Hours the patient has to confirm before the appointment is cancelled. */
  @IsOptional() @IsInt() @Min(1) @Max(24)
  reminderConfirmWindowHours?: number;

  @IsOptional() @IsBoolean()
  callInMessageEnabled?: boolean;

  @IsOptional() @IsBoolean()
  visitDocumentsLinkEnabled?: boolean;
}
