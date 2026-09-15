import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Delete,
  Post,
  Put,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import type { BrandingKind } from "../attachments/domain/branding-key.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { SaveClinicIdentityDto, SaveDoctorPrintFieldsDto } from "./clinic-identity.dto.ts";
import {
  getClinicIdentity,
  getDoctorPrintIdentity,
  MAX_BRANDING_BYTES,
  putBrandingImage,
  readBrandingImage,
  removeBrandingImage,
  saveClinicIdentity,
  saveDoctorPrintFields,
  type IdentityRefusal,
} from "./clinic-identity.service.ts";

/**
 * What a printed sheet needs to name the clinic and the doctor — `PHASE-4.md` Q28.
 *
 * **Reading is a printing need, not a management one**, so the reads sit on `appointments.read` and
 * the writes on `clinicSettings.manage` — the same split `services.controller.ts` already makes and
 * for the same reason: the doctor who prints is not the person who edits the letterhead.
 *
 * Images are streamed back through this API, never served from a static path. `StorageProvider` has
 * no `url()` by design, and this controller does not invent one.
 */
@Controller("clinic-identity")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ClinicIdentityController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  private caller(request: AuthenticatedRequest): CallerContext {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  /** The tenant's country hint, from the same variable the login path reads. Never assumed +20. */
  private country(): "EG" | "SA" | "AE" {
    const configured = process.env["DEFAULT_PHONE_COUNTRY"];
    return configured === "SA" || configured === "AE" ? configured : "EG";
  }

  @Get()
  @RequirePermission("appointments.read")
  async identity(@Req() request: AuthenticatedRequest) {
    return getClinicIdentity(this.caller(request));
  }

  @Put()
  @RequirePermission("clinicSettings.manage")
  async save(@Req() request: AuthenticatedRequest, @Body() body: SaveClinicIdentityDto) {
    return saveClinicIdentity(this.caller(request), body, this.country());
  }

  @Get("doctors/:doctorId")
  @RequirePermission("appointments.read")
  async doctorIdentity(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
  ) {
    const identity = await getDoctorPrintIdentity(this.caller(request), doctorId);
    if (identity === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "doctor" }));
    return identity;
  }

  /**
   * Q36. `doctorProfile.manage` is `own` for DOCTOR and `full` for OWNER and ADMIN — the shape the
   * founder's ruling names, "admin and the doctor themselves", which no existing capability had.
   */
  @Put("doctors/:doctorId")
  @RequirePermission("doctorProfile.manage")
  async saveDoctorFields(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @Body() body: SaveDoctorPrintFieldsDto,
  ) {
    const result = await saveDoctorPrintFields(this.caller(request), doctorId, body);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  /** Clears the pointer. The stored object stays — `StorageProvider` has no `delete()` by design. */
  @Delete("logo")
  @RequirePermission("clinicSettings.manage")
  async removeLogo(@Req() request: AuthenticatedRequest) {
    return this.forget(request, { kind: "logo" });
  }

  @Delete("doctors/:doctorId/signature")
  @RequirePermission("doctorProfile.manage")
  async removeSignature(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
  ) {
    return this.forget(request, { kind: "signature", doctorId });
  }

  @Delete("doctors/:doctorId/stamp")
  @RequirePermission("doctorProfile.manage")
  async removeStamp(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
  ) {
    return this.forget(request, { kind: "stamp", doctorId });
  }

  @Post("logo")
  @RequirePermission("clinicSettings.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BRANDING_BYTES + 1, files: 1 } }))
  async uploadLogo(@Req() request: AuthenticatedRequest, @UploadedFile() file?: { buffer: Buffer }) {
    return this.store(request, { kind: "logo" }, file);
  }

  @Get("logo")
  @RequirePermission("appointments.read")
  async logo(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.stream(request, { kind: "logo" }, response);
  }

  @Post("doctors/:doctorId/signature")
  @RequirePermission("doctorProfile.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BRANDING_BYTES + 1, files: 1 } }))
  async uploadSignature(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.store(request, { kind: "signature", doctorId }, file);
  }

  @Get("doctors/:doctorId/signature")
  @RequirePermission("appointments.read")
  async signature(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @Res() response: Response,
  ) {
    return this.stream(request, { kind: "signature", doctorId }, response);
  }

  @Post("doctors/:doctorId/stamp")
  @RequirePermission("doctorProfile.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BRANDING_BYTES + 1, files: 1 } }))
  async uploadStamp(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.store(request, { kind: "stamp", doctorId }, file);
  }

  @Get("doctors/:doctorId/stamp")
  @RequirePermission("appointments.read")
  async stamp(
    @Req() request: AuthenticatedRequest,
    @Param("doctorId", ParseUUIDPipe) doctorId: string,
    @Res() response: Response,
  ) {
    return this.stream(request, { kind: "stamp", doctorId }, response);
  }

  private async forget(
    request: AuthenticatedRequest,
    target: { kind: BrandingKind; doctorId?: string },
  ) {
    const result = await removeBrandingImage(this.caller(request), target);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  private async store(
    request: AuthenticatedRequest,
    target: { kind: BrandingKind; doctorId?: string },
    file?: { buffer: Buffer },
  ) {
    if (file === undefined) throw new BadRequestException(refusal("NO_FILE_UPLOADED"));
    const result = await putBrandingImage(this.caller(request), this.storage, target, file.buffer);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  private async stream(
    request: AuthenticatedRequest,
    target: { kind: BrandingKind; doctorId?: string },
    response: Response,
  ) {
    const image = await readBrandingImage(this.caller(request), this.storage, target);
    if (image === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "attachment" }));
    // `nosniff` because the type is the sniffed one, not the uploader's claim, and a browser that
    // guesses differently would be guessing about content this API has already decided.
    response.setHeader("content-type", image.mimeType);
    response.setHeader("x-content-type-options", "nosniff");
    response.send(image.bytes);
  }
}

/** Exported so profile photos map the same refusals to the same status codes, not near-enough ones. */
export function imageRefusal(refused: IdentityRefusal) {
  const body = refusal(refused.code, refused.params);
  if (refused.code === "TOO_LARGE") return new PayloadTooLargeException(body);
  if (refused.code === "NOT_FOUND") return new NotFoundException(body);
  if (refused.code === "EMPTY_FILE") return new BadRequestException(body);
  return new UnsupportedMediaTypeException(body);
}
