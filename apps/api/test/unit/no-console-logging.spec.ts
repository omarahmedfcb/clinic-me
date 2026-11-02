import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

// Request-path code logs through Nest's Logger, which has levels; a bare console.log on a hot path
// buried the logs for a month ([book-timing], removed 2026-10-29).
const API_SRC = path.resolve(__dirname, "..", "..", "src");

test("no console.log, console.debug or console.time in apps/api/src", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(API_SRC, [".ts"])) {
    if (file.endsWith(".spec.ts")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    if (/\bconsole\.(log|debug|time|timeEnd)\(/.test(text)) offenders.push(path.relative(API_SRC, file).split(path.sep).join("/"));
  }
  expect(offenders).toEqual([]);
});
