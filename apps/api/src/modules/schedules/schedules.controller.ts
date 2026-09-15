import { BadRequestException, Body, Controller, Delete, Get, ForbiddenException, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { CreateExceptionDto, ReplaceTemplatesDto } from "./schedules.dto.ts";
import {
  addException,
  getDoctorSchedule,
  removeException,
  replaceTemplates,
  type ScheduleCaller,
} from "./schedules.service.ts";

/**
 * Mapping only — and the one controller where `NOT_FOUND` carries extra weight.
 *
 * A DOCTOR has `own` on `doctorSchedules.manage`, so `PermissionGuard` lets them through and the
 * *service* decides whether this particular doctor is theirs. When it is not, the answer is 404,
 * identical to a doctor who does not exist. That is not politeness: producing a 403 would mean
 * having read a row the caller may not see, and would confirm which doctor ids are real.
 *
 * **`SCOPE_TOO_NARROW` is the one 403 here, and it does not weaken that rule.** It is decided from
 * the caller's role alone, on a request that names no record at all — a clinic-wide closure, which
 * is an admin act. Nothing about a row's existence is revealed by it. The reasoning is at
 * `postException`; ruled 2026-09-07.
 */
@Controller("doctors/:doctorId/schedule")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class SchedulesController {
  /** `role` and `membershipId` come from the validated token — `own` cannot be decided without them. */
  private caller(request: AuthenticatedRequest): ScheduleCaller {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  @Get()
  @RequirePermission("doctorSchedules.manage")
  async get(@Req() request: AuthenticatedRequest, @Param("doctorId", ParseUUIDPipe) doctorId: string) {
    const schedule = await getDoctorSchedule(this.caller(request), doctorId);
    if (schedule === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "doctor" }));
    return schedule;
  }

  @Put("templates")
  @RequirePermission("doctorSchedules.manage")
  async putTemplates(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @Body() body: ReplaceTemplatesDto,
  ) {
    const result = await replaceTemplates(
      this.caller(request),
      doctorId,
      body.templates.map((t) => ({ ...t, validTo: t.validTo ?? null })),
    );
    if (result.ok) return { ok: true };
    const refused = refusal(result.code, result.params);
    // **SCOPE_TOO_NARROW is a 403 -- ruled 2026-09-07.** See the note on `postException`, which is
    // the only path that can actually emit it; the branch is here because both share
    // `ScheduleWriteResult`.
    if (result.code === "SCOPE_TOO_NARROW") throw new ForbiddenException(refused);
    if (result.code === "NOT_FOUND") throw new NotFoundException(refused);
    throw new BadRequestException(refused);
  }

  @Post("exceptions")
  @RequirePermission("doctorSchedules.manage")
  async postException(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @Body() body: CreateExceptionDto,
  ) {
    // The path names the doctor; the body may say `doctorId: null` to mean clinic-wide. A body
    // that names a *different* doctor is not honoured — the path wins, so an exception can never
    // be written against a doctor the URL did not authorise.
    const result = await addException(this.caller(request), {
      doctorId: body.doctorId === null ? null : doctorId,
      date: body.date,
      type: body.type,
      startTime: body.startTime ?? null,
      endTime: body.endTime ?? null,
      reason: body.reason ?? null,
    });
    if (result.ok) return { ok: true };
    const refused = refusal(result.code, result.params);
    // **SCOPE_TOO_NARROW is a 403, and it is the one refusal here that may be** -- ruled
    // 2026-09-07, replacing the 404 it returned since it was introduced.
    //
    // The class docstring's rule still holds for everything else: a doctor asking about a doctor
    // who is not theirs gets 404, because a 403 would confirm the row exists. SCOPE_TOO_NARROW is
    // outside that rule rather than an exception to it. It is emitted on exactly one condition --
    // `doctorId === null`, a clinic-wide closure, attempted by a caller holding `own` -- and that
    // condition is decided from the caller's own role before any row is read. There is no record
    // whose existence a 403 could confirm, because the request never named one. What it confirms
    // is the caller's own permission level, which they already know.
    //
    // 404 was actively misleading here: it told a doctor that a thing they were creating did not
    // exist. 403 tells them the truth, which is that this act belongs to an admin -- the different
    // next action that earned the code its own name in the first place.
    if (result.code === "SCOPE_TOO_NARROW") throw new ForbiddenException(refused);
    if (result.code === "NOT_FOUND") throw new NotFoundException(refused);
    throw new BadRequestException(refused);
  }

  @Delete("exceptions/:exceptionId")
  @RequirePermission("doctorSchedules.manage")
  async deleteException(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) _doctorId: string,
    @Param("exceptionId", ParseUUIDPipe) exceptionId: string,
  ) {
    const result = await removeException(this.caller(request), exceptionId);
    if (result.ok) return { ok: true };
    throw new NotFoundException(refusal(result.code, result.params));
  }
}
