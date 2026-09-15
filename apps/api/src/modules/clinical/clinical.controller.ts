import {
  Body,
  ConflictException,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Post,
  Put,
  Param,
  ParseUUIDPipe,
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
import { getAppointmentDetail } from "../appointments/appointment-detail.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { getClinicalHistory, getClinicalSummary } from "./clinical.service.ts";
import { getAppointmentVisit } from "./visit-detail.ts";
import { openDraft, saveDraft, type DraftRefusal } from "./visit-draft.ts";
import { addClinicalProfileEntry, getClinicalProfile } from "./clinical-profile.ts";
import { SaveVisitDraftDto } from "./visit-draft.dto.ts";
import {
  AddProfileEntryDto,
  MedicationQueryDto,
  SaveInvestigationsDto,
  SavePrescriptionDto,
  SaveSickLeaveDto,
  SaveVisitAdjustmentDto,
} from "./visit-orders.dto.ts";
import { getVisitPricing, saveVisitAdjustment, type PricingRefusal } from "./visit-pricing.ts";
import {
  getInvestigations,
  getPrescription,
  recordPrescriptionPrinted,
  saveInvestigations,
  savePrescription,
  suggestMedications,
} from "./visit-orders.ts";
import { getSickLeave, recordSickLeavePrinted, saveSickLeave } from "./sick-leave.ts";
import { AddProcedureDto, AmendVisitDto, CompleteVisitDto } from "./visit-completion.dto.ts";
import { amendVisit, completeVisit, type CompletionRefusal } from "./visit-completion.ts";
import { addProcedure, getProcedures, removeProcedure } from "./visit-procedures.ts";

/**
 * The appointment detail panel's reads — `PHASE-4.md`.
 *
 * **Three endpoints, not one response shaped by role.** `CLAUDE.md` requires clinical content to be
 * separated "by separate endpoints and separate DTOs — never by filtering fields out of one
 * response". So:
 *
 * | route | capability | who |
 * |---|---|---|
 * | `/detail` | `appointments.write` | reception, admin, owner, doctor — no clinical content |
 * | `/clinical-summary` | `visits.readContent` | doctor only, enforced at the route |
 * | `/clinical-history` | `visits.readContent` | doctor only, **and** only while the patient is present |
 * | `/visit` | `visits.readContent` | doctor only, same gate as `/clinical-history` — Q18 |
 *
 * `visits.readContent` is NONE for OWNER, ADMIN and RECEPTIONIST, so `PermissionGuard` refuses the
 * clinical routes before any handler runs. Reception cannot reach either level, which is the
 * ruling — and it is refused by the matrix rather than by a branch someone could delete.
 */
@Controller("appointments/:id")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ClinicalController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  /** The non-clinical panel. Everything reception is entitled to, and nothing more. */
  @Get("detail")
  @RequirePermission("appointments.read")
  async detail(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const detail = await getAppointmentDetail(this.caller(request), id);
    if (detail === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "appointment" }));
    return detail;
  }

  /**
   * Level 1 — the safety summary. Automatic for a doctor, never behind a button.
   *
   * A read of another doctor's patient writes a `READ_SENSITIVE` audit row inside the same
   * transaction, so a summary that was served is a summary that was recorded.
   */
  @Get("clinical-summary")
  @RequirePermission("visits.readContent")
  async summary(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await getClinicalSummary(
      this.caller(request),
      request.authClaims.role,
      id,
    );
    if (result.ok) return result.value;
    throw new NotFoundException(refusal(result.refusal.code, result.refusal.params));
  }

  /**
   * Level 2 — the full record, only while the patient is with this doctor.
   *
   * `NOT_PRESENT` is 409 rather than 404 on purpose. The caller is a doctor looking at an
   * appointment they can legitimately see on a screen, so pretending it does not exist would be
   * theatre; what is withheld is the content. 409 lets the panel say "available once the patient is
   * with you", which a receptionist-facing 404 could not.
   */
  @Get("clinical-history")
  @RequirePermission("visits.readContent")
  async history(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await getClinicalHistory(
      this.caller(request),
      request.authClaims.role,
      id,
    );
    if (result.ok) return result.value;
    const body = refusal(result.refusal.code, result.refusal.params);
    if (result.refusal.code === "NOT_PRESENT") throw new ConflictException(body);
    throw new NotFoundException(body);
  }

  /**
   * One visit in full, with its attachments and revisions — Q18, revised 2026-09-05.
   *
   * **Appointment-scoped, and that is the ruling rather than a routing preference.** A visit-scoped
   * `GET /visits/:id` was built first and reversed: it needed its own ownership logic, and a second
   * ownership path is the shape this project has been bitten by repeatedly. This handler resolves
   * access through `resolveAccess` like its two siblings above, so there is one rule and the
   * transfer grant composes without being mentioned.
   *
   * `NOT_PRESENT` is 409 for the same reason `/clinical-history` returns 409 — the caller is a
   * doctor looking at an appointment they can legitimately see, so pretending it does not exist
   * would be theatre; what is withheld is the content. This also retires the 403-vs-409 split I
   * flagged on the visit-scoped version: there is now one convention because there is one path.
   */
  @Get("visit")
  @RequirePermission("visits.readContent")
  async visit(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await getAppointmentVisit(
      this.caller(request),
      request.authClaims.role,
      id,
      new Date(),
    );
    if (result.ok) return result.value;
    const body = refusal(result.refusal.code, result.refusal.params);
    if (result.refusal.code === "NOT_PRESENT") throw new ConflictException(body);
    throw new NotFoundException(body);
  }

  /**
   * Open this appointment's draft, creating one only if the caller has none.
   *
   * `POST` rather than `PUT` because it is not idempotent in the HTTP sense on first call, and
   * idempotent per author thereafter — two tabs resume one row instead of racing to make two (Q17).
   */
  @Post("visit/draft")
  @RequirePermission("visits.write")
  async startDraft(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await openDraft(this.caller(request), id, new Date());
    if (result.ok) return result.value;
    throw draftRefusal(result.refusal);
  }

  /**
   * Autosave into a draft under compare-and-set. Q4, Q7.
   *
   * The visit id is in the path rather than the appointment id: by this point the client holds a
   * draft it was given, and several drafts may exist for one appointment (Q15).
   */
  @Patch("visit/draft/:visitId")
  @RequirePermission("visits.write")
  async patchDraft(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) _appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: SaveVisitDraftDto,
  ) {
    const { expectedRevision, ...patch } = body;
    const result = await saveDraft(this.caller(request), visitId, expectedRevision, patch);
    if (result.ok) return result.value;
    throw draftRefusal(result.refusal);
  }

  /**
   * Finish the visit — Q6's completion, given a home on the screen by Q26.
   *
   * One act, one transaction: the visit becomes COMPLETED and the appointment is carried to
   * COMPLETED through the same state machine the queue uses, so the two cannot disagree.
   */
  @Post("visit/:visitId/complete")
  @RequirePermission("visits.write")
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: CompleteVisitDto,
  ) {
    const result = await completeVisit(this.caller(request), appointmentId, visitId, body, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** Correct a completed visit. A reason is required and the original is preserved (Q6). */
  @Post("visit/:visitId/amend")
  @RequirePermission("visits.write")
  async amend(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: AmendVisitDto,
  ) {
    const { reason, ...changes } = body;
    const result = await amendVisit(
      this.caller(request),
      appointmentId,
      visitId,
      { reason, changes },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** What was done at the visit, and what it cost when recorded — Q25. */
  @Get("visit/:visitId/procedures")
  @RequirePermission("visits.readContent")
  async procedures(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await getProcedures(this.caller(request), appointmentId, visitId, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Post("visit/:visitId/procedures")
  @RequirePermission("visits.write")
  async addProcedureLine(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: AddProcedureDto,
  ) {
    const result = await addProcedure(
      this.caller(request),
      appointmentId,
      visitId,
      { serviceId: body.serviceId, quantity: body.quantity ?? 1 },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** Removable only while the visit is a draft, and never reception's own consultation line. */
  @Delete("visit/:visitId/procedures/:procedureId")
  @RequirePermission("visits.write")
  async removeProcedureLine(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Param("procedureId", ParseUUIDPipe) procedureId: string,
  ) {
    const result = await removeProcedure(
      this.caller(request),
      appointmentId,
      visitId,
      procedureId,
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** The patient-level clinical profile — its own table, so reception's reads cannot reach it. */
  @Get("clinical-profile")
  @RequirePermission("visits.readContent")
  async clinicalProfile(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await getClinicalProfile(this.caller(request), id, new Date());
    if (result.ok) return result.value;
    throw draftRefusal(result.refusal);
  }

  /** Append one entry. There is no update and no delete, here or below — Q22. */
  @Post("clinical-profile")
  @RequirePermission("visits.write")
  async addProfileEntry(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AddProfileEntryDto,
  ) {
    const result = await addClinicalProfileEntry(this.caller(request), id, body, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** The prescription this visit produced — Q24's structured lines, and Q8's free text per line. */
  @Get("visit/:visitId/prescription")
  @RequirePermission("prescriptions.readItems")
  async prescription(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await getPrescription(this.caller(request), appointmentId, visitId, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** Replaced whole: the doctor edits a list, and a per-line protocol would make them reconcile two. */
  @Put("visit/:visitId/prescription")
  @RequirePermission("prescriptions.write")
  async writePrescription(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: SavePrescriptionDto,
  ) {
    const result = await savePrescription(
      this.caller(request),
      appointmentId,
      visitId,
      {
        notes: body.notes ?? null,
        // Absent and empty are the same thing on a prescription line: the DTO's optional fields
        // become explicit nulls here, so the service never has to ask which kind of missing it is.
        items: body.items.map((item) => ({
          ...item,
          strength: item.strength ?? null,
          form: item.form ?? null,
          quantity: item.quantity ?? null,
          instructions: item.instructions ?? null,
        })),
      },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /**
   * Records that the prescription was printed — Q9's `printed_count`, and the only trace printing
   * leaves. A finished visit prints, so this deliberately does not require a draft.
   */
  @Post("visit/:visitId/prescription/printed")
  @RequirePermission("prescriptions.write")
  async recordPrinted(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await recordPrescriptionPrinted(
      this.caller(request),
      appointmentId,
      visitId,
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /**
   * Sick leave — Q46. `visits.readContent` to read and `visits.write` to record, which is where it
   * belongs: the certificate is a fact about the visit, not a prescription.
   */
  /**
   * What the visit will cost, and the doctor's adjustment to it — R1.
   *
   * `visits.readContent`, because the total is the sum of what was done and what was done is
   * clinical. `mayAdjust` in the response is what makes the control appear; the write below
   * refuses regardless, so a screen that shows it anyway changes nothing.
   */
  @Get("visit/:visitId/pricing")
  @RequirePermission("visits.readContent")
  async pricing(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await getVisitPricing(this.caller(request), appointmentId, visitId, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Put("visit/:visitId/pricing")
  @RequirePermission("visits.write")
  async saveAdjustment(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: SaveVisitAdjustmentDto,
  ) {
    const result = await saveVisitAdjustment(
      this.caller(request),
      appointmentId,
      visitId,
      { adjustmentMinor: body.adjustmentMinor, reason: body.reason ?? null },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Get("visit/:visitId/sick-leave")
  @RequirePermission("visits.readContent")
  async sickLeave(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await getSickLeave(this.caller(request), appointmentId, visitId, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Put("visit/:visitId/sick-leave")
  @RequirePermission("visits.write")
  async saveSickLeaveRoute(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: SaveSickLeaveDto,
  ) {
    const result = await saveSickLeave(
      this.caller(request),
      appointmentId,
      visitId,
      { days: body.days, from: body.from, note: body.note ?? null },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /** Like the prescription's count: a finished visit still prints, so no draft is required. */
  @Post("visit/:visitId/sick-leave/printed")
  @RequirePermission("visits.write")
  async recordSickLeavePrintedRoute(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await recordSickLeavePrinted(
      this.caller(request),
      appointmentId,
      visitId,
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Get("visit/:visitId/investigations")
  @RequirePermission("visits.readContent")
  async investigations(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
  ) {
    const result = await getInvestigations(this.caller(request), appointmentId, visitId, new Date());
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  @Put("visit/:visitId/investigations")
  @RequirePermission("visits.write")
  async writeInvestigations(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) appointmentId: string,
    @Param("visitId", ParseUUIDPipe) visitId: string,
    @Body() body: SaveInvestigationsDto,
  ) {
    const result = await saveInvestigations(
      this.caller(request),
      appointmentId,
      visitId,
      { freeText: body.freeText ?? null, items: body.items.map((item) => ({ ...item, notes: item.notes ?? null })) },
      new Date(),
    );
    if (result.ok) return result.value;
    throw clinicalRefusal(result.refusal);
  }

  /**
   * What this clinic has prescribed before — Q8's autocomplete, and nothing wider.
   *
   * Appointment-scoped like its siblings so the capability gate is the same one; the query itself
   * is tenant-scoped by the extension and reaches no other clinic's list.
   */
  @Get("medications")
  @RequirePermission("visits.readContent")
  async medications(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) _appointmentId: string,
    @Query() query: MedicationQueryDto,
  ) {
    return suggestMedications(this.caller(request), query.q);
  }
}

/**
 * One place deciding a draft refusal's status, so the two routes cannot disagree.
 *
 * `STALE_REVISION` is 409: the request is well-formed and the caller may write here, but the world
 * moved. It carries the current revision so a client can refetch without a second round trip.
 */
function draftRefusal(refused: DraftRefusal) {
  return clinicalRefusal(refused);
}

/**
 * `ALREADY_COMPLETED` and `NOT_COMPLETED` are 409: the request is well-formed and the caller may
 * write here, but the visit is not in the state the act needs. The state-machine codes are 422,
 * matching what the queue's own controller returns for them.
 */
function clinicalRefusal(refused: DraftRefusal | CompletionRefusal | PricingRefusal) {
  const { code } = refused;
  const body = refusal(code, refused.params);
  if (code === "STALE_REVISION") return new ConflictException(body);
  if (code === "NOT_PRESENT") return new ConflictException(body);
  if (code === "ALREADY_COMPLETED") return new ConflictException(body);
  if (code === "NOT_COMPLETED") return new ConflictException(body);
  if (code === "QUEUE_MOVED_ON") return new ConflictException(body);
  if (code === "NOT_A_DOCTOR") return new ForbiddenException(body);
  // R1's guard: the capability is held, the clinic's permission for this person is not — or is,
  // and is capped. Both are facts about the person, which is what 403 says.
  if (code === "PRICE_ADJUSTMENT_NOT_ALLOWED") return new ForbiddenException(body);
  if (code === "PRICE_ADJUSTMENT_ABOVE_CAP") return new ForbiddenException(body);
  if (
    code === "ILLEGAL_TRANSITION" ||
    code === "TERMINAL_STATUS" ||
    code === "MISSING_CONTEXT" ||
    code === "GRACE_PERIOD_NOT_ELAPSED" ||
    code === "REASON_REQUIRED"
  ) {
    return new UnprocessableEntityException(body);
  }
  return new NotFoundException(body);
}
