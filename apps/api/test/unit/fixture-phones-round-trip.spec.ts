import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * Refuses a fixture phone number built from a UUID slice — the #119 shape, in any spec.
 *
 * A UUID's hex contains letters. `libphonenumber` truncates a trailing letter run and returns the
 * numeric prefix, so a phone built that way is stored one way and normalised another, and the user
 * it belongs to cannot log in. That produced an intermittent 401 in roughly one integration run in
 * five, and cost two debugging sessions before anyone suspected the fixtures.
 *
 * `generateFixturePhone()` was written for exactly this and asserts the round-trip at creation. It
 * was then not used by a spec written on 2026-09-18, which built its own generator instead — the
 * third time the shape appeared. This guard is why there is no fourth: it scans every spec, and a
 * phone built from a UUID fails here rather than as a 401 somewhere unrelated.
 */
function specFiles(): string[] {
  const roots = [path.resolve(__dirname, "..", "..", "src"), path.resolve(__dirname, "..")];
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".spec.ts") ? [full] : [];
    });
  return roots.flatMap(walk).filter((file) => !file.endsWith(path.basename(__filename)));
}

/**
 * A phone-ish template literal whose value comes from a UUID.
 *
 * Deliberately shaped around the defect rather than around "any template literal": a fixture may
 * legitimately interpolate a *number* it generated. What is refused is hex reaching a phone field.
 */
const UUID_SLICE_PHONE =
  /(?:phone|Phone|phoneE164|identifier)\s*[:=]\s*`[^`]*\$\{[^}]*(?:randomUUID|uuid|Id)[^}]*(?:slice|substring|substr)[^}]*\}/;

/** The same defect written as a statement rather than inside an object literal. */
const UUID_SLICE_ASSIGNMENT = /`\+\d{2,4}\$\{[^}]*(?:randomUUID|uuid|Id)[^}]*(?:slice|substring|substr)[^}]*\}`/;

describe("fixture phone numbers", () => {
  const files = specFiles();

  test("there are specs to scan, so a pass means something", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("no spec builds a phone number from a UUID slice", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        if (UUID_SLICE_PHONE.test(line) || UUID_SLICE_ASSIGNMENT.test(line)) {
          offenders.push(`${path.relative(path.resolve(__dirname, "..", ".."), file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      // Jest prints the array; the message is for whoever reads the failure.
    ).toEqual([]);
  });
});
