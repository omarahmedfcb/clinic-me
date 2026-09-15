// Creates the first operator — pilot-readiness 0a. `npm run platform:admin -- <path-to-json>`.
// Reads a file rather than taking arguments: an Arabic name must never travel through a shell.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/prisma/client.ts";
import { normalisePhone, loginCountry } from "../src/modules/auth/phone.ts";
import { ensurePlatformAdmin } from "../prisma/seed/platform-admin.ts";

/**
 * **The name comes from a file, not from `argv`.** `CLAUDE.md`: Arabic never travels through a shell
 * payload — a `curl -d` with an Arabic name once stored `"???? ??? ?????? ???????"` as a clinic
 * owner's, silently. A JSON file the editor wrote has no such failure mode, and the operator's name
 * is exactly the field that would carry one.
 *
 * The password is generated here and printed once. It is never stored in the file, never logged
 * anywhere else, and cannot be read back — `must_change_password` is the intended follow-up in 0e,
 * where the reset flow lives.
 */
interface OperatorFile {
  fullName: string;
  phoneE164: string;
  email?: string | null;
}

function readOperator(path: string): OperatorFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path}: expected a JSON object with fullName and phoneE164.`);
  }
  const file = parsed as Partial<OperatorFile>;
  if (typeof file.fullName !== "string" || file.fullName.trim() === "") {
    throw new Error(`${path}: "fullName" is required.`);
  }
  if (typeof file.phoneE164 !== "string") {
    throw new Error(`${path}: "phoneE164" is required.`);
  }
  return { fullName: file.fullName.trim(), phoneE164: file.phoneE164, email: file.email ?? null };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    throw new Error(
      "Usage: npm run platform:admin -- <path-to-json>\n" +
        'The file holds { "fullName": "…", "phoneE164": "+20…", "email": "…" }.',
    );
  }

  const file = readOperator(path);
  const phone = normalisePhone(file.phoneE164, loginCountry());
  if (phone === null) throw new Error(`${file.phoneE164} is not a valid phone number.`);

  // 24 bytes of base64url: long enough that it is never guessed, short enough to read aloud once.
  const password = randomBytes(18).toString("base64url");
  const result = await ensurePlatformAdmin({ ...file, phoneE164: phone, password });

  if (!result.created) {
    console.log(`${phone} already exists. No password was set — use the reset path, not this script.`);
    return;
  }

  console.log("Platform operator created. This password is shown once and cannot be read back:\n");
  console.log(`  phone     ${phone}`);
  console.log(`  password  ${password}\n`);
  console.log("They hold no membership in any clinic, and can read no clinical or financial row.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
