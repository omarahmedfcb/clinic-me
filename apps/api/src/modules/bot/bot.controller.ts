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
import { listDoctors } from "../doctors/doctors.service.ts";
import { listServices } from "../services/services.service.ts";
import {
  BotBookDto,
  BotCancelDto,
  BotComplaintDto,
  BotConsentDto,
  BotPhoneQueryDto,
  BotProvisionalPatientDto,
  BotRescheduleDto,
  BotSlotsQueryDto,
} from "./bot.dto.ts";
import { BOT_CREATE_PATIENT_THROTTLER, BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER } from "./bot-throttle.ts";
import {
  createComplaint,
  createProvisionalPatient,
  findPatientsByPhone,
  readAppointmentStatus,
  ensureWhatsAppConsent,
  recordBotConsent,
} from "./bot.service.ts";

/**
 * The WhatsApp bot's entire surface. `docs/WHATSAPP-BOT-CONTRACT.md` is the specification.
 *
 * **Eleven routes, eleven capabilities, one each** (ten plus `bot.createComplaint`, 2026-09-29, for
 * the "شكوى" flow — same shape as `bot.createProvisionalPatient`: narrow, write, AI_AGENT-only).
 * `bot.listDoctors` and `bot.listServices` joined the
 * original eight on 2026-09-26, closing a gap the contract's §3 table never covered: `bot.listSlots`
 * takes a `doctorId`/`serviceId` a caller must already have, and nothing in the original eight hands
 * one out. `permissions.ts` already granted AI_AGENT both -- the web chat has called the identical
 * `listDoctors`/`listServices` functions in-process since it was built -- so this is the same grant
 * reaching an HTTP route for the first time, not a new capability being decided here. Nothing here is
 * shared with a staff route: the contract's refusals are narrower than a receptionist's, and a shared
 * endpoint would have to decide between them at runtime — which is the shape of check that is right
 * until someone adds a branch.
 *
 * **No *patient* list endpoint, deliberately** (the doctor and service lists above are the clinic's
 * own public catalog, not a page of anyone's patients). Every route that takes a patient or an
 * appointment takes one the caller already had, or an id it was given. There is nothing here that
 * walks the clinic's book, and nothing that returns a clinical or financial field, which is why the
 * bot's credential can be handed to software running
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
   * The clinic's active doctors — id, name, title, specialty. Nothing about their schedule beyond
   * what `bot.listSlots` already exposes, and nothing a patient could not learn by asking at the desk.
   */
  @Get("doctors")
  @RequirePermission("bot.listDoctors")
  async doctors(@Req() request: AuthenticatedRequest) {
    const rows = await listDoctors(this.caller(request), new Date());
    return {
      doctors: rows
        .filter((doctor) => doctor.isActive)
        .map((doctor) => ({ id: doctor.id, fullName: doctor.fullName, title: doctor.title, specialty: doctor.specialty })),
    };
  }

  /** The clinic's active services — id, name (Arabic and English), duration. Same boundary as above. */
  @Get("services")
  @RequirePermission("bot.listServices")
  async services(@Req() request: AuthenticatedRequest) {
    const rows = await listServices(this.caller(request), new Date());
    return {
      services: rows
        .filter((service) => service.isActive)
        .map((service) => ({
          id: service.id,
          nameAr: service.nameAr,
          nameEn: service.nameEn,
          durationMinutes: service.durationMinutes,
        })),
    };
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

  /** Files a complaint against a patient the bot already resolved or created. `source: WHATSAPP`,
   *  same reasoning as `book`. Consent recorded the same way, and for the same reason: only after
   *  the write succeeds, and only if the patient has none yet. */
  @Post("complaints")
  @RequirePermission("bot.createComplaint")
  @SkipThrottle(skipAllExcept(BOT_CREDENTIAL_THROTTLER, BOT_WRITE_THROTTLER))
  async complaint(@Req() request: AuthenticatedRequest, @Body() body: BotComplaintDto) {
    const result = await createComplaint(
      this.caller(request),
      { patientId: body.patientId, description: body.description, source: "WHATSAPP", consentMessageId: body.consentMessageId },
      new Date(),
    );
    if (!result.ok) throw new NotFoundException(refusal(result.code, { resource: "patient" }));
    await ensureWhatsAppConsent(this.caller(request), body.patientId, body.consentMessageId, new Date());
    return { complaintId: result.complaintId, referenceNumber: result.referenceNumber };
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
