import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { imageRefusal } from "../clinic-identity/clinic-identity.controller.ts";
import { MAX_BRANDING_BYTES } from "../clinic-identity/clinic-identity.service.ts";
import { clearUserPhoto, putUserPhoto, readUserPhoto } from "./user-photo.service.ts";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  createStaff,
  listStaff,
  resetStaffPassword,
  setStaffStatus,
  updateMyDetails,
  updateStaff,
  STAFF_ROLES,
  type StaffRefusalReason,
  type StaffResult,
} from "./staff.service.ts";

export class CreateStaffDto {
  @IsString() @IsNotEmpty() @MaxLength(120) fullName!: string;
  /** Any notation a human types; parsed with the clinic's country as the hint (CLAUDE.md). */
  @IsString() @IsNotEmpty() @MaxLength(40) phone!: string;
  /** Doctors are not created here — the Doctors tab owns that record. */
  @IsIn(STAFF_ROLES) role!: (typeof STAFF_ROLES)[number];
}

/** Any subset: the dialog sends what was changed. Every field is re-validated as if it were new. */
export class UpdateStaffDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(STAFF_ROLES) role?: (typeof STAFF_ROLES)[number];
}

/** «بياناتي». Name and phone only — there is deliberately no `role` here to send. */
export class UpdateMyDetailsDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) phone?: string;
}

export class SetStatusDto {
  @IsIn(["ACTIVE", "SUSPENDED"]) status!: "ACTIVE" | "SUSPENDED";
}

/**
 * «المستخدمون» — Phase 5 PR 10. **Admin only**, through `users.manage`.
 *
 * The temporary password appears in exactly one place: the response to the request that created it.
 * It is Argon2-hashed on the way in, so no later read can produce it and no second request can
 * recover it — which is what "shown once" has to mean to be worth saying.
 */
@Controller("staff")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class StaffController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  /** The clinic's own country, for parsing a typed number. Never assumed to be Egypt (CLAUDE.md). */
  private country(): "EG" | "SA" | "AE" {
    const configured = process.env["DEFAULT_PHONE_COUNTRY"];
    return configured === "SA" || configured === "AE" ? configured : "EG";
  }

  private unwrap<T>(result: StaffResult<T>): T {
    if (result.ok) return result.value;
    const code: StaffRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "ALREADY_A_MEMBER":
      case "DUPLICATE_PHONE":
        throw new ConflictException(body);
      case "NOT_EDITABLE_HERE":
      case "OWNER_ROLE_FIXED":
      case "SELF_ROLE_CHANGE":
        // Well formed, and refused on content: that record belongs elsewhere, or to somebody else.
        throw new UnprocessableEntityException(body);
      case "LAST_ADMIN":
      case "SELF_SUSPEND":
        // Well formed and refusable on content: the clinic would be left with nobody to administer
        // it, or the caller would be locked out of the screen that undoes what they just did.
        throw new UnprocessableEntityException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  @Get()
  @RequirePermission("users.manage")
  async list(@Req() request: AuthenticatedRequest) {
    return listStaff(this.caller(request));
  }

  @Post()
  @RequirePermission("users.manage")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateStaffDto) {
    return this.unwrap(
      await createStaff(
        this.caller(request),
        { fullName: body.fullName, phone: body.phone, role: body.role },
        this.country(),
      ),
    );
  }

  /**
   * «بياناتي» — your own name and phone, whatever your role. Ruled 2026-09-13.
   *
   * **Declared before `:membershipId`**, or Nest matches that first and refuses a receptionist with
   * `users.manage` — which is exactly what happened the first time. **No role field exists on the
   * DTO**, so this path cannot carry one even by accident; ruling out the field is stronger than
   * refusing the value, and `forbidNonWhitelisted` turns an attempt into a 400.
   */
  @Patch("me")
  @RequirePermission("appointments.read")
  async updateMine(@Req() request: AuthenticatedRequest, @Body() body: UpdateMyDetailsDto) {
    return this.unwrap(
      await updateMyDetails(
        this.caller(request),
        request.authClaims.membershipId,
        {
          ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
        },
        this.country(),
      ),
    );
  }

  @Patch(":membershipId")
  @RequirePermission("users.manage")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() body: UpdateStaffDto,
  ) {
    return this.unwrap(
      await updateStaff(
        this.caller(request),
        membershipId,
        {
          ...(body.fullName === undefined ? {} : { fullName: body.fullName }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.role === undefined ? {} : { role: body.role }),
        },
        this.country(),
      ),
    );
  }

  @Post(":membershipId/status")
  @RequirePermission("users.manage")
  async status(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Body() body: SetStatusDto,
  ) {
    return this.unwrap(await setStaffStatus(this.caller(request), membershipId, body.status));
  }

  @Post(":membershipId/password")
  @RequirePermission("users.manage")
  async resetPassword(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
  ) {
    return this.unwrap(await resetStaffPassword(this.caller(request), membershipId));
  }

  /**
   * **Your own photo, whatever your role** — the founder's ruling of 2026-09-13.
   *
   * Declared before the `:membershipId` routes, because `ParseUUIDPipe` would otherwise reject the
   * literal `me` with a 400. `appointments.read` rather than `users.manage`: a doctor or a
   * receptionist setting their own face needs no authority over anybody else's account, and widening
   * `users.manage` to let them would have handed them the whole users list.
   *
   * The membership comes from the validated token, never the path, so "me" cannot name anybody else.
   */
  @Post("me/photo")
  @RequirePermission("appointments.read")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BRANDING_BYTES + 1, files: 1 } }))
  async uploadMyPhoto(@Req() request: AuthenticatedRequest, @UploadedFile() file?: { buffer: Buffer }) {
    if (file === undefined) throw new BadRequestException(refusal("NO_FILE_UPLOADED"));
    const result = await putUserPhoto(
      this.caller(request),
      this.storage,
      request.authClaims.membershipId,
      file.buffer,
    );
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  @Delete("me/photo")
  @RequirePermission("appointments.read")
  async removeMyPhoto(@Req() request: AuthenticatedRequest) {
    const result = await clearUserPhoto(this.caller(request), request.authClaims.membershipId);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  /**
   * The profile photo. Uploaded by whoever manages users; **readable by everyone in the clinic**,
   * because it is drawn as an avatar beside a name on screens every role uses.
   *
   * Streamed back through this API, never served from a static path: `StorageProvider` has no
   * `url()` by design and this controller does not invent one.
   */
  @Post(":membershipId/photo")
  @RequirePermission("users.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BRANDING_BYTES + 1, files: 1 } }))
  async uploadPhoto(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (file === undefined) throw new BadRequestException(refusal("NO_FILE_UPLOADED"));
    const result = await putUserPhoto(this.caller(request), this.storage, membershipId, file.buffer);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  /** Clears the pointer. The stored object stays — `StorageProvider` has no `delete()` by design. */
  @Delete(":membershipId/photo")
  @RequirePermission("users.manage")
  async removePhoto(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
  ) {
    const result = await clearUserPhoto(this.caller(request), membershipId);
    if (result.ok) return result.value;
    throw imageRefusal(result.refusal);
  }

  @Get(":membershipId/photo")
  @RequirePermission("appointments.read")
  async photo(
    @Req() request: AuthenticatedRequest,
    @Param("membershipId", ParseUUIDPipe) membershipId: string,
    @Res() response: Response,
  ) {
    const image = await readUserPhoto(this.caller(request), this.storage, membershipId);
    if (image === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "attachment" }));
    // `nosniff`: the type is the sniffed one, not the uploader's claim.
    response.setHeader("content-type", image.mimeType);
    response.setHeader("x-content-type-options", "nosniff");
    response.send(image.bytes);
  }
}
