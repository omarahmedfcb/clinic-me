import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { RetryAfterThrottlerGuard, skipAllExcept } from "../../common/throttlers.ts";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  bookAppointment,
  changeAppointmentStatus,
  findAvailableSlots,
  rescheduleAppointment,
} from "../appointments/appointments.service.ts";
import {
  BotBookDto,
  BotCancelDto,
  BotConsentDto,
  BotPhoneQueryDto,
  BotProvisionalPatientDto,
  BotRescheduleDto,
  BotSlotsQueryDto,
} from "./bot.dto.ts";
import { BOT_CREATE_PATIENT_THROTTLER, BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER } from "./bot-throttle.ts";
import {
  createProvisionalPatient,
  findPatientsByPhone,
  readAppointmentStatus,
  ensureWhatsAppConsent,
  recordBotConsent,
} from "./bot.service.ts";

/**
 * The WhatsApp bot's entire surface. `docs/WHATSAPP-BOT-CONTRACT.md` is the specification.
 *
 * **Eight routes, eight capabilities, one each.** Nothing here is shared with a staff route: the
 * contract's refusals are narrower than a receptionist's, and a shared endpoint would have to decide
 * between them at runtime — which is the shape of check that is right until someone adds a branch.
 *
 * **No list endpoint, deliberately.** Every route below takes a number the caller already had, or an
 * id it was given. There is nothing here that walks the clinic's book, and nothing that returns a
 * clinical or financial field, which is why the bot's credential can be handed to software running
 * somewhere we do not control.
 */
@Controller("bot")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard, RetryAfterThrottlerGuard)
// 60 requests a minute per credential across the whole surface; the two write limits are narrower
// and sit on the routes they protect.
// Only the bot buckets, and only the surface-wide one at class level: every other registered
// throttler — the login limits, the desk write limits — is skipped rather than inherited.
@SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER))
export class BotController {
  private caller(request: AuthenticatedRequest) {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      // From the validated token, never the request — the rule tenantId follows.
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  /** Every patient on one number — the household, because one phone per family is the norm here. */
  @Get("patients")
  @RequirePermission("bot.findPatientByPhone")
  async findByPhone(@Req() request: AuthenticatedRequest, @Query() query: BotPhoneQueryDto) {
    return { patients: await findPatientsByPhone(this.caller(request), query.phone) };
  }

  /**
   * A patient from a name and a phone. Every other field is refused by the DTO, not ignored.
   *
   * `createdVia` is absent from that DTO on purpose: the service sets it. A bot that could send its
   * own provenance could send `DESK`, and the desk would never know the record came from a chat.
   */
  @Post("patients")
  @RequirePermission("bot.createProvisionalPatient")
  @SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER, BOT_CREATE_PATIENT_THROTTLER))
  async createProvisional(@Req() request: AuthenticatedRequest, @Body() body: BotProvisionalPatientDto) {
    return createProvisionalPatient(this.caller(request), {
      fullNameAr: body.fullNameAr,
      phoneE164: body.phoneE164,
    });
  }

  /**
   * Bookable slots. The channel is `PATIENT`, fixed here and never read from the request (Q22):
   * a remote channel's lead time exists to constrain the remote channel.
   */
  @Get("slots")
  @RequirePermission("bot.listSlots")
  async slots(@Req() request: AuthenticatedRequest, @Query() query: BotSlotsQueryDto) {
    const result = await findAvailableSlots(this.caller(request), {
      doctorId: query.doctorId,
      serviceId: query.serviceId,
      date: query.date,
      channel: "PATIENT",
      now: new Date(),
    });

    if (result.ok) return { slots: result.slots };
    const refused = refusal(result.code, result.params);
    if (result.code === "OUTSIDE_HORIZON") throw new BadRequestException(refused);
    throw new NotFoundException(refused);
  }

  /** Books a slot the bot was offered. `source: WHATSAPP`, which is what makes the channel true. */
  @Post("appointments")
  @RequirePermission("bot.book")
  @SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER))
  async book(@Req() request: AuthenticatedRequest, @Body() body: BotBookDto) {
    const result = await bookAppointment(this.caller(request), {
      slotToken: body.slotToken,
      patientId: body.patientId,
      source: "WHATSAPP",
      complaintSummary: null,
      bookingNotes: null,
      now: new Date(),
    });
    if (result.ok) {
      // Consent where it is actually given: in the chat this booking came from. Recorded after the
      // booking succeeds, so a refused booking never leaves a consent nobody gave behind it.
      await ensureWhatsAppConsent(this.caller(request), body.patientId, body.consentMessageId, new Date());
      return result;
    }
    return this.refuse(result.code, result.params);
  }

  @Post("appointments/:id/reschedule")
  @RequirePermission("bot.reschedule")
  @SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER))
  async reschedule(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BotRescheduleDto,
  ) {
    const result = await rescheduleAppointment(this.caller(request), id, body.slotToken, new Date());
    if (result.ok) return result;
    return this.refuse(result.code, result.params);
  }

  @Post("appointments/:id/cancel")
  @RequirePermission("bot.cancel")
  @SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER))
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BotCancelDto,
  ) {
    const result = await changeAppointmentStatus(this.caller(request), id, "CANCEL", {
      reason: body.reason ?? null,
      now: new Date(),
    });
    if (result.ok) return result;
    return this.refuse(result.code, result.params);
  }

  /** Status only. The visit behind it is `visits.read*`, which the bot does not hold. */
  @Get("appointments/:id")
  @RequirePermission("bot.readAppointmentStatus")
  async status(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const found = await readAppointmentStatus(this.caller(request), id);
    if (found === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "appointment" }));
    return found;
  }

  @Post("patients/:id/consent")
  @RequirePermission("bot.recordConsent")
  async consent(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BotConsentDto,
  ) {
    const result = await recordBotConsent(
      this.caller(request),
      id,
      {
        purpose: body.purpose,
        granted: body.granted,
        ...(body.externalMessageId === undefined ? {} : { externalMessageId: body.externalMessageId }),
      },
      new Date(),
    );
    if (result.recorded) return { recorded: true };
    throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
  }

  /**
   * One mapping for every booking refusal, so the bot meets the same codes the desk does.
   *
   * `NOT_FOUND` is 404 rather than 403 even when the row exists in another clinic: a 403 would
   * confirm the id is real, which is the rule the rest of the system follows.
   */
  private refuse(code: string, params: unknown): never {
    const refused = refusal(code as never, params as never);
    if (code === "SLOT_TAKEN" || code === "CONTENDED" || code === "ILLEGAL_TRANSITION") {
      throw new ConflictException(refused);
    }
    if (code === "NOT_FOUND") throw new NotFoundException(refused);
    throw new BadRequestException(refused);
  }
}
