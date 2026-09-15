import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/**
 * Request shapes for the attachment endpoints. `whitelist: true, forbidNonWhitelisted: true`
 * (CLAUDE.md), so anything not declared here is a 400 rather than a silently dropped field.
 *
 * **These are the *text* parts of a multipart upload.** The file itself is not a DTO field — it
 * arrives through `FileInterceptor` and is validated by sniffing its bytes, not by anything
 * declarable here.
 *
 * ## What a caller deliberately cannot send
 *
 * No `mimeType`, no `sizeBytes`, no `storageKey`, no `uploadedByUserId`, and no `archivedAt`. Every
 * one of those is a server-side fact, and every one of them is a field a request DTO could accept
 * without looking wrong: `mimeType` is the one the whole of Q10 exists to stop us trusting,
 * `sizeBytes` would let a caller understate a file past the cap, `storageKey` would hand the caller
 * the filesystem, and `uploadedByUserId` would let a doctor file something under a colleague's name.
 * They are absent rather than ignored — `forbidNonWhitelisted` turns each into a 400.
 */

const CATEGORIES = ["LAB", "IMAGING", "REPORT", "ID_DOCUMENT", "OTHER"] as const;

export class UploadAttachmentDto {
  /**
   * Optional. An attachment may hang off a patient with no visit at all — a scan that arrives
   * between appointments is the ordinary case, and `attachments.visit_id` is nullable for it.
   */
  @IsOptional()
  @IsUUID()
  visitId?: string;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  /** What the doctor calls it. Free text; never used to build a path (`domain/storage-key.ts`). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string;
}
