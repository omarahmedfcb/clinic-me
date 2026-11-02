// The platform reader (branches 6.5) is a machine identity: its phone, read from the migration that writes it, must be
// refused by the same normaliser a person's input passes through, in every country the login parses against.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { normalisePhone } from "../../src/modules/auth/phone.ts";

const MIGRATION = path.join(__dirname, "..", "..", "prisma", "migrations", "20261101062000_platform_reader", "migration.sql");

describe("the platform reader cannot be anybody", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const phone = /'019b76da-a800-7000-8000-000000000002', NULL, '(\+\d+)'/.exec(sql)?.[1];

  test("the migration gives it a phone this guard can read, and no login", () => {
    expect(phone).toBeDefined();
    expect(sql).toContain("'no-login:platform-reader'");
    expect(sql).toContain("'LOCKED'");
  });

  test("no country the login parses against accepts that phone, and it is valid nowhere", () => {
    for (const country of ["EG", "SA", "AE"] as const) expect(normalisePhone(phone!, country)).toBeNull();
    expect(parsePhoneNumberFromString(phone!)?.isValid() ?? false).toBe(false);
  });
});
