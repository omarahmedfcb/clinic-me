import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/**
 * Boundary validation — `whitelist: true, forbidNonWhitelisted: true` (CLAUDE.md).
 *
 * **Note what is absent: there is no `fromDoctorId` and no `patientId`.** Both come from the
 * appointment named in the request, for the same reason `tenantId` comes only from the JWT — a
 * caller that could name the from-doctor could describe a handover that is not the one on the board.
 */
export class CreateTransferDto {
  @IsUUID()
  appointmentId!: string;

  @IsUUID()
  toDoctorId!: string;

  /** Why reception is asking. Optional: the reason a *rejection* needs is a different field. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DecideTransferDto {
  /**
   * Required on reject and enforced in the service, not here: the rule is "required when
   * rejecting", which a per-field decorator cannot express without duplicating the verb. The DTO
   * bounds it; the service decides whether its absence is legal.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  decisionNote?: string;
}

export class ListTransfersQueryDto {
  /**
   * `"true"` or `"false"`, as a **string**, and deliberately not a `boolean`.
   *
   * `main.ts` enables `transformOptions: { enableImplicitConversion: true }`, which converts a
   * query parameter to its declared type — and for a `boolean` that conversion is `Boolean(value)`,
   * so the string `"false"` becomes **`true`**. Every non-empty string does. A `@Transform` does not
   * rescue it either: implicit conversion runs first, so the transform sees `true` and never the
   * original text.
   *
   * That cost an hour here. The screen asked for `openOnly=false`, the server read `true`, and the
   * rejected transfer the desk was supposed to see was filtered out — a request that had been
   * answered looked like one that had never been raised. Keeping this a string makes the parse
   * explicit and visible at the one place that reads it.
   *
   * This is the project's first boolean *query* parameter; the two existing `@IsBoolean()` fields
   * are on JSON bodies, where a real boolean arrives and the conversion is harmless.
   */
  @IsOptional()
  @IsString()
  @IsIn(["true", "false"])
  openOnly?: string;
}
