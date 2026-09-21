import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { recordOperatorAction } from "./platform-audit.ts";
import {
  createClinic,
  listClinics,
  resetClinicAdminPassword,
  setClinicSuspension,
  type ClinicRefusal,
  type ClinicResult,
} from "./platform-clinics.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

/** Lower-case, digits and hyphens: it goes in a URL and is typed by a person over the phone. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class CreateClinicDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsString() @Matches(SLUG) @MaxLength(60) slug!: string;
  /** An IANA zone. Never a literal here — `CLAUDE.md` allows `Africa/Cairo` in seed data only. */
  @IsString() @MaxLength(60) timezone!: string;
  @IsIn(["EG", "SA", "AE"]) country!: "EG" | "SA" | "AE";
  @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsString() @MinLength(2) @MaxLength(300) address!: string;
  // No minimum length on either number: `normalisePhone` is the one authority on what a phone is,
  // and a second opinion here answers INVALID_FIELD where INVALID_PHONE is the true sentence.
  @IsString() @MaxLength(40) phone!: string;
  @IsString() @MinLength(2) @MaxLength(200) adminFullName!: string;
  @IsString() @MaxLength(40) adminPhone!: string;
}

export class SuspendClinicDto {
  @IsBoolean() suspended!: boolean;
  /** Required when suspending; the database refuses the row without it either way. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ResetAdminPasswordDto {
  @IsIn(["ADMIN", "OWNER"]) role!: "ADMIN" | "OWNER";
}

/**
 * The console's clinic operations — 0b–0f. **Read-only about clinics, write-only about their
 * configuration**: nothing here returns a patient, a visit or an amount taken.
 *
 * Guarded by `PlatformAuthGuard` rather than `@RequirePermission`, because the capability matrix
 * reads a role out of a membership and the operator holds none — see `route-capability-manifest`.
 */
@Controller("platform/clinics")
@UseGuards(PlatformAuthGuard)
export class PlatformClinicsController {
  private unwrap<T>(result: ClinicResult<T>): T {
    if (result.ok) return result.value;
    const code: ClinicRefusal = result.code;
    const body = refusal(code, result.params);
    if (code === "NOT_FOUND") throw new NotFoundException(body);
    // Well formed and refusable on content, like every other money-or-state refusal here.
    if (code === "ALREADY_IN_THAT_STATE" || code === "REASON_REQUIRED") {
      throw new UnprocessableEntityException(body);
    }
    throw new BadRequestException(body);
  }

  @Get()
  async list(@Req() request: PlatformRequest) {
    return { clinics: await listClinics(actorContext.getOrThrow()) };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: PlatformRequest, @Body() body: CreateClinicDto) {
    const actor = actorContext.getOrThrow();
    const created = this.unwrap(await createClinic(actor, body));

    await recordOperatorAction(actor, {
      tenantId: created.tenantId,
      action: "CREATE",
      entityType: "tenants",
      entityId: created.tenantId,
      // The password is not in here, and must never be: an audit row is readable by the clinic.
      detail: { name: body.name, slug: body.slug, by: request.platformAdmin.fullName },
    });

    return created;
  }

  @Post(":tenantId/suspension")
  @HttpCode(200)
  async suspend(
    @Req() request: PlatformRequest,
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() body: SuspendClinicDto,
  ) {
    const actor = actorContext.getOrThrow();
    const result = this.unwrap(await setClinicSuspension(actor, tenantId, body));

    await recordOperatorAction(actor, {
      tenantId,
      action: "UPDATE",
      entityType: "tenants",
      entityId: tenantId,
      detail: { status: result.status, reason: body.reason ?? null, by: request.platformAdmin.fullName },
    });

    return result;
  }

  /**
   * **`BREAK_GLASS_ACCESS`**, which is what this is: the vendor reaching into a customer's account.
   * It is not impersonation — the operator gets a password to hand over, never a session — and the
   * row lands in the clinic's own trail so their admin can see it happened.
   */
  @Post(":tenantId/admins/:userId/password")
  @HttpCode(200)
  async resetPassword(
    @Req() request: PlatformRequest,
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
  ) {
    const actor = actorContext.getOrThrow();
    const reset = this.unwrap(await resetClinicAdminPassword(actor, tenantId, userId));

    await recordOperatorAction(actor, {
      tenantId,
      action: "BREAK_GLASS_ACCESS",
      entityType: "users",
      entityId: userId,
      detail: { what: "admin password reset", who: reset.fullName, by: request.platformAdmin.fullName },
    });

    return { fullName: reset.fullName, temporaryPassword: reset.temporaryPassword };
  }
}
