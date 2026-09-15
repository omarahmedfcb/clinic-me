import {
  BRANDING_EXTENSIONS,
  brandingKeyFor,
  isSafeBrandingKey,
} from "./branding-key.ts";
import { isSafeStorageKey } from "./storage-key.ts";

/**
 * The branding key shape, and the line between it and the attachment one — Q28, Q11.
 *
 * The assertion that carries this file is the last pair: **neither validator accepts the other's
 * keys.** They guard different reads, and the day a third shape arrives, one loose validator would
 * be deciding for all of them.
 */

const TENANT = "00000000-0000-7000-8000-000000000001";
const DOCTOR = "00000000-0000-7000-8000-000000000002";
const IMAGE = "00000000-0000-7000-8000-000000000003";

describe("branding storage keys", () => {
  it("emits a key its own validator accepts", () => {
    const key = brandingKeyFor({
      tenantId: TENANT,
      kind: "signature",
      ownerId: DOCTOR,
      imageId: IMAGE,
      extension: "png",
    });
    expect(key).toBe(`${TENANT}/branding/signature/${DOCTOR}/${IMAGE}.png`);
    expect(isSafeBrandingKey(key)).toBe(true);
  });

  it("admits only the three kinds", () => {
    expect(isSafeBrandingKey(`${TENANT}/branding/logo/${TENANT}/${IMAGE}.png`)).toBe(true);
    expect(isSafeBrandingKey(`${TENANT}/branding/stamp/${DOCTOR}/${IMAGE}.jpg`)).toBe(true);
    expect(isSafeBrandingKey(`${TENANT}/branding/scan/${DOCTOR}/${IMAGE}.png`)).toBe(false);
  });

  it("a letterhead image is an image, so PDF is not an extension it can carry", () => {
    // Derived from `ACCEPTED` minus `pdf` rather than spelled again, so the sniffer's list and this
    // one cannot drift apart — the mistake `storage-key.spec.ts` caught when `[a-z]{2,4}` admitted
    // `.exe`.
    expect(BRANDING_EXTENSIONS).not.toContain("pdf");
    expect(isSafeBrandingKey(`${TENANT}/branding/logo/${TENANT}/${IMAGE}.pdf`)).toBe(false);
    expect(isSafeBrandingKey(`${TENANT}/branding/logo/${TENANT}/${IMAGE}.exe`)).toBe(false);
  });

  it("refuses traversal, absolute paths and a missing segment", () => {
    // An allow-list of the exact shape rather than a scan for `..`: a deny-list has to anticipate
    // every encoding of the thing it forbids and misses the one nobody thought of.
    expect(isSafeBrandingKey(`${TENANT}/branding/logo/../../etc/passwd`)).toBe(false);
    expect(isSafeBrandingKey(`/${TENANT}/branding/logo/${TENANT}/${IMAGE}.png`)).toBe(false);
    expect(isSafeBrandingKey(`${TENANT}/branding/logo/${IMAGE}.png`)).toBe(false);
    expect(isSafeBrandingKey(`${TENANT}\\branding\\logo\\${TENANT}\\${IMAGE}.png`)).toBe(false);
  });

  it("neither validator accepts the other's keys", () => {
    const branding = brandingKeyFor({
      tenantId: TENANT,
      kind: "logo",
      ownerId: TENANT,
      imageId: IMAGE,
      extension: "png",
    });
    const attachment = `${TENANT}/${DOCTOR}/${IMAGE}.png`;

    expect(isSafeStorageKey(branding)).toBe(false);
    expect(isSafeBrandingKey(attachment)).toBe(false);
  });
});
