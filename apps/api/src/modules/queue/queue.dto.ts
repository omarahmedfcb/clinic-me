import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

/**
 * Boundary validation — `whitelist: true, forbidNonWhitelisted: true` (CLAUDE.md), so a field not
 * declared here is rejected rather than quietly dropped.
 *
 * **Note what is absent.** No `tenantId`: it comes from the validated JWT only, never from a body,
 * query or header. And no `dayStart`/`dayEnd`: the day is resolved server-side in the tenant's own
 * zone (Q12), because a caller-supplied window is a caller-supplied answer to "which day is this
 * appointment on" — the exact question Q12 rules must have one implementation.
 */

const QUEUE_STATUSES = [
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "WAITING",
  "IN_CONSULTATION",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;

export class QueueTodayQueryDto {
  /** `YYYY-MM-DD`, read in the tenant's timezone. Deliberately not a `Date`. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;

  /** Optional filter. Absent means the whole clinic, which is reception's default view (Q11). */
  @IsOptional()
  @IsUUID()
  doctorId?: string;
}

export class PendingNoShowsQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "date must be YYYY-MM-DD" })
  date!: string;
}

/**
 * Every queue mutation carries `expectedStatus` — the compare-and-set of Q2.
 *
 * It is **required, not optional**. An optional one would be omitted by the first caller in a
 * hurry, and the protection it provides is invisible when it works: `ARRIVED → WAITING` applied
 * twice is legal both times, so the second write silently overwrites the first
 * `waiting_started_at` and quietly reorders the queue. Nothing surfaces that later. A required
 * field means a caller cannot opt out of the check without noticing they did.
 */
export class QueueMoveDto {
  @IsEnum(QUEUE_STATUSES)
  expectedStatus!: (typeof QUEUE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason?: string;
}
