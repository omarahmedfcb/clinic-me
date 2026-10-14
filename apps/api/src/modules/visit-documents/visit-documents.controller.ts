import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { refusal } from "../../common/refusals.ts";
import { RetryAfterThrottlerGuard, ThrottleOnly } from "../../common/throttlers.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { resolveDocumentToken } from "./visit-document-links.ts";
import { cachePdf, cachedPdf, renderPdf, RendererBusy } from "./pdf-renderer.ts";
import {
  contentHash,
  isDocumentKind,
  loadVisitDocuments,
  recordView,
  type PublicVisitDocuments,
} from "./visit-documents.service.ts";
import { DOCUMENTS_PDF_THROTTLER, DOCUMENTS_READ_THROTTLER } from "./visit-documents-throttle.ts";

/**
 * The patient's documents. No `AuthGuard`, no `TenantGuard`, by construction: the person opening this has
 * no login and never will. The credential is the token in the path, and every refusal below is the same
 * 404, so the route cannot be used to learn whether a given link ever existed.
 *
 * The responses are marked uncacheable and unindexable, and the page that fetches them sends no referrer:
 * a medical document must not land in a proxy's cache, a search index, or another site's access log.
 */
@Controller("public/visit-documents")
export class VisitDocumentsController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  private async documentsFor(
    token: string,
    count: boolean,
  ): Promise<{ documents: PublicVisitDocuments; tenantId: string; visitId: string }> {
    const now = new Date();
    const link = await resolveDocumentToken(token, now);
    if (link === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "visit" }));

    const documents = await loadVisitDocuments(link.tenantId, link.visitId, this.storage);
    if (documents === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "visit" }));

    // The PDF renderer opens the same page and would otherwise count as a patient looking.
    if (count) void recordView(link.tenantId, link.linkId, now);
    return { documents, tenantId: link.tenantId, visitId: link.visitId };
  }

  @Get(":token")
  @UseGuards(RetryAfterThrottlerGuard)
  @ThrottleOnly(DOCUMENTS_READ_THROTTLER, 60, 60_000)
  @Header("Cache-Control", "no-store")
  @Header("X-Robots-Tag", "noindex, nofollow")
  @Header("Referrer-Policy", "no-referrer")
  async read(@Param("token") token: string, @Query("render") render?: string): Promise<PublicVisitDocuments> {
    const { documents } = await this.documentsFor(token, render !== "1");
    return documents;
  }

  @Get(":token/pdf/:kind")
  @UseGuards(RetryAfterThrottlerGuard)
  @ThrottleOnly(DOCUMENTS_PDF_THROTTLER, 10, 60_000)
  async pdf(@Param("token") token: string, @Param("kind") kind: string, @Res() response: Response): Promise<void> {
    if (!isDocumentKind(kind)) throw new NotFoundException(refusal("NOT_FOUND", { resource: "visit" }));
    const { documents } = await this.documentsFor(token, false);

    // A kind that has nothing to show is a 404, like a document that does not exist: no empty sick leave.
    if (kind === "sickLeave" && (documents.sickLeave.days === null || documents.sickLeave.from === null)) {
      throw new NotFoundException(refusal("NOT_FOUND", { resource: "visit" }));
    }
    if (kind === "invoice" && documents.invoice === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "visit" }));

    const key = `${kind}:${contentHash(documents, kind)}`;
    const now = Date.now();
    let bytes = cachedPdf(key, now);

    if (bytes === null) {
      const appUrl = process.env["PUBLIC_APP_URL"];
      if (!appUrl) throw new ServiceUnavailableException({ reason: "PUBLIC_APP_URL_NOT_SET" });
      const target = `${appUrl.replace(/\/+$/, "")}/d/${encodeURIComponent(token)}?print=${kind}&render=1`;
      try {
        bytes = await renderPdf(target);
      } catch (error) {
        if (error instanceof RendererBusy) throw new ServiceUnavailableException({ reason: "RENDERER_BUSY" });
        console.error("visit-documents: PDF render failed", error);
        throw new ServiceUnavailableException({ reason: "RENDER_FAILED" });
      }
      cachePdf(key, bytes, now);
    }

    response
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${kind}.pdf"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      })
      .send(bytes);
  }
}
