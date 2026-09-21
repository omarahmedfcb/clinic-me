import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { BOT_IDENTIFIER_PREFIX, botUserIdentifier, isBotIdentifier } from "../../src/modules/bot/bot-identifier.ts";
import { normalisePhone } from "../../src/modules/auth/phone.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * A bot's identifier is not a phone number, and no person can ever hold one.
 *
 * Until 2026-09-18 a bot's `users` row carried `+2010` and eight random digits — a perfectly
 * plausible Egyptian mobile. The founder's ruling: a clearly synthetic, non-dialable identifier from
 * a range the real world cannot occupy, proven by breaking it rather than asserted.
 */
const SERVICE = path.join(__dirname, "..", "..", "src", "modules", "bot", "bot-credential.service.ts");

/** Every country the login parses against. A hint this project refuses to hardcode (CLAUDE.md). */
const COUNTRIES = ["EG", "SA", "AE"] as const;

describe("the bot's identifier is not a phone number", () => {
  test("the normaliser refuses it, so no login can ever resolve to a bot", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const identifier = botUserIdentifier();
      for (const country of COUNTRIES) {
        expect(normalisePhone(identifier, country)).toBeNull();
      }
    }
  });

  test("it is not a valid number in any country libphonenumber knows", () => {
    // Not merely "not Egyptian": +999 is unassigned by the ITU, so this holds for every region.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(parsePhoneNumberFromString(botUserIdentifier())?.isValid() ?? false).toBe(false);
    }
  });

  test("no valid Egyptian mobile can collide with the reserved range", () => {
    // Both directions: a real number never carries the prefix, and an identifier never parses as one.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const real = generateFixturePhone();
      expect(real.startsWith(BOT_IDENTIFIER_PREFIX)).toBe(false);
      expect(isBotIdentifier(real)).toBe(false);
      expect(parsePhoneNumberFromString(real, "EG")?.isValid()).toBe(true);
    }
  });

  test("the credential service builds the bot's row from this and nothing else", () => {
    // The guard the ruling asks for: a hand-written `+20…` here is how the plausible number got in.
    const source = readFileSync(SERVICE, "utf8");
    expect(source).toContain("botUserIdentifier()");
    expect(source.match(/"\+\d/g) ?? []).toEqual([]);
    expect(source.match(/`\+\d/g) ?? []).toEqual([]);
  });
});
