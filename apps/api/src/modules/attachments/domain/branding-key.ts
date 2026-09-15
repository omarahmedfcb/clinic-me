// Storage keys for the images a printed document needs. Q28.
// A separate shape and a separate validator from `storage-key.ts`, so neither guard widens the other.

import { ACCEPTED } from "./sniff.ts";

/** What a branding image is of. Part of the key, so a stored object says what it was stored as. */
export const BRANDING_KINDS = ["logo", "signature", "stamp"] as const;

export type BrandingKind = (typeof BRANDING_KINDS)[number];

/**
 * Tenant first, like `storageKeyFor`, so one clinic's objects stay a subtree.
 *
 * `owner` is the tenant's own id for a logo and the doctor's id for a signature or a stamp — the
 * thing the image belongs to, which is what makes the key answerable without a database.
 */
export function brandingKeyFor(input: {
  tenantId: string;
  kind: BrandingKind;
  ownerId: string;
  imageId: string;
  extension: string;
}): string {
  return `${input.tenantId}/branding/${input.kind}/${input.ownerId}/${input.imageId}.${input.extension}`;
}

/**
 * A key this system could have produced, as an allow-list of the exact shape.
 *
 * Deliberately not a widening of `isSafeStorageKey`. That one guards reading a patient's
 * attachments and admitting a second shape into it would make one validator answer two questions —
 * and the day a third shape arrives, whichever is looser decides both.
 *
 * **A branding image is an image.** PDF is in `ACCEPTED` because an attachment may be a lab report;
 * a letterhead logo may not be one, so the extension set is derived from `ACCEPTED` minus `pdf`
 * rather than spelled again — the sniffer's list and this one cannot drift apart.
 */
export const BRANDING_EXTENSIONS = Object.entries(ACCEPTED)
  .filter(([mimeType]) => mimeType !== "application/pdf")
  .map(([, extension]) => extension);

const SAFE_BRANDING_KEY = new RegExp(
  `^[0-9a-f-]{36}/branding/(?:${BRANDING_KINDS.join("|")})/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(?:${BRANDING_EXTENSIONS.join("|")})$`,
);

export function isSafeBrandingKey(key: string): boolean {
  return SAFE_BRANDING_KEY.test(key);
}
