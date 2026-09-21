import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  TOTP_STEP_SECONDS,
  totpCode,
  verifyTotp,
} from "./totp.ts";

/**
 * RFC 6238's own vectors, not a round-trip of this file against itself.
 *
 * A TOTP implementation that agrees with itself and with nothing else looks correct in every test
 * anybody would write for it, and fails the first time a real authenticator app is pointed at it —
 * at which point the operator is locked out of the console and the cause is invisible. The vectors
 * below are the published ones, so passing them means Google Authenticator and Authy will agree.
 */

/** RFC 6238 Appendix B: the ASCII secret "12345678901234567890", SHA-1. */
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_BASE32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));

describe("base32", () => {
  test("encodes the RFC secret to the value every authenticator expects", () => {
    expect(RFC_SECRET_BASE32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  test("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 17]);
    expect(base32Decode(base32Encode(bytes))?.equals(bytes)).toBe(true);
  });

  test("returns null rather than throwing on anything that is not base32", () => {
    // It is fed user input on the enrolment path, where a throw would be a 500 for a typo.
    expect({ punctuation: base32Decode("not-base32!"), empty: base32Decode("  ") }).toEqual({
      punctuation: null,
      empty: null,
    });
  });

  test("tolerates the padding and spacing an authenticator shows", () => {
    expect(base32Decode("gezd gnbv gy3t qojq====")?.length).toBe(10);
  });
});

describe("HOTP against RFC 4226's vectors", () => {
  // RFC 4226 Appendix D, the same secret, counters 0-9.
  const EXPECTED = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  test("every counter matches", () => {
    const secret = Buffer.from(RFC_SECRET_ASCII, "ascii");
    expect(EXPECTED.map((_, counter) => hotp(secret, counter))).toEqual(EXPECTED);
  });
});

describe("TOTP against RFC 6238's vectors", () => {
  /** Appendix B, SHA-1 rows, truncated to the six digits this product uses. */
  const ROWS: { at: number; code: string }[] = [
    { at: 59, code: "287082" },
    { at: 1_111_111_109, code: "081804" },
    { at: 1_111_111_111, code: "050471" },
    { at: 1_234_567_890, code: "005924" },
    { at: 2_000_000_000, code: "279037" },
  ];

  test("every published instant produces the published code", () => {
    expect(ROWS.map(({ at }) => ({ at, code: totpCode(RFC_SECRET_BASE32, at) }))).toEqual(ROWS);
  });

  test("the step is thirty seconds, which is what those vectors assume", () => {
    expect(TOTP_STEP_SECONDS).toBe(30);
  });
});

describe("verification", () => {
  const AT = 1_111_111_111;

  test("accepts the current code", () => {
    expect(verifyTotp(RFC_SECRET_BASE32, totpCode(RFC_SECRET_BASE32, AT) ?? "", AT)).toBe(true);
  });

  test("accepts one step either side, and nothing beyond", () => {
    const window = [-2, -1, 0, 1, 2].map((steps) => ({
      steps,
      accepted: verifyTotp(RFC_SECRET_BASE32, totpCode(RFC_SECRET_BASE32, AT + steps * 30) ?? "", AT),
    }));
    // A drifting phone clock is the reason for ±1; two steps is ninety seconds of stale code, and
    // accepting it would double the replay window for nothing.
    expect(window).toEqual([
      { steps: -2, accepted: false },
      { steps: -1, accepted: true },
      { steps: 0, accepted: true },
      { steps: 1, accepted: true },
      { steps: 2, accepted: false },
    ]);
  });

  test("tolerates a pasted code with a space in the middle", () => {
    const code = totpCode(RFC_SECRET_BASE32, AT) ?? "";
    expect(verifyTotp(RFC_SECRET_BASE32, `${code.slice(0, 3)} ${code.slice(3)}`, AT)).toBe(true);
  });

  test("refuses anything that is not six digits, and a wrong six", () => {
    const answers = ["", "12345", "1234567", "abcdef", "000000"].map((submitted) => ({
      submitted,
      accepted: verifyTotp(RFC_SECRET_BASE32, submitted, AT),
    }));
    expect(answers.every((row) => row.accepted === false)).toBe(true);
  });

  test("refuses everything when the stored secret is unusable", () => {
    // A row with a corrupt secret must not become an account whose second factor always passes.
    expect(verifyTotp("not-base32!", "000000", AT)).toBe(false);
    expect(verifyTotp("", "000000", AT)).toBe(false);
  });
});

describe("enrolment", () => {
  test("a generated secret is 160 bits of base32, which is what RFC 4226 recommends", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)?.length).toBe(20);
  });

  test("two secrets are not the same", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  test("the otpauth URI carries the issuer twice, and the parameters an app reads", () => {
    const uri = otpauthUri({ secretBase32: RFC_SECRET_BASE32, account: "+201000000000", issuer: "clinic-os" });
    // In the label and in the parameter: several apps read only one of the two, and an operator
    // with three accounts needs to tell them apart.
    expect(uri.startsWith("otpauth://totp/clinic-os%3A%2B201000000000?")).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET_BASE32}`);
    expect(uri).toContain("issuer=clinic-os");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
