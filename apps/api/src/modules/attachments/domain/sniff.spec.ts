import { sniff } from "./sniff.ts";

/**
 * `PHASE-4.md` Definition of Done: *"Type is decided by sniffing content, not the declared MIME
 * type — proven with an executable renamed `.pdf`."*
 *
 * That box is provable here, with no fixtures and no database, because `sniff.ts` is pure. The
 * function is never given a filename or a declared type, so the test does not have to demonstrate
 * that they are ignored — it demonstrates that the bytes alone decide, which is the stronger
 * statement and the only one the signature permits.
 */

/** Real leading bytes, not paraphrases — a signature test that invents its own inputs proves nothing. */
const HEADERS = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46],
  gif87: [...Buffer.from("GIF87a")],
  gif89: [...Buffer.from("GIF89a")],
  pdf: [...Buffer.from("%PDF-1.7\n")],
  /** `RIFF`, four length bytes, `WEBP`. The length is genuinely arbitrary and is not inspected. */
  webp: [...Buffer.from("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...Buffer.from("WEBP")],
  /** Windows PE: `MZ`, the DOS header. This is the "executable" of the Definition of Done. */
  exe: [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00],
  /** ELF, the same case on Linux. */
  elf: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00],
  /** A zero-length box, `ftyp`, then the brand. An iPhone photograph before conversion. */
  heic: [0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftyp"), ...Buffer.from("heic")],
  heifGeneric: [0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftyp"), ...Buffer.from("mif1")],
  /** An MP4 shares the `ftyp` box but is not a HEIF brand — it must not be mistaken for one. */
  mp4: [0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftyp"), ...Buffer.from("isom")],
};

const bytes = (header: number[], trailing = 64): Uint8Array =>
  Uint8Array.from([...header, ...Array.from({ length: trailing }, (_, i) => i % 256)]);

describe("sniff", () => {
  describe("admits what Q10 rules admissible", () => {
    test.each([
      ["PNG", HEADERS.png, "image/png", "png"],
      ["JPEG", HEADERS.jpeg, "image/jpeg", "jpg"],
      ["GIF87a", HEADERS.gif87, "image/gif", "gif"],
      ["GIF89a", HEADERS.gif89, "image/gif", "gif"],
      ["WebP", HEADERS.webp, "image/webp", "webp"],
      ["PDF", HEADERS.pdf, "application/pdf", "pdf"],
    ])("%s", (_name, header, mimeType, extension) => {
      expect(sniff(bytes(header as number[]))).toEqual({ ok: true, mimeType, extension });
    });
  });

  describe("refuses what it is not", () => {
    test("a Windows executable, whatever it is called — the Definition of Done's case", () => {
      // The renaming is the point and it is invisible here on purpose: there is no filename
      // parameter to rename. A `.pdf` extension and a `Content-Type: application/pdf` header
      // cannot reach this function, so they cannot influence it.
      expect(sniff(bytes(HEADERS.exe))).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });

    test("an ELF binary", () => {
      expect(sniff(bytes(HEADERS.elf))).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });

    test("an empty file is EMPTY, not UNSUPPORTED", () => {
      expect(sniff(new Uint8Array(0))).toEqual({ ok: false, reason: "EMPTY" });
    });

    test("plain text", () => {
      expect(sniff(Buffer.from("Patient notes, as a text file."))).toEqual({
        ok: false,
        reason: "UNSUPPORTED",
      });
    });
  });

  describe("HEIC is named rather than lumped in with the rest", () => {
    test.each([
      ["heic", HEADERS.heic],
      ["mif1, the generic HEIF brand an iPhone also emits", HEADERS.heifGeneric],
    ])("%s", (_name, header) => {
      expect(sniff(bytes(header))).toEqual({ ok: false, reason: "HEIC" });
    });

    test("an MP4 shares the ftyp box and must not be reported as HEIC", () => {
      expect(sniff(bytes(HEADERS.mp4))).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });
  });

  describe("the cases a prefix check gets wrong if it is careless", () => {
    test("RIFF that is not WebP — a WAV file — is refused", () => {
      const wav = [...Buffer.from("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...Buffer.from("WAVE")];
      expect(sniff(bytes(wav))).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });

    test("a PDF header that is not at offset 0 is refused", () => {
      // A file that a lenient reader would open as a PDF and a sniffer would call something else is
      // exactly the ambiguity the strict check exists to remove.
      const trailing = Buffer.concat([Buffer.from("junk"), Buffer.from("%PDF-1.7\n")]);
      expect(sniff(trailing)).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });

    test("a truncated signature is refused rather than read past the end", () => {
      expect(sniff(Uint8Array.from([0x89, 0x50]))).toEqual({ ok: false, reason: "UNSUPPORTED" });
      expect(sniff(Uint8Array.from([0xff]))).toEqual({ ok: false, reason: "UNSUPPORTED" });
      expect(sniff(Buffer.from("RIFF"))).toEqual({ ok: false, reason: "UNSUPPORTED" });
    });
  });
});
