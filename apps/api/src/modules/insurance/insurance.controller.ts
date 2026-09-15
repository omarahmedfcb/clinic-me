import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { RecordCoverageDto, UpdatePolicyDto } from "./insurance.dto.ts";
import {
  getPatientCoverage,
  recordCoverage,
  removeCoverage,
  updatePolicy,
  type InsuranceCaller,
  type InsuranceRefusalReason,
  type InsuranceResult,
} from "./insurance.service.ts";

/**
 * Patient insurance over HTTP. `PHASE-3.md` Q18.
 *
 * Mapping only — the service is the interface, and the AI tool layer will call it directly.
 *
 * **`patients.write`, and that `FULL` is correct rather than merely permissive.** Q23 settled that
 * a patient belongs to the clinic and not to a doctor, so there is no `own` to enforce here and no
 * caller-identity narrowing to add. Said explicitly because Q25's finding is that this capability
 * governs more than one kind of act and its level is right for only some of them — insurance is one
 * of the ones it is right for, and a future reader should not have to re-derive that.
 *
 * **Nothing here is clinical.** Insurer, policy number, dates and a relationship are administrative
 * facts reception needs at the desk. This controller is therefore not an exception to the
 * doctor-only rule and does not need one.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class InsuranceController {
  private caller(request: AuthenticatedRequest): InsuranceCaller {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  private unwrap<T>(result: InsuranceResult<T>): T {
    if (result.ok) return result.value;

    const code: InsuranceRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "NO_CONTACT_RECORD":
        // The patient exists and the request is well formed; what is missing is a prerequisite the
        // caller can go and create. 422, alongside INVALID_WINDOW, rather than 404.
        throw new UnprocessableEntityException(body);
      case "DUPLICATE_POLICY":
        // A conflict with the world's current state, not a malformed request: the screen that sent
        // this was out of date.
        throw new ConflictException(body);
      case "INVALID_WINDOW":
        // Well-formed and refusable on content: 422, not 400, which is reserved for a shape the
        // server never offered.
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  /**
   * Everything the detail screen and the check-in panel render, partitioned into active, lapsed and
   * future.
   *
   * One endpoint for both surfaces rather than two, for the reason the transfers list gives: two
   * endpoints are two chances for the screens to disagree about the same patient — and disagreeing
   * about whether someone is covered is disagreeing about whether they are asked to pay.
   */
  @Get("patients/:id/insurance")
  @RequirePermission("patients.read")
  async coverage(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const coverage = await getPatientCoverage(this.caller(request), id, new Date());
    // Null means "not visible to you", which covers both "no such patient" and "another tenant's".
    if (coverage === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return coverage;
  }

  @Post("patients/:id/insurance")
  @RequirePermission("patients.write")
  async record(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RecordCoverageDto,
  ) {
    return this.unwrap(
      await recordCoverage(this.caller(request), id, {
        insurerName: body.insurerName,
        policyNumber: body.policyNumber,
        policyholderName: body.policyholderName,
        validFrom: body.validFrom.slice(0, 10),
        validTo: body.validTo === undefined || body.validTo === null ? null : body.validTo.slice(0, 10),
        relationshipToPolicyholder: body.relationshipToPolicyholder,
      }),
    );
  }

  /** Corrects the shared policy — see the service note on why that is deliberate. */
  @Patch("insurance-policies/:policyId")
  @RequirePermission("patients.write")
  async amend(
    @Req() request: AuthenticatedRequest,
    @Param("policyId", ParseUUIDPipe) policyId: string,
    @Body() body: UpdatePolicyDto,
  ) {
    return this.unwrap(
      await updatePolicy(this.caller(request), policyId, {
        ...(body.insurerName === undefined ? {} : { insurerName: body.insurerName }),
        ...(body.policyNumber === undefined ? {} : { policyNumber: body.policyNumber }),
        ...(body.policyholderName === undefined ? {} : { policyholderName: body.policyholderName }),
        ...(body.validFrom === undefined ? {} : { validFrom: body.validFrom.slice(0, 10) }),
        ...(body.validTo === undefined
          ? {}
          : { validTo: body.validTo === null ? null : body.validTo.slice(0, 10) }),
      }),
    );
  }

  /** Removes this patient from a policy. The policy itself survives — the household may still be on it. */
  @Delete("insurance-coverage/:coverageId")
  @RequirePermission("patients.write")
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param("coverageId", ParseUUIDPipe) coverageId: string,
  ) {
    return this.unwrap(await removeCoverage(this.caller(request), coverageId));
  }
}
