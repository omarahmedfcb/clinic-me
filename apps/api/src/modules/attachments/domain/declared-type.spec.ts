import { declaredTypeConflict } from "./declared-type.ts";

describe("declaredTypeConflict", () => {
  describe("catches a file whose name disagrees with its bytes", () => {
    test("a PDF named .jpg — the case this exists for", () => {
      expect(declaredTypeConflict("application/pdf", "x-ray.jpg", "image/jpeg")).toEqual({
        claimed: ".jpg",
        actual: "application/pdf",
        source: "extension",
      });
    });

    test("a PNG named .pdf", () => {
      expect(declaredTypeConflict("image/png", "lab-result.pdf", "application/pdf")).toEqual({
        claimed: ".pdf",
        actual: "image/png",
        source: "extension",
      });
    });

    test("both types being individually acceptable is not a defence", () => {
      // The point of the rule: nothing here is a forbidden format. What is refused is the
      // disagreement.
      expect(declaredTypeConflict("image/gif", "scan.webp", "image/webp")).not.toBeNull();
    });

    test("the extension is reported in preference to the media type, being the one a human can fix", () => {
      const conflict = declaredTypeConflict("application/pdf", "result.png", "image/gif");
      expect(conflict?.source).toBe("extension");
      expect(conflict?.claimed).toBe(".png");
    });
  });

  describe("catches a declared media type that disagrees, when the name does not", () => {
    test("no extension, contradicting media type", () => {
      expect(declaredTypeConflict("application/pdf", "scan", "image/png")).toEqual({
        claimed: "image/png",
        actual: "application/pdf",
        source: "declaredMimeType",
      });
    });

    test("an unrecognised extension does not mask a contradicting media type", () => {
      expect(declaredTypeConflict("application/pdf", "result.dat", "image/png")?.source).toBe(
        "declaredMimeType",
      );
    });
  });

  describe("stays quiet where a difference is not a claim", () => {
    test.each([
      ["consistent name and type", "application/pdf", "report.pdf", "application/pdf"],
      [".jpeg is the same claim as .jpg", "image/jpeg", "photo.jpeg", "image/jpeg"],
      [".jpg with JPEG bytes", "image/jpeg", "photo.jpg", "image/jpeg"],
      ["image/jpg is understood as image/jpeg", "image/jpeg", "photo.jpg", "image/jpg"],
      ["uppercase extension", "application/pdf", "REPORT.PDF", "application/pdf"],
      ["mixed-case media type", "image/png", "scan.png", "IMAGE/PNG"],
      ["media type with parameters", "image/jpeg", "scan.jpg", "image/jpeg; charset=binary"],
      ["octet-stream means the browser did not know", "application/pdf", "report.pdf", "application/octet-stream"],
      ["octet-stream with no extension either", "application/pdf", "scan", "application/octet-stream"],
      ["no extension at all", "image/png", "scan", "image/png"],
      ["an unrecognised extension asserts nothing", "application/pdf", "result.dat", "application/pdf"],
      ["a dotfile has no extension", "application/pdf", ".gitignore", "application/pdf"],
      ["a trailing dot is not an extension", "application/pdf", "report.", "application/pdf"],
      ["an empty declared type is silence", "application/pdf", "report.pdf", ""],
      ["an unrecognised declared type is silence", "application/pdf", "report.pdf", "application/x-thing"],
      ["multiple dots, last one wins", "application/pdf", "نتيجة.التحليل.pdf", "application/pdf"],
    ])("%s", (_name, actual, fileName, declared) => {
      expect(declaredTypeConflict(actual as never, fileName, declared)).toBeNull();
    });
  });
});
