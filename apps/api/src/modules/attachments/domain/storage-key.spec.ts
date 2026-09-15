import { isSafeStorageKey, storageKeyFor } from "./storage-key.ts";

const TENANT = "01a05c56-4867-7f49-b554-d60534a9bf68";
const PATIENT = "01a05c56-48e0-7892-957e-a8484a62c8b8";
const ATTACHMENT = "01a05c56-4924-7b7b-924e-cc81a84d1fd2";

describe("storageKeyFor", () => {
  test("is derived entirely from server-held ids and the sniffed extension", () => {
    expect(
      storageKeyFor({
        tenantId: TENANT,
        patientId: PATIENT,
        attachmentId: ATTACHMENT,
        extension: "pdf",
      }),
    ).toBe(`${TENANT}/${PATIENT}/${ATTACHMENT}.pdf`);
  });

  test("every key it produces is one isSafeStorageKey accepts", () => {
    for (const extension of ["png", "jpg", "webp", "gif", "pdf"]) {
      const key = storageKeyFor({
        tenantId: TENANT,
        patientId: PATIENT,
        attachmentId: ATTACHMENT,
        extension,
      });
      expect(isSafeStorageKey(key)).toBe(true);
    }
  });
});

/**
 * The uploaded filename never reaches a path — `storageKeyFor` has no parameter for it — so
 * traversal is prevented structurally rather than by escaping. `isSafeStorageKey` is the second,
 * independent check, applied to keys read back out of the database, and this is where it is proven
 * to refuse the things a deny-list would have had to anticipate one at a time.
 */
describe("isSafeStorageKey", () => {
  test.each([
    ["a parent-directory hop", `${TENANT}/${PATIENT}/../../../etc/passwd`],
    ["a bare traversal", "../../../etc/passwd"],
    ["a percent-encoded hop", `${TENANT}/${PATIENT}/%2e%2e%2fpasswd.pdf`],
    ["a Windows separator", `${TENANT}\\${PATIENT}\\${ATTACHMENT}.pdf`],
    ["an absolute POSIX path", `/etc/shadow`],
    ["an absolute Windows path", `C:\\Windows\\System32\\config\\SAM`],
    ["a leading slash making a join absolute", `/${TENANT}/${PATIENT}/${ATTACHMENT}.pdf`],
    ["a UNC path", `\\\\server\\share\\file.pdf`],
    ["a null byte truncation attempt", `${TENANT}/${PATIENT}/${ATTACHMENT}.pdf\u0000.png`],
    ["too few segments", `${PATIENT}/${ATTACHMENT}.pdf`],
    ["too many segments", `${TENANT}/${PATIENT}/${ATTACHMENT}/again.pdf`],
    ["no extension", `${TENANT}/${PATIENT}/${ATTACHMENT}`],
    ["an executable extension", `${TENANT}/${PATIENT}/${ATTACHMENT}.exe`],
    ["a double extension", `${TENANT}/${PATIENT}/${ATTACHMENT}.pdf.exe`],
    ["uppercase hex, which this system never emits", `${TENANT.toUpperCase()}/${PATIENT}/${ATTACHMENT}.pdf`],
    ["a trailing newline", `${TENANT}/${PATIENT}/${ATTACHMENT}.pdf\n`],
    ["empty", ""],
  ])("refuses %s", (_name, key) => {
    expect(isSafeStorageKey(key)).toBe(false);
  });
});
