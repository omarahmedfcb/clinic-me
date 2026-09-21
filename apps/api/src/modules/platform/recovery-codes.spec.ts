import {
  LOW_REMAINING_THRESHOLD,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  generateRecoveryCode,
  generateRecoveryCodes,
  isWellFormedRecoveryCode,
  normaliseRecoveryCode,
} from "./recovery-codes.ts";

describe("operator recovery codes", () => {
  describe("the alphabet", () => {
    test("excludes every character a person confuses when reading one off paper", () => {
      // The moment these are typed is the moment the phone is gone, which is the worst time to
      // discover that O and 0 were both plausible.
      for (const ambiguous of ["0", "O", "1", "I", "L", "U"]) {
        expect(RECOVERY_ALPHABET).not.toContain(ambiguous);
      }
    });

    test("is all upper case, so normalisation has one direction to go", () => {
      expect(RECOVERY_ALPHABET).toBe(RECOVERY_ALPHABET.toUpperCase());
    });
  });

  describe("generation", () => {
    test("is the specified length, from the alphabet only", () => {
      for (let index = 0; index < 200; index += 1) {
        const code = generateRecoveryCode();
        expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
        expect([...code].every((character) => RECOVERY_ALPHABET.includes(character))).toBe(true);
      }
    });

    test("issues a full set, all distinct", () => {
      const codes = generateRecoveryCodes();
      expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
      expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    });

    test("does not favour the start of the alphabet — rejection sampling, not modulo", () => {
      // 256 is not a multiple of 30, so `byte % alphabet.length` would make the first sixteen
      // characters about 6% likelier than the rest. Small, and free to avoid.
      const seen = new Map<string, number>();
      for (let index = 0; index < 2000; index += 1) {
        for (const character of generateRecoveryCode()) {
          seen.set(character, (seen.get(character) ?? 0) + 1);
        }
      }
      const counts = [...seen.values()];
      const expected = (2000 * RECOVERY_CODE_LENGTH) / RECOVERY_ALPHABET.length;
      // Generous bounds: this is a bias check, not a randomness test.
      expect(Math.min(...counts)).toBeGreaterThan(expected * 0.75);
      expect(Math.max(...counts)).toBeLessThan(expected * 1.25);
    });
  });

  describe("reading one back", () => {
    test("forgives case and the separators a person adds", () => {
      const code = generateRecoveryCode();
      const typed = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
      expect(normaliseRecoveryCode(typed)).toBe(code);
      expect(normaliseRecoveryCode(`  ${code}  `)).toBe(code);
    });

    test("drops characters outside the alphabet rather than refusing", () => {
      // Whether it matches is the caller's question. Answering "malformed" differently from "wrong"
      // would tell an attacker which of the two they had.
      expect(normaliseRecoveryCode("ABCDE!FGHJ")).toBe("ABCDEFGHJ");
      expect(normaliseRecoveryCode("")).toBe("");
    });

    test("shape is checked separately from content", () => {
      expect(isWellFormedRecoveryCode(generateRecoveryCode())).toBe(true);
      expect(isWellFormedRecoveryCode("TOOSHORT")).toBe(false);
      expect(isWellFormedRecoveryCode("")).toBe(false);
    });
  });

  test("the nag threshold leaves room to act before the last code", () => {
    expect(LOW_REMAINING_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_REMAINING_THRESHOLD).toBeLessThan(RECOVERY_CODE_COUNT);
  });
});
