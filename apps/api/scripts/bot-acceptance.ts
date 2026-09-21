// The acceptance suite of docs/WHATSAPP-BOT-CONTRACT.md §9, runnable by the external developer
// against the sandbox. Prints a pass/fail report and exits non-zero if anything failed.

import { writeFileSync } from "node:fs";
import { runChecks, type CheckResult, type Fixtures } from "./bot-acceptance-checks.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const fixtures: Fixtures = {
  baseUrl: (flag("base-url") ?? "http://localhost:3100").replace(/\/$/, ""),
  credentialId: flag("credential-id") ?? "",
  secret: flag("secret") ?? "",
  phone: flag("phone"),
  doctorId: flag("doctor-id"),
  serviceId: flag("service-id"),
  foreignAppointmentId: flag("foreign-appointment-id"),
  webhookSecret: flag("webhook-secret"),
};

if (fixtures.credentialId === "" || fixtures.secret === "") {
  console.error(
    "Usage: npm run bot:acceptance -- --base-url <url> --credential-id <id> --secret <secret>\n" +
      "  optional, and the checks that need them are SKIPPED without them:\n" +
      "  --phone <E.164> --doctor-id <id> --service-id <id> --foreign-appointment-id <id> --webhook-secret <s>\n" +
      "  --json <path> writes the report as JSON for handing back.\n\n" +
      "Every value is printed by `npm run preview` in the BOT SANDBOX block.",
  );
  process.exit(2);
}

const MARK: Record<CheckResult["outcome"], string> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  skipped: "SKIP   ",
  manual: "EVIDENCE",
};

const results = await runChecks(fixtures);

const rule = "─".repeat(78);
console.log(`\n${rule}\n  BOT ACCEPTANCE — docs/WHATSAPP-BOT-CONTRACT.md §9\n  ${fixtures.baseUrl}\n${rule}`);
let section = "";
for (const result of results) {
  if (result.section !== section) {
    section = result.section;
    console.log(`\n  ${section}`);
  }
  console.log(`    ${MARK[result.outcome]}  ${String(result.item).padStart(2)}. ${result.title}`);
  if (result.detail !== "") console.log(`              ${result.detail}`);
}

const counted = (outcome: CheckResult["outcome"]): number => results.filter((r) => r.outcome === outcome).length;
const failed = counted("fail");
console.log(
  `\n${rule}\n  ${counted("pass")} passed   ${failed} failed   ${counted("skipped")} skipped   ` +
    `${counted("manual")} awaiting the developer's own evidence\n${rule}\n`,
);

const jsonPath = flag("json");
if (jsonPath !== undefined) {
  writeFileSync(jsonPath, `${JSON.stringify({ baseUrl: fixtures.baseUrl, ranAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`  Report written to ${jsonPath}\n`);
}

// Non-zero on a failure, so this can gate a hand-over rather than be read charitably.
process.exit(failed === 0 ? 0 : 1);
