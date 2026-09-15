// Upload, list and archive for the live visit screen — PR 9's client half. The backend has existed
// since Q10/Q11; `downloadAttachment` already lives in `visit-api.ts` and is reused unchanged.

import type { VisitAttachment } from "./visit-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Mirrors `CATEGORIES` on the API's `UploadAttachmentDto`; anything else is refused there. */
export const ATTACHMENT_CATEGORIES = ["LAB", "IMAGING", "REPORT", "ID_DOCUMENT", "OTHER"] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

/** Anything that is not an array reads as no attachments, per `OpenVisitTabs`'s lesson. */
export async function listAttachments(
  authFetch: AuthFetch,
  patientId: string,
): Promise<VisitAttachment[]> {
  const response = await authFetch(`/api/patients/${patientId}/attachments`);
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as VisitAttachment[]) : [];
}

/**
 * Files one attachment.
 *
 * **No `content-type` header is set on purpose.** `FormData` makes the browser write its own
 * `multipart/form-data` with the boundary parameter; setting the header by hand overwrites that
 * boundary and the server parses nothing out of a well-formed request.
 */
export async function uploadAttachment(
  authFetch: AuthFetch,
  patientId: string,
  input: { file: File; category: AttachmentCategory; description: string | null; visitId: string | null },
): Promise<{ ok: true; attachment: VisitAttachment } | { ok: false; code: string }> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("category", input.category);
  if (input.description !== null && input.description !== "") {
    form.append("description", input.description);
  }
  if (input.visitId !== null) form.append("visitId", input.visitId);

  const response = await authFetch(`/api/patients/${patientId}/attachments`, {
    method: "POST",
    body: form,
  });

  if (response.ok) return { ok: true, attachment: (await response.json()) as VisitAttachment };

  // The API answers `{ code, params }` and the client owns the wording (the refusal-codes
  // contract), so the code is carried up rather than a message built here.
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : "INTERNAL";
  return { ok: false, code };
}

/** Archival, never destruction: the row and the stored object both survive (D-entries on Q11). */
export async function archiveAttachment(authFetch: AuthFetch, attachmentId: string): Promise<boolean> {
  const response = await authFetch(`/api/attachments/${attachmentId}/archive`, { method: "POST" });
  return response.ok;
}
