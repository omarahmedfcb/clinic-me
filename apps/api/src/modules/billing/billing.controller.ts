import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  getPayerSplit,
  setPayerShare,
  type SplitRefusalReason,
  type SplitResult,
} from "./payer-split.ts";
import { applyDiscount, getDeskCharge, type DeskRefusalReason, type DeskResult } from "./desk.ts";

const METHODS = ["CASH", "CARD", "INSTAPAY", "MOBILE_WALLET", "BANK_TRANSFER"] as const;

export class ApplyDiscountDto {
  @IsInt() @Min(0) discountMinor!: number;
  /** A discount with no reason is not a discount; the database refuses one too. */
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class RecordPaymentDto {
  @IsInt() @Min(1) amountMinor!: number;
  @IsIn(METHODS) method!: (typeof METHODS)[number];
  /** Q19: absent when the money arrives before the visit completes. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() chargeId?: string | null;
  @IsUUID() patientId!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() appointmentId?: string | null;
}

export class SetPayerShareDto {
  /** Minor units, never a float and never formatted as a currency (CLAUDE.md). */
  @IsInt()
  @Min(0)
  payerShareMinor!: number;
}

/**
 * The payer split — Phase 5 PR 7.
 *
 * **`payments.record`**: this is a money decision taken at the desk, and it is the capability
 * reception already holds for taking money. It is not `clinicSettings.manage` — the split is a fact
 * about one invoice, not a configuration — and not a new capability, because adding one is a change
 * to the permission matrix that `CLAUDE.md` says to ask about rather than make in passing.
 */
@Controller("charges/:chargeId")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class BillingController {
  private caller(request: AuthenticatedRequest) {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  /** Desk refusals. Separate from the split's so each union stays exhaustive on its own codes. */
  private unwrapDesk<T>(result: DeskResult<T>): T {
    if (result.ok) return result.value;
    const code: DeskRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "ALREADY_SETTLED":
        throw new ConflictException(body);
      case "DISCOUNT_ABOVE_CEILING":
        // 403 rather than 422: the request is well formed and the amount is legal -- what is
        // missing is the caller's authority to allow it, which is a fact about the person.
        throw new ForbiddenException(body);
      case "SPLIT_EXCEEDS_CHARGE":
        throw new UnprocessableEntityException(body);
      case "COLLECTION_NOT_ALLOWED":
        throw new ForbiddenException(body);
      case "PAYMENT_EXCEEDS_BALANCE":
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  private unwrap<T>(result: SplitResult<T>): T {
    if (result.ok) return result.value;

    const code: SplitRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "ALREADY_SETTLED":
        throw new ConflictException(body);
      case "SPLIT_EXCEEDS_CHARGE":
        // Well-formed and refusable on content: 422, not 400, which is reserved for a shape the
        // server never offered.
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  /** The desk's own read: the charge, its lines, its receipts and its balance. */
  @Get()
  @RequirePermission("payments.read")
  async charge(@Req() request: AuthenticatedRequest, @Param("chargeId", ParseUUIDPipe) chargeId: string) {
    return this.unwrapDesk(await getDeskCharge(this.caller(request), chargeId));
  }

  /** Within the ceiling, at the desk. Above it, the route below — a different act by a different person. */
  @Put("discount")
  @RequirePermission("payments.record")
  async discount(
    @Req() request: AuthenticatedRequest,
    @Param("chargeId", ParseUUIDPipe) chargeId: string,
    @Body() body: ApplyDiscountDto,
  ) {
    return this.unwrapDesk(await applyDiscount(this.caller(request), chargeId, body));
  }

  /**
   * Above the ceiling, authorised by an owner or admin (ruling 4).
   *
   * A separate route because R2 takes `payments.record` away from an admin: they may no longer
   * stand at the desk taking money, and must still be able to allow a discount nobody else can.
   * `payments.adjust` is the capability that has always said exactly that.
   */
  @Put("discount/authorised")
  @RequirePermission("payments.adjust")
  async authoriseDiscount(
    @Req() request: AuthenticatedRequest,
    @Param("chargeId", ParseUUIDPipe) chargeId: string,
    @Body() body: ApplyDiscountDto,
  ) {
    return this.unwrapDesk(await applyDiscount(this.caller(request), chargeId, body));
  }

  @Get("split")
  @RequirePermission("payments.read")
  async split(@Req() request: AuthenticatedRequest, @Param("chargeId", ParseUUIDPipe) chargeId: string) {
    return this.unwrap(await getPayerSplit(this.caller(request), chargeId));
  }

  @Put("split")
  @RequirePermission("payments.record")
  async setSplit(
    @Req() request: AuthenticatedRequest,
    @Param("chargeId", ParseUUIDPipe) chargeId: string,
    @Body() body: SetPayerShareDto,
  ) {
    return this.unwrap(await setPayerShare(this.caller(request), chargeId, body.payerShareMinor));
  }
}
