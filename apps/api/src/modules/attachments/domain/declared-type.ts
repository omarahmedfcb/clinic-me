import { ACCEPTED, type AcceptedMimeType } from "./sniff.ts";

/**
 * Does what the caller *said* the file is contradict what it turned out to be?
 *
 * Pure, and separate from `sniff.ts` on purpose: `sniff` must never see a filename or a declared
 * type, because the moment it can it might be tempted to use one. This function is the opposite
 * job — it looks only at the caller's claims and compares them against a verdict already reached
 * without them. Keeping the two apart is what makes "the bytes decide" structurally true rather
 * than a convention.
 *
 * ## Why refuse at all, when sniffing already got the right answer
 *
 * Admission is settled: `sniff` decided, and `attachments.mime_type` records what it decided. A
 * PDF named `.jpg` could simply be stored as a PDF and nothing would be wrong with the record.
 *
 * The reason to refuse anyway is that the two claims **disagree**, and a disagreement is
 * information about the upload rather than about the format. Both types are perfectly acceptable
 * on their own; what is not ordinary is a file asserting one thing in its name and another in its
 * bytes. That is either a person about to file something they have misidentified — a scan they
 * believe is an X-ray image and is actually a lab PDF — or a caller probing what the sniffer will
 * take. Neither is a thing to accept silently into a medical record, and the cost of refusing is a
 * message telling the doctor exactly what the mismatch was.
 *
 * ## Where it deliberately stays quiet
 *
 * **A claim only counts when it is a claim.** Refusing on any difference would break ordinary
 * uploads for no benefit:
 *
 * - **No extension, or an unrecognised one** (`scan`, `result.dat`) asserts nothing, so there is
 *   nothing to contradict.
 * - **`application/octet-stream`** is what a browser sends when it does not know, and several send
 *   it for perfectly ordinary files. Treating "I don't know" as "I claim otherwise" would refuse a
 *   large share of real uploads.
 * - **`.jpeg` and `.jpg`** are the same claim, as are `image/jpg` and `image/jpeg` — the former is
 *   not a registered type but is emitted by enough software that treating it as a contradiction
 *   would be pedantry with a 415 attached.
 * - **Case and parameters** (`.PDF`, `image/jpeg; charset=binary`) are noise, not disagreement.
 */

/** Extension → the type that extension claims. Aliases included; the values come from `ACCEPTED`. */
const EXTENSION_CLAIMS: Record<string, AcceptedMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

/** Declared media types we understand well enough to treat as a claim. Anything else is silence. */
const MIME_CLAIMS: Record<string, AcceptedMimeType> = {
  ...Object.fromEntries(Object.keys(ACCEPTED).map((mime) => [mime, mime as AcceptedMimeType])),
  // Not registered, but emitted by enough cameras and scanners to be worth understanding rather
  // than treating as an unrecognised type.
  "image/jpg": "image/jpeg",
};

/** The last dot-segment of a filename, lowercased. `""` when there is nothing that looks like one. */
function extensionOf(fileName: string): string {
  // `lastIndexOf` rather than a split, so `نتيجة.التحليل.pdf` yields `pdf` and a leading-dot name
  // such as `.gitignore` yields nothing rather than `gitignore`.
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/** Strips parameters and case: `image/JPEG; charset=binary` → `image/jpeg`. */
function normaliseMime(declared: string): string {
  const semicolon = declared.indexOf(";");
  return (semicolon === -1 ? declared : declared.slice(0, semicolon)).trim().toLowerCase();
}

export interface DeclaredTypeConflict {
  /** What the caller claimed, in the words of whichever claim disagreed. */
  claimed: string;
  /** What the bytes turned out to be. */
  actual: AcceptedMimeType;
  /** Which claim disagreed — useful in a message, and in a log. */
  source: "extension" | "declaredMimeType";
}

/**
 * The conflict, or `null` when the caller's claims are consistent with the bytes or make no claim.
 *
 * The extension is checked first because it is the claim a human actually sees and can act on:
 * "this file is named `.jpg` but contains a PDF" is a sentence the doctor can do something about,
 * whereas the declared media type is set by their browser and is not theirs to fix.
 */
export function declaredTypeConflict(
  actual: AcceptedMimeType,
  fileName: string,
  declaredMimeType: string,
): DeclaredTypeConflict | null {
  const extension = extensionOf(fileName);
  const byExtension = EXTENSION_CLAIMS[extension];
  if (byExtension !== undefined && byExtension !== actual) {
    return { claimed: `.${extension}`, actual, source: "extension" };
  }

  const declared = normaliseMime(declaredMimeType);
  const byMime = MIME_CLAIMS[declared];
  if (byMime !== undefined && byMime !== actual) {
    return { claimed: declared, actual, source: "declaredMimeType" };
  }

  return null;
}
