import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
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
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { ObjectNotFound, STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { recordOperatorAction } from "./platform-audit.ts";
import {
  ACCOUNT_STATUSES,
  addContact,
  addContract,
  MAX_CONTRACT_BYTES,
  readClientFile,
  readContract,
  removeContact,
  saveClientFile,
  type AccountStatus,
  type ClientFileRefusal,
  type ClientFileResult,
} from "./platform-client-file.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

/** `YYYY-MM-DD`. A date, not an instant: a contract term has no time of day. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class SaveClientFileDto {
  @IsOptional() @IsString() @MaxLength(200) agreedPlan?: string | null;
  @IsOptional() @IsInt() @Min(0) agreedMonthlyMinor?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(100) discountPercent?: number | null;
  @IsOptional() @IsIn([...ACCOUNT_STATUSES]) accountStatus?: AccountStatus;
  @IsOptional() @IsString() @Matches(ISO_DAY) trialEndsOn?: string | null;
  @IsOptional() @IsString() @Matches(ISO_DAY) renewalOn?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
  @IsOptional() @IsString() salesOwnerUserId?: string | null;
}

export class NewContactDto {
  @IsString() @MinLength(2) @MaxLength(200) contactName!: string;
  @IsOptional() @IsString() @MaxLength(120) contactRole?: string;
  @IsOptional() @IsString() @MaxLength(40) contactPhone?: string;
  @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;
}

export class NewContractDto {
  @IsString() @Matches(ISO_DAY) startsOn!: string;
  @IsString() @Matches(ISO_DAY) endsOn!: string;
}

interface UploadedMultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * The client file — 2b and 2c.
 *
 * **Still aggregates only.** Nothing here reads a patient, a visit or a payment: the operator's
 * session binds no tenant, so RLS answers nothing from those tables, and the three tables this
 * controller does read carry the opposite policy — visible to an operator and to nobody else.
 *
 * The clinic never sees any of it. That is why the write routes below do **not** call
 * `recordOperatorAction`, which lands a row in the clinic's own trail: our agreed discount and our
 * sales notes are not theirs to read, and the row would carry them. These tables are audited by
 * `audit_platform_row_change()` into the vendor's trail instead. The one exception is the contract
 * upload, which records the bare fact — a clinic's administrator should be able to see that we
 * filed a contract against their account, without the terms.
 */
@Controller("platform/clinics/:tenantId")
@UseGuards(PlatformAuthGuard)
export class PlatformClientFileController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  private unwrap<T>(result: ClientFileResult<T>): T {
    if (result.ok) return result.value;
    const code: ClientFileRefusal = result.code;
    const body = refusal(code, result.params);
    if (code === "NOT_FOUND") throw new NotFoundException(body);
    if (code === "INVALID_AMOUNT" || code === "INVALID_DATE_RANGE") {
      throw new UnprocessableEntityException(body);
    }
    throw new BadRequestException(body);
  }

  @Get("file")
  async read(@Param("tenantId", ParseUUIDPipe) tenantId: string) {
    return this.unwrap(await readClientFile(actorContext.getOrThrow(), tenantId));
  }

  @Post("file")
  @HttpCode(200)
  async save(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: SaveClientFileDto) {
    return this.unwrap(await saveClientFile(actorContext.getOrThrow(), tenantId, body));
  }

  @Post("contacts")
  @HttpCode(201)
  async contact(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: NewContactDto) {
    return this.unwrap(
      await addContact(actorContext.getOrThrow(), tenantId, {
        fullName: body.contactName,
        ...(body.contactRole === undefined ? {} : { role: body.contactRole }),
        ...(body.contactPhone === undefined ? {} : { phone: body.contactPhone }),
        ...(body.contactEmail === undefined ? {} : { email: body.contactEmail }),
      }),
    );
  }

  @Post("contacts/:contactId/remove")
  @HttpCode(200)
  async dropContact(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("contactId", ParseUUIDPipe) contactId: string,
  ) {
    return this.unwrap(await removeContact(actorContext.getOrThrow(), tenantId, contactId));
  }

  /**
   * The contract PDF.
   *
   * `+ 1` on the multer limit for the same reason `attachments.controller.ts` documents at length:
   * busboy trips on `===`, so passing the cap itself would make the real maximum one byte short of
   * every number this code states. The service compares with `>` and is the one authority.
   */
  @Post("contracts")
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_CONTRACT_BYTES + 1, files: 1 },
      // Not optional on an Arabic-first product: multer defaults to latin1 and a contract named in
      // Arabic would be stored as mojibake, with the original gone.
      defParamCharset: "utf8",
    }),
  )
  async contract(
    @Req() request: PlatformRequest,
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() body: NewContractDto,
    @UploadedFile() file: UploadedMultipartFile | undefined,
  ) {
    if (file === undefined) throw new BadRequestException(refusal("NO_FILE_UPLOADED"));

    const actor = actorContext.getOrThrow();
    const added = this.unwrap(
      await addContract(
        actor,
        tenantId,
        {
          fileName: file.originalname,
          mimeType: file.mimetype,
          bytes: file.buffer,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
        },
        (key, bytes) => this.storage.put(key, bytes),
      ),
    );

    // The fact, not the terms. A clinic's administrator may see that a contract was filed against
    // their account; the price and the discount stay in the vendor's trail.
    await recordOperatorAction(actor, {
      tenantId,
      action: "CREATE",
      entityType: "platform_clinic_contracts",
      entityId: added.id,
      detail: { what: "contract filed", by: request.platformAdmin.fullName },
    });

    return added;
  }

  /**
   * Streams the PDF back through the API. **Never a URL** — the storage interface has no `url()`,
   * and a contract behind a path anybody could guess is a contract behind no gate at all.
   */
  @Get("contracts/:contractId/content")
  async contractContent(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("contractId", ParseUUIDPipe) contractId: string,
    @Res() response: Response,
  ): Promise<void> {
    const found = this.unwrap(await readContract(actorContext.getOrThrow(), tenantId, contractId));

    let bytes: Buffer;
    try {
      bytes = await this.storage.get(found.storageKey);
    } catch (error) {
      if (error instanceof ObjectNotFound) throw new NotFoundException(refusal("NOT_FOUND", { resource: "attachment" }));
      throw error;
    }

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Length", bytes.byteLength);
    response.setHeader("X-Content-Type-Options", "nosniff");
    // RFC 6266: `filename*` carries the UTF-8 original, because these names are routinely Arabic.
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="contract.pdf"; filename*=UTF-8''${encodeURIComponent(found.fileName)}`,
    );
    response.end(bytes);
  }
}
