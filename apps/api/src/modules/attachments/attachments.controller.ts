import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  PayloadTooLargeException,
  Req,
  Res,
  UnprocessableEntityException,
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
import { UploadAttachmentDto } from "./attachments.dto.ts";
import {
  archiveAttachment,
  listPatientAttachments,
  readAttachmentContent,
  uploadAttachment,
  type AttachmentCaller,
  type AttachmentRefusalReason,
  type AttachmentResult,
} from "./attachments.service.ts";
import { MAX_ATTACHMENT_BYTES } from "./storage/storage.config.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage/storage-provider.ts";

/**
 * Attachments over HTTP. `PHASE-4.md` Q10, Q11.
 *
 * Mapping only — the service is the interface, and the AI tool layer will call it directly.
 *
 * ## Every route here is doctor-only, and that is the whole access story at this layer
 *
 * Writes take `visits.write` and reads take `visits.readContent`; both are `FULL` for `DOCTOR` and
 * `NONE` for `OWNER`, `ADMIN`, `RECEPTIONIST` and `AI_AGENT`. So a reception token is refused by
 * `PermissionGuard` **before any handler runs** — which is what the Definition of Done means by
 * "a reception token cannot fetch attachment content", and it is why that box is provable with a
 * token and no fixtures.
 *
 * Whether *this* doctor may see *this* patient's file is a separate question the guard cannot
 * answer, and it lives in the service where the row is in hand.
 */

/**
 * The shape `FileInterceptor` hands back, named locally.
 *
 * `@types/multer` is deliberately not a dependency: these four fields are all this controller
 * touches, and declaring them here keeps a types package out of the tree for a type we use once.
 * `multer` itself is not a new dependency either — it is a direct dependency of
 * `@nestjs/platform-express`, which is already here.
 */
interface UploadedMultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AttachmentsController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  private caller(request: AuthenticatedRequest): AttachmentCaller {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      membershipId: request.authClaims.membershipId,
    };
  }

  private unwrap<T>(result: AttachmentResult<T>): T {
    if (result.ok) return result.value;

    const code: AttachmentRefusalReason = result.code;
    const body = refusal(code, result.params);
    switch (code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);
      case "TOO_LARGE":
        throw new PayloadTooLargeException(body);
      case "UNSUPPORTED_TYPE":
      case "HEIC_NOT_CONVERTED":
      case "TYPE_MISMATCH":
        // 415: the request was well-formed and the *media* is what we will not take.
        throw new UnsupportedMediaTypeException(body);
      case "EMPTY_FILE":
      case "VISIT_MISMATCH":
        // Well-formed and refusable on content: 422, not 400, which is reserved for a shape the
        // server never offered.
        throw new UnprocessableEntityException(body);
      case "NOT_A_DOCTOR":
      case "NOT_PERMITTED":
        // 403, not 404: the caller is a doctor in this tenant, so the row's existence is not a
        // secret from them. The tenant boundary is the one that returns 404, and the tenant-scoped
        // query in the service has already made a cross-tenant id indistinguishable from a
        // non-existent one before this branch can be reached.
        throw new ForbiddenException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  /**
   * Files an attachment against a patient, optionally against one of that patient's visits.
   *
   * `limits.fileSize` refuses an oversized upload at the edge — **at** 10 MB rather than before any
   * buffering; see the note on `limits` below, which is there because that distinction is easy to
   * read the wrong way round. The service checks the size again, and the second check is not
   * redundant: it is the one that holds for a caller that is not HTTP.
   */
  @Post("patients/:patientId/attachments")
  @RequirePermission("visits.write")
  @UseInterceptors(
    FileInterceptor("file", {
      // No `dest` and no `storage`: multer keeps the bytes in memory, so nothing reaches a disk
      // until it has been sniffed and accepted. A temp file would put unvalidated content on the
      // host and leave cleanup as something to remember.
      //
      /**
       * **The size check happens *during* streaming, not before any buffering. Do not assume
       * otherwise.**
       *
       * There is one limit in this system and it is 10 MB (`MAX_ATTACHMENT_BYTES`). What is worth
       * being exact about is *when* it bites, because "refused server-side" can be read as "refused
       * before anything was held", and that is not what happens.
       *
       * Busboy clamps every chunk to `Math.min(end - start, fileSizeLimit - fileSize)` and, on
       * reaching the limit, emits `limit`, sets `truncated`, and sets `skipPart` — so the remainder
       * of the part is read off the socket and **discarded** rather than accumulated
       * (`busboy/lib/types/multipart.js`). A 50 MB upload therefore does not put 50 MB in memory.
       *
       * But it does put **10 MB (plus the one byte below)** there, per concurrent upload, before
       * the refusal is issued — and with `memoryStorage` that is heap, not a temp file. So the
       * honest statement of the property is: *bounded by the limit, not avoided by it.* Concurrency
       * is what turns that into a number worth caring about; ten simultaneous oversized uploads are
       * 100 MB of heap on a host `DEPLOY.md` sizes at 4 GB.
       *
       * The bound is one byte past the limit (see below), which is the tightest a streaming parser
       * can offer without rejecting on `Content-Length` — and `Content-Length` is caller-supplied,
       * so it decides nothing. Written down so that nobody later reads "refused server-side" and
       * concludes the bytes were never held.
       *
       * ## `+ 1` is deliberate. Do not "correct" it back.
       *
       * Busboy compares with `fileSize === fileSizeLimit`, **not** `>`. So a file of exactly
       * `fileSizeLimit` bytes emits `limit` and is refused: passing `MAX_ATTACHMENT_BYTES` here
       * makes the real maximum `MAX_ATTACHMENT_BYTES - 1`, while every message, document and DTO
       * says 10 MB. A scan of exactly 10,485,760 bytes was refused with a 413 that contradicted
       * the rule it was enforcing.
       *
       * Handing busboy `MAX_ATTACHMENT_BYTES + 1` moves its trip-wire one byte past the largest
       * file we mean to accept, so 10 MB exactly gets through and the **service** — which compares
       * with `>` — is the one authority on the limit. That is the right place for it: the service
       * is the interface the AI tool layer calls, and a cap enforced only at the HTTP edge is a cap
       * that does not exist for half its callers.
       *
       * Found by testing both sides of the boundary rather than only something enormous. "Over
       * 10 MB is refused" says nothing about where the boundary sits, and an off-by-one there is
       * invisible to any test that pushes 20 MB at it.
       */
      limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1 },
      /**
       * **Not optional on an Arabic-first product.** Multer defaults this to `latin1`
       * (`multer/index.js`: `options.defParamCharset || 'latin1'`), so a browser's UTF-8
       * `filename*` comes back as mojibake — `نتيجة التحليل.pdf` arrives as `ÙØªÙØ¬Ø©...`.
       *
       * It fails in the worst available way: the upload succeeds, the row is written, and the
       * corruption is only visible to whoever later reads the filename — by which point the
       * original is gone, because the bytes we stored are the mangled ones. Nothing errors and
       * nothing logs. Caught by `attachments.integration.spec.ts`, which asserts a real Arabic
       * filename round-trips rather than an ASCII one that would have passed either way.
       */
      defParamCharset: "utf8",
    }),
  )
  async upload(
    @Req() request: AuthenticatedRequest,
    @Param("patientId", ParseUUIDPipe) patientId: string,
    @Body() body: UploadAttachmentDto,
    @UploadedFile() file: UploadedMultipartFile | undefined,
  ) {
    if (file === undefined) {
      throw new BadRequestException(refusal("NO_FILE_UPLOADED"));
    }

    return this.unwrap(
      await uploadAttachment(this.caller(request), this.storage, {
        patientId,
        visitId: body.visitId ?? null,
        // The caller's filename is recorded and never becomes part of a path.
        fileName: file.originalname,
        declaredMimeType: file.mimetype,
        category: body.category,
        description: body.description ?? null,
        bytes: file.buffer,
      }, new Date()),
    );
  }

  /** Metadata only. The bytes need a second, separately-gated request. */
  @Get("patients/:patientId/attachments")
  @RequirePermission("visits.readContent")
  async list(
    @Req() request: AuthenticatedRequest,
    @Param("patientId", ParseUUIDPipe) patientId: string,
  ) {
    return this.unwrap(await listPatientAttachments(this.caller(request), patientId, new Date()));
  }

  /**
   * The bytes.
   *
   * **`Content-Disposition: attachment`, always** (Q10). Never `inline`, and there is deliberately
   * no parameter that could make it so: an inline PDF or SVG renders in the browser's context, and
   * "the file is only ever downloaded" is a property worth having unconditionally rather than
   * depending on a query string. Together with `X-Content-Type-Options: nosniff` it means the
   * browser neither renders the file nor second-guesses the type we sniffed.
   */
  @Get("attachments/:id/content")
  @RequirePermission("visits.readContent")
  async content(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { fileName, mimeType, bytes } = this.unwrap(
      await readAttachmentContent(this.caller(request), this.storage, id, new Date()),
    );

    response.setHeader("Content-Type", mimeType);
    response.setHeader("Content-Length", bytes.byteLength);
    response.setHeader("X-Content-Type-Options", "nosniff");
    // RFC 6266: `filename*` carries the UTF-8 original, which matters here because these names are
    // routinely Arabic. `filename` stays as an ASCII fallback for anything that cannot read the
    // extended form, and is deliberately not a transliteration -- a wrong-but-plausible name is
    // worse than an obviously generic one.
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    response.end(bytes);
  }

  /** Archival, never destruction. The row and the stored object both survive. */
  @Post("attachments/:id/archive")
  @RequirePermission("visits.write")
  async archive(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.unwrap(await archiveAttachment(this.caller(request), id, new Date()));
  }
}
