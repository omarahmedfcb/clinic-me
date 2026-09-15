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
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { CreateInsuranceCompanyDto, UpdateInsuranceCompanyDto } from "./insurance.dto.ts";
import {
  createInsuranceCompany,
  listInsuranceCompanies,
  selectableInsuranceCompanies,
  updateInsuranceCompany,
  type CompanyRefusalReason,
  type CompanyResult,
} from "./insurance-companies.service.ts";

/**
 * The insurance company registry — `PHASE-5-PLAN.md` PR 1.
 *
 * **`clinicSettings.manage` rather than a new capability**, and the choice is deliberate: the
 * registry is clinic configuration, the capability is already OWNER and ADMIN only, and adding a
 * capability is a change to the permission matrix — which `CLAUDE.md` says to ask about rather than
 * make in passing.
 *
 * **The selectable list is the exception, and it is `patients.write`.** Reception attaches a policy
 * and must see the companies to attach it to; it can read the names it may choose from and nothing
 * else about a contract. Two routes rather than a role check inside one, because a list that
 * changes shape by caller is the pattern `CLAUDE.md` forbids for clinical content and is no better
 * here.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class InsuranceCompaniesController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  private unwrap<T>(result: CompanyResult<T>): T {
    if (result.ok) return result.value;

    const code: CompanyRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "DUPLICATE_COMPANY":
        // A conflict with the world's current state, not a malformed request.
        throw new ConflictException(body);
      case "INVALID_WINDOW":
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  @Get("insurance-companies")
  @RequirePermission("clinicSettings.manage")
  async list(@Req() request: AuthenticatedRequest, @Query("includeInactive") includeInactive?: string) {
    return listInsuranceCompanies(this.caller(request), includeInactive === "true");
  }

  /** Names only, active only — what reception picks from when attaching a policy. */
  @Get("insurance-companies/selectable")
  @RequirePermission("patients.write")
  async selectable(@Req() request: AuthenticatedRequest) {
    return selectableInsuranceCompanies(this.caller(request));
  }

  @Post("insurance-companies")
  @RequirePermission("clinicSettings.manage")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateInsuranceCompanyDto) {
    return this.unwrap(await createInsuranceCompany(this.caller(request), body));
  }

  @Patch("insurance-companies/:companyId")
  @RequirePermission("clinicSettings.manage")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("companyId", ParseUUIDPipe) companyId: string,
    @Body() body: UpdateInsuranceCompanyDto,
  ) {
    return this.unwrap(await updateInsuranceCompany(this.caller(request), companyId, body));
  }
}
