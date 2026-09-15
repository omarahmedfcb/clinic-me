import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UnprocessableEntityException,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { CreateTransferDto, DecideTransferDto, ListTransfersQueryDto } from "./transfers.dto.ts";
import {
  decideTransfer,
  listTransfers,
  requestTransfer,
  type TransferRefusalReason,
  type TransferResult,
  type TransferView,
} from "./transfers.service.ts";

/**
 * Patient transfers over HTTP. `PHASE-3.md` Q16/Q17/Q21, `SCHEMA-DECISIONS.md` D24.
 *
 * Mapping only — the service is the interface, and the AI tool layer will call it directly later.
 * Every refusal is a value with a machine-readable reason; this file turns those into status codes
 * in **one place**, so four routes cannot disagree about what a refusal means.
 */
@Controller("transfers")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class TransfersController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  private unwrap(result: TransferResult<TransferView>): TransferView {
    if (result.ok) return result.value;

    const code: TransferRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        // Also the answer when the caller is not the receiving doctor. A 403 there would confirm
        // the request exists and name a patient they have no business knowing about.
        throw new NotFoundException(body);
      case "ALREADY_OPEN":
      case "ALREADY_DECIDED":
        // Conflicts with the world's current state, not malformed requests. The screen that sent
        // this was simply out of date, and the message says so in a sentence. ALREADY_DECIDED
        // covers the lapsed case too since the 2026-09-07 merge; `params.status` says which.
        throw new ConflictException(body);
      case "REASON_REQUIRED":
      case "SAME_DOCTOR":
        // Well-formed and refusable on content: 422 rather than 400, which is reserved for a shape
        // the server never offered.
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  /**
   * **All three surfaces read this one endpoint**, scoped in the service by role: reception sees
   * every request in the clinic because they raise them and must see them sitting unanswered; a
   * doctor sees only requests they are a party to, from *or* to. One endpoint rather than three,
   * because three would be three chances for the screens to disagree about the same request.
   */
  @Get()
  @RequirePermission("patients.transfer.read")
  async list(@Req() request: AuthenticatedRequest, @Query() query: ListTransfersQueryDto) {
    // Parsed here, once, because the DTO keeps it a string -- see ListTransfersQueryDto.
    const openOnly = query.openOnly !== "false";
    return { transfers: await listTransfers(this.caller(request), { openOnly }) };
  }

  @Post()
  @RequirePermission("patients.transfer")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateTransferDto) {
    return this.unwrap(
      await requestTransfer(this.caller(request), {
        appointmentId: body.appointmentId,
        toDoctorId: body.toDoctorId,
        reason: body.reason ?? null,
      }),
    );
  }

  @Patch(":id/accept")
  @RequirePermission("patients.transfer")
  async accept(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: DecideTransferDto,
  ) {
    return this.unwrap(
      await decideTransfer(this.caller(request), id, "ACCEPT", {
        decisionNote: body.decisionNote ?? null,
        now: new Date(),
      }),
    );
  }

  /** Rejection carries a reason, enforced in the service: reception must know retry or escalate. */
  @Patch(":id/reject")
  @RequirePermission("patients.transfer")
  async reject(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: DecideTransferDto,
  ) {
    return this.unwrap(
      await decideTransfer(this.caller(request), id, "REJECT", {
        decisionNote: body.decisionNote ?? null,
        now: new Date(),
      }),
    );
  }
}
