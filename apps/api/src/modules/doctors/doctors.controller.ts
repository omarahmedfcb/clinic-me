import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
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

  /** The clinic's own country, for parsing a typed number. Never assumed to be Egypt (CLAUDE.md). */
  private country(): "EG" | "SA" | "AE" {
    const configured = process.env["DEFAULT_PHONE_COUNTRY"];
    return configured === "SA" || configured === "AE" ? configured : "EG";
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
    const result = await createDoctor(this.caller(request), body, this.country());
    // The temporary password is returned here and nowhere else: it is hashed on the way in.
    if (result.ok) return { doctor: result.doctor, temporaryPassword: result.temporaryPassword };
    // Taken by somebody already in this clinic: a well-formed request that conflicts with current state.
    if (result.code === "ALREADY_A_MEMBER") throw new ConflictException(refusal(result.code, result.params));
    throw new BadRequestException(refusal(result.code, result.params));
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
