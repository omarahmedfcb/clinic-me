import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { RecordPaymentDto } from "./billing.controller.ts";
import { recordPayment } from "./desk.ts";
import {
  applyCreditToCharge,
  getCreditLedger,
  refundCredit,
  type CreditResult,
} from "./patient-credit.ts";
import { getPaymentsOverview } from "./payments-overview.ts";
import { getPaymentsReport } from "./payments-report.ts";

/** A day (`YYYY-MM-DD`) or a month (`YYYY-MM`); absent means the clinic's own today. */
export class PaymentsReportDto {
  @IsOptional() @IsIn(["DAY", "MONTH"]) period?: "DAY" | "MONTH";
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}(-\d{2})?$/) on?: string;
}

/** Minor units, like every amount here. One is the smallest movement there is. */
export class ApplyCreditDto {
  @IsInt() @Min(1) amountMinor!: number;
}

/** A refund is given on request **with a reason**, so the reason is required rather than optional. */
export class RefundCreditDto {
  @IsInt() @Min(1) amountMinor!: number;
  @IsString() @IsNotEmpty() @MaxLength(300) reason!: string;
}

/**
 * Payments that are not scoped to one charge: the «المدفوعات» screen and taking money.
 *
 * **The two halves are separate capabilities on purpose (R2).** `payments.read` carries the screen,
 * which an admin sees in full; `payments.record` carries the act, which an admin does not hold.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class BillingActionsController {
  private caller(request: AuthenticatedRequest) {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  @Get("payments/overview")
  @RequirePermission("payments.read")
  async overview(@Req() request: AuthenticatedRequest) {
    return getPaymentsOverview(this.caller(request), new Date());
  }

  /**
   * «تقارير المدفوعات» — Phase 5 PR 14. Read-only, and there is no write route beside it.
   *
   * `reports.financial`, which is NONE for reception and **own** for a doctor. The narrowing is
   * done in the service against the caller's own doctor row, never from the query string.
   */
  @Get("reports/payments")
  @RequirePermission("reports.financial")
  async report(@Req() request: AuthenticatedRequest, @Query() query: PaymentsReportDto) {
    const result = await getPaymentsReport(
      this.caller(request),
      // The same default the screen opens on, so a caller that omits it gets the useful period
      // rather than the one that is empty every morning (ruled 2026-09-14).
      { period: query.period ?? "MONTH", on: query.on },
      new Date(),
    );
    // Well formed and refusable on content: a month that is not a month.
    if (!result.ok) throw new UnprocessableEntityException(refusal("INVALID_PERIOD", {}));
    return result.value;
  }

  /** Q19: `chargeId` may be absent, and the payment waits for a charge to attach itself to. */
  @Post("payments")
  @RequirePermission("payments.record")
  async pay(@Req() request: AuthenticatedRequest, @Body() body: RecordPaymentDto) {
    const result = await recordPayment(
      this.caller(request),
      {
        chargeId: body.chargeId ?? null,
        patientId: body.patientId,
        appointmentId: body.appointmentId ?? null,
        amountMinor: body.amountMinor,
        method: body.method,
      },
      new Date(),
    );
    if (result.ok) return result.value;
    const payload = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(payload);
    // The doctor holds the capability and not the clinic's permission to use it: a fact about the
    // person, which is what 403 says.
    if (result.code === "COLLECTION_NOT_ALLOWED") throw new ForbiddenException(payload);
    // Well formed and refusable on content, like the payer split: 422, not 400.
    if (result.code === "PAYMENT_EXCEEDS_BALANCE") throw new UnprocessableEntityException(payload);
    throw new BadRequestException(payload);
  }

  /**
   * Clinic credit — ruling 5.
   *
   * Reading the ledger sits on `payments.read`, which reception holds: the balance is the first
   * thing asked at the desk. Spending and refunding sit on `payments.record`, the same capability
   * taking money needs — giving it back is not a lesser act than receiving it.
   */
  @Get("patients/:patientId/credit")
  @RequirePermission("payments.read")
  async credit(
    @Req() request: AuthenticatedRequest,
    @Param("patientId", ParseUUIDPipe) patientId: string,
  ) {
    const result = await getCreditLedger(this.caller(request), patientId);
    if (result.ok) return result.value;
    throw new NotFoundException(refusal(result.code, result.params));
  }

  @Post("charges/:chargeId/credit")
  @RequirePermission("payments.record")
  async applyCredit(
    @Req() request: AuthenticatedRequest,
    @Param("chargeId", ParseUUIDPipe) chargeId: string,
    @Body() body: ApplyCreditDto,
  ) {
    return this.unwrapCredit(
      await applyCreditToCharge(this.caller(request), { chargeId, amountMinor: body.amountMinor }),
    );
  }

  @Post("patients/:patientId/credit/refund")
  @RequirePermission("payments.record")
  async refund(
    @Req() request: AuthenticatedRequest,
    @Param("patientId", ParseUUIDPipe) patientId: string,
    @Body() body: RefundCreditDto,
  ) {
    return this.unwrapCredit(
      await refundCredit(this.caller(request), {
        patientId,
        amountMinor: body.amountMinor,
        reason: body.reason,
      }),
    );
  }

  private unwrapCredit<T>(result: CreditResult<T>): T {
    if (result.ok) return result.value;
    const payload = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(payload);
    // Well formed and refused on content: there is not that much credit, or not that much owed.
    if (result.code === "INSUFFICIENT_CREDIT") throw new UnprocessableEntityException(payload);
    if (result.code === "PAYMENT_EXCEEDS_BALANCE") throw new UnprocessableEntityException(payload);
    throw new BadRequestException(payload);
  }
}
