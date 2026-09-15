import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { linkPatients, listRelations, unlinkPatients } from "./patient-relations.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { actorContext } from "../../common/actor-context.ts";
import {
  CreatePatientDto,
  HouseholdQueryDto,
  LinkPatientDto,
  ListPatientsDto,
  MyPatientsDto,
  SearchPatientsDto,
  UpdatePatientDto,
} from "./patients.dto.ts";
import { listMyPatients } from "./my-patients.ts";
import {
  createPatient,
  getPatient,
  householdByPhone,
  getOutstandingBalance,
  listAppointmentHistory,
  listRecentPatients,
  listVisitHistory,
  searchPatients,
  updatePatient,
  type CallerContext,
} from "./patients.service.ts";

/**
 * The HTTP face of the patients service. **Mapping only** — no business logic lives here, because
 * the AI tool layer (ARCHITECTURE.md §12) calls the service directly and would not see it.
 *
 * ## The cross-tenant 404, finally
 *
 * PHASE-1.md §2b carried this convention forward for the first controller that could get it wrong.
 * This is that controller.
 *
 * A tenant-scoped lookup returning `null` maps to `NotFoundException`. There is deliberately **no
 * ownership check anywhere in this file** — nothing that fetches a patient, compares its `tenantId`
 * to the caller's, and throws `ForbiddenException`. Such a check would be worse than redundant: to
 * write it you would first have to read a row you are not entitled to see, and its 403 would
 * confirm that the record exists, which is the exact disclosure the 404 convention prevents.
 *
 * By the time this method runs, the tenant-scoping extension has injected the tenant filter and
 * Postgres RLS has enforced it underneath, so another tenant's patient is *indistinguishable from
 * one that never existed*. 404 is therefore the truthful answer, not a diplomatic one.
 *
 * `patients-cross-tenant-404.integration.spec.ts` proves it over real HTTP, which is the DoD item
 * that has been open since Phase 1.
 */
@Controller("patients")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class PatientsController {
  /** Identity for the service layer, taken only from the validated token and the bound actor. */
  private caller(request: AuthenticatedRequest): CallerContext {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  @Get()
  @RequirePermission("patients.read")
  async search(@Req() request: AuthenticatedRequest, @Query() query: SearchPatientsDto) {
    return searchPatients(this.caller(request), query.q, query.limit);
  }

  @Post()
  @RequirePermission("patients.write")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreatePatientDto) {
    return createPatient(this.caller(request), {
      ...body,
      dateOfBirth: body.dateOfBirth === undefined ? null : new Date(body.dateOfBirth),
    });
  }

  /** Kinship, both directions — Q30. A family, not D28's shared-phone household. */
  @Get(":id/relations")
  @RequirePermission("patients.read")
  async relations(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return { relations: await listRelations(this.caller(request), id) };
  }

  @Post(":id/relations")
  @RequirePermission("patients.write")
  async link(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: LinkPatientDto,
  ) {
    const result = await linkPatients(this.caller(request), id, body.relatedPatientId, body.relation);
    if (result.ok) return { ok: true };
    if (result.code === "NOT_FOUND") {
      throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    }
    throw new ConflictException(refusal("ALREADY_LINKED", {}));
  }

  @Delete(":id/relations/:relatedId")
  @RequirePermission("patients.write")
  async unlink(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("relatedId", ParseUUIDPipe) relatedId: string,
  ) {
    const result = await unlinkPatients(this.caller(request), id, relatedId);
    if (result.ok) return { ok: true };
    throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
  }

  /**
   * Who already answers to this phone — D28. Asked by intake before it writes.
   *
   * `patients.read`, not `patients.write`: it answers a question about existing records, and a
   * receptionist who may not create a patient may still need to know the number is taken.
   *
   * Declared before `@Get(":id")`, like `/recent`: Nest matches in declaration order, and
   * `/patients/household` would otherwise reach `ParseUUIDPipe` and 400 on a path that exists.
   */
  @Get("household")
  @RequirePermission("patients.read")
  async household(@Req() request: AuthenticatedRequest, @Query() query: HouseholdQueryDto) {
    const found = await householdByPhone(this.caller(request), query.phoneE164);
    return { household: found };
  }

  /**
   * The patient book, most recently seen first. `PHASE-4.md`, ruled 2026-09-03.
   *
   * **Declared before `@Get(":id")` deliberately.** Nest matches routes in declaration order, so
   * putting this after the parameterised route would send `/patients/recent` into `ParseUUIDPipe`
   * and answer 400 for a path that exists.
   *
   * `patients.browse`, not `patients.write`: the founder ruled the book is reception's and admin's,
   * and doctors reach patients through their own queue and history. See the note in
   * `permissions.ts` for what that does and does not protect.
   */
  @Get("recent")
  @RequirePermission("patients.browse")
  async recent(@Req() request: AuthenticatedRequest, @Query() query: ListPatientsDto) {
    return listRecentPatients(this.caller(request), query.limit, query.offset);
  }

  /**
   * «مرضاي» — R-B, 2026-09-14. The patients this doctor has treated, and search within them.
   *
   * `patients.read`, not `patients.browse`: browse is the clinic's whole book and is NONE for a
   * doctor by the founder's 2026-09-03 ruling, which this does not disturb. This answers "show me
   * the patients I have seen", which is the narrower question `patients.read` already covers — and
   * the narrowing is done by the caller's own doctor row, never by anything in the request.
   *
   * Declared before `@Get(":id")` for the reason `/recent` and `/household` are.
   */
  @Get("mine")
  @RequirePermission("patients.read")
  async mine(@Req() request: AuthenticatedRequest, @Query() query: MyPatientsDto) {
    const result = await listMyPatients(this.caller(request), request.authClaims.membershipId, {
      search: query.q,
      limit: query.limit,
      offset: query.offset,
    });
    // Not a doctor at all: there is no such list, rather than an empty one. 403 because the caller
    // is the reason — the same shape `COLLECTION_NOT_ALLOWED` uses for a fact about the person.
    if (!result.ok) throw new ForbiddenException(refusal("NOT_A_DOCTOR", {}));
    return result.value;
  }

  @Get(":id")
  @RequirePermission("patients.read")
  async byId(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const patient = await getPatient(this.caller(request), id);
    // The one line this convention is about. Null means "not visible to you", which covers both
    // "does not exist" and "belongs to another tenant" -- and they are the same answer on purpose.
    if (patient === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return patient;
  }

  /**
   * Reception corrects demographics and contact details. `PHASE-3.md` Q18.
   *
   * `patients.write`, which is `FULL` for all four staff roles — and unlike the day view or the
   * transfer request, that `FULL` is **correct here rather than merely permissive**. Q23 settled
   * it: a patient belongs to the clinic, not to a doctor, so there is no `own` to enforce and no
   * caller-identity narrowing to add. Recorded explicitly because Q25's whole finding is that this
   * capability governs more than one kind of act and its level is right for only some of them; this
   * is one of the ones it is right for.
   *
   * A patient in another tenant is 404 by the same route as every read above: the service returns
   * `null` because the row is not visible, never because a comparison failed.
   */
  @Patch(":id")
  @RequirePermission("patients.write")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdatePatientDto,
  ) {
    // Destructured rather than spread-then-overridden: the DTO's `dateOfBirth` is a string and the
    // service's is a Date, and a spread would keep the string in the inferred type. The compiler
    // caught exactly that, which is the `injected()` argument in miniature — a cast here would have
    // silenced the whole object, not just this field.
    const { dateOfBirth, ...rest } = body;
    const patient = await updatePatient(this.caller(request), id, {
      ...rest,
      // Present-but-null must survive as null ("clear it"); absent must stay absent ("leave alone").
      ...(dateOfBirth === undefined
        ? {}
        : { dateOfBirth: dateOfBirth === null ? null : new Date(dateOfBirth) }),
    });
    if (patient === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return patient;
  }

  /**
   * Visit **metadata**. Never clinical content: diagnosis, examination, plan and notes are
   * doctor-only and belong to a separate endpoint with a separate DTO (CLAUDE.md), not to a
   * filtered version of this one.
   *
   * The patient is fetched first so that an unknown or other-tenant id is a 404 rather than an
   * empty list. An empty list would be a *different* wrong answer: it says "this patient has no
   * visits", which is a statement about a patient the caller cannot see.
   */
  @Get(":id/visits")
  @RequirePermission("visits.readIndex")
  async visits(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const caller = this.caller(request);
    const patient = await getPatient(caller, id);
    if (patient === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return listVisitHistory(caller, id);
  }

  /**
   * Appointment history — scheduling facts, never clinical ones.
   *
   * `patients.write` rather than `visits.readIndex`: an appointment is a scheduling record and
   * reception owns it. Deliberately **not** the same list as `/visits` — a cancelled or no-showed
   * appointment produces no visit and would vanish there, while being exactly what reception needs
   * when a patient says "but I came last Tuesday".
   */
  @Get(":id/appointments")
  @RequirePermission("patients.read")
  async appointments(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const caller = this.caller(request);
    const patient = await getPatient(caller, id);
    if (patient === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return listAppointmentHistory(caller, id);
  }

  /**
   * Outstanding balance, read from the generated column and never recomputed (D7).
   *
   * Fetched behind the patient lookup so an unknown or other-tenant id is 404 rather than a
   * confident `0` — "this patient owes nothing" is a statement about a patient the caller may not
   * be entitled to know exists.
   */
  @Get(":id/balance")
  @RequirePermission("patients.read")
  async balance(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const caller = this.caller(request);
    const patient = await getPatient(caller, id);
    if (patient === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "patient" }));
    return getOutstandingBalance(caller, id);
  }
}
