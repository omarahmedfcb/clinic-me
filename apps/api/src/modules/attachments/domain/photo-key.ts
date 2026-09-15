// Storage keys for profile photos. A third shape, with a third validator, deliberately.
// Widening `isSafeBrandingKey` would make one guard answer two questions — see branding-key.ts.

import { BRANDING_EXTENSIONS } from "./branding-key.ts";

/**
 * Tenant first, like every other key, so one clinic's objects stay a subtree.
 *
 * The owner is the **user** id, not the membership: the photo belongs to the person. The tenant in
 * the key is simply whoever's screen uploaded it, which is what keeps the subtree rule intact — a
 * photo is read back by its key, never by reconstructing the path from the reader's own tenant.
 */
export function photoKeyFor(input: {
  tenantId: string;
  userId: string;
  imageId: string;
  extension: string;
}): string {
  return `${input.tenantId}/photos/${input.userId}/${input.imageId}.${input.extension}`;
}

/**
 * A key this system could have produced, as an allow-list of the exact shape.
 *
 * The extension set is `BRANDING_EXTENSIONS` — the sniffer's accepted images minus PDF — because a
 * profile photo is an image on exactly the terms a logo is, and spelling the list again is how two
 * lists drift apart.
 */
const SAFE_PHOTO_KEY = new RegExp(
  `^[0-9a-f-]{36}/photos/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(?:${BRANDING_EXTENSIONS.join("|")})$`,
);

export function isSafePhotoKey(key: string): boolean {
  return SAFE_PHOTO_KEY.test(key);
}
