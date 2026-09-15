import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { CreateServiceDto, UpdateServiceDto } from "./services.dto.ts";
import { createService, getService, listServices, updateService, type CallerContext } from "./services.service.ts";

/** Mapping only. Cross-tenant ids resolve to `null` and become 404, never 403. */
@Controller("services")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ServicesController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  /** Reading is a booking need, not a management one — reception picks the service. */
  @Get()
  @RequirePermission("appointments.read")
  async list(@Req() request: AuthenticatedRequest) {
    return listServices(this.caller(request), new Date());
  }

  @Get(":id")
  @RequirePermission("appointments.read")
  async get(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const service = await getService(this.caller(request), id, new Date());
    if (service === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "service" }));
    return service;
  }

  @Post()
  @RequirePermission("services.manage")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateServiceDto) {
    return createService(this.caller(request), body);
  }

  @Patch(":id")
  @RequirePermission("services.manage")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateServiceDto,
  ) {
    const service = await updateService(this.caller(request), id, body, new Date());
    if (service === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "service" }));
    return service;
  }
}
