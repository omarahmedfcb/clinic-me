// The web app names a time zone in exactly one file; any quoted IANA zone elsewhere fails the build.
// Spec fixtures are exempt (they describe data), and so are comments, which hold no quoted zone.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WEB_SRC = path.resolve(__dirname, "..", "..", "..", "web", "src");
const HOME = "lib/clinic-time-zone.ts";
const ZONE = /["'`](Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+["'`]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const relative = (file: string): string => path.relative(WEB_SRC, file).replace(/\\/g, "/");

describe("time zone literals in the web app", () => {
  test("the shared constant is the only place a zone is named", () => {
    const found = sourceFiles(WEB_SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line, index) => (ZONE.test(line) ? [`${relative(file)}:${index + 1}  ${line.trim()}`] : [])),
    );
    expect(found.filter((hit) => !hit.startsWith(`${HOME}:`))).toEqual([]);
  });

  test("the scan actually sees the constant, so an empty result above is not a scan that read nothing", () => {
    expect(ZONE.test(readFileSync(path.join(WEB_SRC, HOME), "utf8"))).toBe(true);
  });
});
