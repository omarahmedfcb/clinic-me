import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { CreateDoctorDto, UpdateDoctorDto } from "./doctors.dto.ts";
import { createDoctor, getDoctor, listDoctors, updateDoctor, type CallerContext } from "./doctors.service.ts";

/** Mapping only. Cross-tenant ids resolve to `null` and become 404, never 403. */
@Controller("doctors")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class DoctorsController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  /**
   * Readable by anyone who can book, not just by clinic management. Reception has to choose a
   * doctor to book with, and §8 grants `appointments.write` to every role.
   */
  @Get()
  @RequirePermission("appointments.read")
  async list(@Req() request: AuthenticatedRequest) {
    return listDoctors(this.caller(request), new Date());
  }

  @Get(":id")
  @RequirePermission("appointments.read")
  async get(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const doctor = await getDoctor(this.caller(request), id, new Date());
    if (doctor === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "doctor" }));
    return doctor;
  }

  @Post()
  @RequirePermission("users.manage")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateDoctorDto) {
    const result = await createDoctor(this.caller(request), body);
    if (result.ok) return result.doctor;
    if (result.code === "NOT_FOUND") throw new NotFoundException(refusal(result.code, result.params));
    // The membership exists and already has a doctor record: a well-formed request that conflicts
    // with the world's current state rather than a malformed one.
    throw new UnprocessableEntityException(refusal(result.code, result.params));
  }

  @Patch(":id")
  @RequirePermission("users.manage")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateDoctorDto,
  ) {
    const doctor = await updateDoctor(this.caller(request), id, body, new Date());
    if (doctor === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "doctor" }));
    return doctor;
  }
}
