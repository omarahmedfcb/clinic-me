import { IsEnum, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

/**
 * Boundary validation — `whitelist: true, forbidNonWhitelisted: true` (CLAUDE.md), so anything not
 * declared here is rejected rather than quietly dropped.
 *
 * **Note what is absent.** There is no `granularityMinutes`: PHASE-2.md Q18 makes it
 * server-resolved from `tenants.slot_granularity_minutes`, and a caller-supplied granularity of 1
 * would turn availability into an oracle enumerating a doctor's whole day minute by minute. And
 * there is no `tenantId` anywhere: it comes from the validated JWT only, never from a body, query
 * or header (CLAUDE.md).
 */
export class AvailabilityQueryDto {
  @IsUUID()
  doctorId!: string;

  @IsUUID()
  serviceId!: string;

  /** `YYYY-MM-DD`, read in the tenant's timezone (Q2). Deliberately not a `Date`. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;
}

export class DayViewQueryDto {
  @IsUUID()
  doctorId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;
}

/**
 * Booking names a patient and a token, and nothing else.
 *
 * There is no `start`, no `doctorId`, no `serviceId` — those come from inside the token (Q24).
 * That absence is the mechanism, not an omission: with no request field naming a time, there is
 * nothing for a caller to disagree with the offer in, so ARCHITECTURE.md §12 rule 1 holds
 * structurally rather than by the model behaving well.
 */
export class WeekViewQueryDto {
  @IsUUID()
  doctorId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be YYYY-MM-DD" })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be YYYY-MM-DD" })
  to!: string;
}

export class CreateAppointmentDto {
  @IsString()
  @MinLength(1)
  slotToken!: string;

  @IsUUID()
  patientId!: string;

  @IsEnum(["RECEPTION", "DOCTOR", "WALK_IN", "WHATSAPP", "ONLINE"])
  source!: "RECEPTION" | "DOCTOR" | "WALK_IN" | "WHATSAPP" | "ONLINE";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  complaintSummary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bookingNotes?: string;
}

export class RescheduleAppointmentDto {
  @IsString()
  @MinLength(1)
  slotToken!: string;
}

/** §9: cancelling requires a reason. Enforced here and again in `transition()`. */
export class CancelAppointmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListAppointmentsQueryDto {
  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @IsISO8601()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;
}

/**
 * The month view. `YYYY-MM`, read in the clinic timezone like every other date here (Q2).
 *
 * `doctorId` is optional: reception sees every doctor at once and may narrow to one. A DOCTOR
 * caller is pinned to themselves regardless of what is sent — `resolveReadableDoctorId` decides
 * that, not this DTO.
 */
export class MonthViewQueryDto {
  @Matches(/^\d{4}-\d{2}$/, { message: "month must be YYYY-MM" })
  month!: string;

  @IsOptional()
  @IsUUID()
  doctorId?: string;
}

/** One day of the book. Same optional-doctor rule as the month. */
export class DayBookingsQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;

  @IsOptional()
  @IsUUID()
  doctorId?: string;
}
