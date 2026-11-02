// The push gate (ruled 2026-11-01): a push is refused unless `npm run verify` last passed on exactly the pushed commit. The
// decision is tested here; the hook and the verify script are checked to wire it in, so neither can drop it unnoticed.
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("the push gate", () => {
  let verifiedRefusal: (marker: string | null, sha: string) => string | null;

  beforeAll(async () => {
    ({ verifiedRefusal } = await import("../../../../scripts/check-verified.mjs"));
  });

  test("allows exactly the commit verify last passed on", () => {
    expect(verifiedRefusal(`${SHA}\n`, SHA)).toBeNull();
  });

  test("refuses with no marker: the last verify failed, or never ran on a clean tree", () => {
    expect(verifiedRefusal(null, SHA)).toContain("has not passed");
  });

  test("refuses a commit verify did not pass on, even one after it", () => {
    expect(verifiedRefusal("fedcba9876543210fedcba9876543210fedcba98\n", SHA)).toContain("not on");
  });

  test("the pre-push hook calls it for every pushed commit", () => {
    expect(readFileSync(path.join(ROOT, ".githooks", "pre-push"), "utf8")).toContain('node "$root/scripts/check-verified.mjs" "$local_sha" || exit 1');
  });

  test("verify clears the marker before anything runs, and writes it only after everything passed", () => {
    const verify = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["verify"]!;
    expect(verify.startsWith("node scripts/mark-verified.mjs --clear && ")).toBe(true);
    expect(verify.endsWith(" && node scripts/mark-verified.mjs")).toBe(true);
  });
});
