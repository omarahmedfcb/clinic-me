import { isSafeBrandingKey } from "./branding-key.ts";
import { isSafePhotoKey, photoKeyFor } from "./photo-key.ts";
import { isSafeStorageKey } from "./storage-key.ts";

/**
 * The third key shape, and the reason it is a third one.
 *
 * Each validator answers exactly one question. The risk a shared validator carries is that the
 * loosest shape decides all of them, so the assertions below are mostly about what each one
 * *refuses*: a photo key is not a branding key, is not an attachment key, and neither is a photo key.
 */

const TENANT = "01a09199-9d9e-7322-a6b3-c092e5d9b924";
const USER = "01a09199-abcd-7169-aa63-a2b22fede4f4";
const IMAGE = "01a091ea-238b-7065-8c82-8fc9e94bed0f";

describe("profile photo storage keys", () => {
  test("the tenant comes first, so one clinic's objects stay a subtree", () => {
    const key = photoKeyFor({ tenantId: TENANT, userId: USER, imageId: IMAGE, extension: "png" });
    expect(key).toBe(`${TENANT}/photos/${USER}/${IMAGE}.png`);
    expect(key.startsWith(`${TENANT}/`)).toBe(true);
  });

  test("a key this system produced is accepted, for every extension it accepts", () => {
    for (const extension of ["png", "jpg", "webp", "gif"]) {
      expect(isSafePhotoKey(photoKeyFor({ tenantId: TENANT, userId: USER, imageId: IMAGE, extension }))).toBe(
        true,
      );
    }
  });

  test("a PDF is not a photo, even though an attachment may be one", () => {
    expect(isSafePhotoKey(`${TENANT}/photos/${USER}/${IMAGE}.pdf`)).toBe(false);
  });

  test("path traversal and a wrong segment are both refused", () => {
    expect(isSafePhotoKey(`${TENANT}/photos/../../etc/passwd`)).toBe(false);
    expect(isSafePhotoKey(`${TENANT}/photos/${USER}/${IMAGE}.png/../x.png`)).toBe(false);
    expect(isSafePhotoKey(`${TENANT}/branding/logo/${USER}/${IMAGE}.png`)).toBe(false);
    expect(isSafePhotoKey(`/${TENANT}/photos/${USER}/${IMAGE}.png`)).toBe(false);
  });

  test("the three validators do not admit each other's keys", () => {
    const photo = photoKeyFor({ tenantId: TENANT, userId: USER, imageId: IMAGE, extension: "png" });
    // The point of three shapes: widening one would have widened the guard on patient attachments.
    expect(isSafeBrandingKey(photo)).toBe(false);
    expect(isSafeStorageKey(photo)).toBe(false);
    expect(isSafePhotoKey(`${TENANT}/branding/signature/${USER}/${IMAGE}.png`)).toBe(false);
  });
});
