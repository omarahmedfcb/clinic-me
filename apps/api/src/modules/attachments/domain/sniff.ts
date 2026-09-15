/**
 * What a file actually is, decided from its bytes. `PHASE-4.md` Q10.
 *
 * **Pure, and deliberately so.** Zero I/O, no clock, no database — the same rule the slot engine
 * follows (CLAUDE.md). It takes bytes and returns a verdict, which is what makes the executable
 * -renamed-`.pdf` test in the Definition of Done a plain unit test with no fixtures behind it.
 *
 * ## Why the declared type is not consulted at all
 *
 * `Content-Type` on a multipart part and the filename extension are both supplied by the caller.
 * A browser fills them in honestly; anything else may not, and "anything else" includes the case
 * this check exists for. So neither is an input here — this function is never given them, rather
 * than being given them and told to ignore them, because a parameter that must not be used is one
 * a later reader will use.
 *
 * The declared type is still *recorded* (`attachments.mime_type` stores what we sniffed, not what
 * was claimed) and still used by the browser on the way back out — but it never decides admission.
 *
 * ## What "an image" means here, and the one thing it excludes on purpose
 *
 * PNG, JPEG, WebP and GIF, plus PDF. That is the set a phone camera and a lab scanner actually
 * produce once Q12's client-side downscale has re-encoded the capture through a canvas.
 *
 * **HEIC is detected and refused with its own reason rather than falling into `UNSUPPORTED`.**
 * It should never arrive — Q12's downscale re-encodes to JPEG or PNG before upload — so a HEIC
 * reaching this function means that path was bypassed or silently failed on the device. A generic
 * "unsupported file type" would send whoever hits it looking at the wrong thing, on an iPhone,
 * which is the one platform this project cannot test on (Q16). Naming it costs four lines and
 * turns an afternoon into a log line.
 */

/** The types admitted, and the extension each is stored under. */
export const ACCEPTED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
} as const;

export type AcceptedMimeType = keyof typeof ACCEPTED;

export type SniffResult =
  | { ok: true; mimeType: AcceptedMimeType; extension: (typeof ACCEPTED)[AcceptedMimeType] }
  | { ok: false; reason: "EMPTY" | "HEIC" | "UNSUPPORTED" };

/** `bytes` starts with `signature` at `offset`. */
function matches(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** ASCII helper — every signature below is a literal byte string, spelled once. */
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const PDF = ascii("%PDF-");
const FTYP = ascii("ftyp");

/**
 * ISO base-media brands that mean HEIC/HEIF. `mif1` and `msf1` are the generic HEIF brands an
 * iPhone also emits, so both are here — matching only `heic` would let half of them through as
 * `UNSUPPORTED` and defeat the point of naming the case.
 */
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];

/**
 * The verdict on these bytes.
 *
 * Only a prefix is ever examined, so a caller may pass the whole buffer or just its head — but
 * note that the buffer is what gets stored, and this function does not see or care about that.
 */
export function sniff(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: "EMPTY" };

  if (matches(bytes, PNG)) return { ok: true, mimeType: "image/png", extension: "png" };
  if (matches(bytes, JPEG)) return { ok: true, mimeType: "image/jpeg", extension: "jpg" };
  if (matches(bytes, GIF87) || matches(bytes, GIF89)) {
    return { ok: true, mimeType: "image/gif", extension: "gif" };
  }
  // RIFF is a container: "RIFF" at 0, four bytes of length, then the form type at 8. RIFF alone is
  // also a WAV and an AVI, so the form type is the part that decides.
  if (matches(bytes, RIFF) && matches(bytes, WEBP, 8)) {
    return { ok: true, mimeType: "image/webp", extension: "webp" };
  }
  // Strict at offset 0. The PDF specification tolerates leading bytes before the header and most
  // readers do too, which is exactly why an upload gate should not: a file with a PNG header and a
  // PDF header further in is a file designed to be read two different ways by two different
  // programs, and admitting it means the thing we sniffed is not the thing something else parses.
  if (matches(bytes, PDF)) return { ok: true, mimeType: "application/pdf", extension: "pdf" };

  // `....ftypXXXX` — the box length occupies the first four bytes, so the marker sits at 4 and the
  // brand at 8.
  if (matches(bytes, FTYP, 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (HEIF_BRANDS.includes(brand)) return { ok: false, reason: "HEIC" };
  }

  return { ok: false, reason: "UNSUPPORTED" };
}
