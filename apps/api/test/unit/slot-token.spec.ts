import {
  SLOT_TOKEN_TTL_MS,
  mintSlotToken,
  verifySlotToken,
} from "../../src/modules/appointments/slot-token.ts";

/**
 * The slot token — PHASE-2.md §5, Q24.
 *
 * ARCHITECTURE.md §12 rule 1 claims hallucinated availability is *architecturally* impossible.
 * That claim rests entirely on this file: booking takes the token's values and the request has no
 * field naming a time, so a slot the clinic never offered has no valid token. These tests are
 * therefore not about a signing helper — they are the evidence for a security property the
 * product's whole AI story is built on.
 *
 * The secret is set here rather than read from the environment, so this spec runs under
 * `npm run test:no-dotenv` on a machine with no `.env` — the module reads `SLOT_TOKEN_SECRET`
 * per call, not at import, exactly so that is possible.
 */
const SECRET = "unit-test-slot-token-secret-not-a-real-key";
const OTHER_SECRET = "a-different-unit-test-secret-also-not-real";

const TENANT = "00000000-0000-7000-8000-00000000000a";
const OTHER_TENANT = "00000000-0000-7000-8000-00000000000b";
const NOW = new Date("2026-09-01T09:00:00Z");

const claims = {
  tenantId: TENANT,
  doctorId: "00000000-0000-7000-8000-0000000000d1",
  serviceId: "00000000-0000-7000-8000-0000000000s1",
  startMs: Date.parse("2026-09-02T07:00:00Z"),
  endMs: Date.parse("2026-09-02T07:30:00Z"),
};

describe("slot token", () => {
  const original = process.env["SLOT_TOKEN_SECRET"];

  beforeEach(() => {
    process.env["SLOT_TOKEN_SECRET"] = SECRET;
  });

  afterAll(() => {
    if (original === undefined) delete process.env["SLOT_TOKEN_SECRET"];
    else process.env["SLOT_TOKEN_SECRET"] = original;
  });

  it("round-trips the exact slot it was minted for", () => {
    const result = verifySlotToken(mintSlotToken(claims, NOW), TENANT, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.doctorId).toBe(claims.doctorId);
    expect(result.claims.serviceId).toBe(claims.serviceId);
    expect(result.claims.startMs).toBe(claims.startMs);
    expect(result.claims.endMs).toBe(claims.endMs);
  });

  /**
   * The core property. A token is not a bearer credential for "some slot" — it names one, and the
   * values that come back out are the ones that went in. If a caller could alter the time inside
   * a still-valid token, §12 rule 1 would be a statement about etiquette.
   */
  it("refuses a token whose payload was edited", () => {
    const token = mintSlotToken(claims, NOW);
    const [encoded, signature] = token.split(".") as [string, string];
    const body = Buffer.from(encoded, "base64url").toString("utf8");

    // Move the slot an hour later, leaving everything else — including the signature — alone.
    const tampered = body.replace(String(claims.startMs), String(claims.startMs + 3_600_000));
    expect(tampered).not.toBe(body);

    const forged = `${Buffer.from(tampered).toString("base64url")}.${signature}`;
    expect(verifySlotToken(forged, TENANT, NOW)).toEqual({ ok: false, failure: "BAD_SIGNATURE" });
  });

  it("refuses a token signed with a different key", () => {
    process.env["SLOT_TOKEN_SECRET"] = OTHER_SECRET;
    const foreign = mintSlotToken(claims, NOW);
    process.env["SLOT_TOKEN_SECRET"] = SECRET;

    expect(verifySlotToken(foreign, TENANT, NOW)).toEqual({ ok: false, failure: "BAD_SIGNATURE" });
  });

  /**
   * A perfectly valid signature is still refused across tenants. Without this a token would be a
   * cross-tenant capability: signed by us, genuinely ours, and usable against a clinic it was
   * never minted for.
   */
  it("refuses a valid token presented for another tenant", () => {
    const token = mintSlotToken(claims, NOW);
    expect(verifySlotToken(token, OTHER_TENANT, NOW)).toEqual({ ok: false, failure: "WRONG_TENANT" });
  });

  describe("expiry", () => {
    it("accepts a token one second before its TTL elapses", () => {
      const token = mintSlotToken(claims, NOW);
      const almost = new Date(NOW.getTime() + SLOT_TOKEN_TTL_MS - 1000);
      expect(verifySlotToken(token, TENANT, almost).ok).toBe(true);
    });

    /**
     * **An expired token carries its claims, and no other failure does** — 2026-09-13.
     *
     * The caller needs the slot's time to tell "the offer went stale" from "the time itself has
     * gone", and since that ruling the second is the sentence whenever both are true. The claims are
     * trustworthy here because the signature is verified before the expiry ever is.
     */
    it("refuses a token one second after, and hands back what it was for", () => {
      const token = mintSlotToken(claims, NOW);
      const past = new Date(NOW.getTime() + SLOT_TOKEN_TTL_MS + 1000);
      const result = verifySlotToken(token, TENANT, past);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toBe("EXPIRED");
      if (result.failure !== "EXPIRED") return;
      expect(result.claims).toMatchObject({ startMs: claims.startMs, endMs: claims.endMs });
    });

    it("an expired token for another tenant hands back nothing", () => {
      // WRONG_TENANT rather than EXPIRED: a token this clinic did not mint is not answered with its
      // contents, even though the signature is ours.
      const token = mintSlotToken(claims, NOW);
      const past = new Date(NOW.getTime() + SLOT_TOKEN_TTL_MS + 1000);
      expect(verifySlotToken(token, "00000000-0000-4000-8000-000000000000", past)).toEqual({
        ok: false,
        failure: "WRONG_TENANT",
      });
    });

    /** `now` is a parameter here too — a clock read would make expiry untestable and unpinnable. */
    it("does not read the clock", () => {
      const token = mintSlotToken(claims, new Date("2000-01-01T00:00:00Z"));
      expect(verifySlotToken(token, TENANT, new Date("2000-01-01T00:05:00Z")).ok).toBe(true);
    });
  });

  it.each(["", "not-a-token", "a.b.c", "onlyonepart"])("refuses malformed input %p", (bad) => {
    const result = verifySlotToken(bad, TENANT, NOW);
    expect(result.ok).toBe(false);
  });

  /**
   * Signature is checked before expiry and before the tenant, so a forged token is never told
   * which of its fabricated fields would have been wrong. Asserted because the ordering is easy
   * to lose in a refactor and produces no visible symptom when it is.
   */
  it("reports a bad signature rather than expiry for a forged, expired token", () => {
    process.env["SLOT_TOKEN_SECRET"] = OTHER_SECRET;
    const foreign = mintSlotToken(claims, new Date("2000-01-01T00:00:00Z"));
    process.env["SLOT_TOKEN_SECRET"] = SECRET;

    expect(verifySlotToken(foreign, OTHER_TENANT, NOW)).toEqual({
      ok: false,
      failure: "BAD_SIGNATURE",
    });
  });

  it("refuses to mint without a secret long enough to be one", () => {
    process.env["SLOT_TOKEN_SECRET"] = "short";
    expect(() => mintSlotToken(claims, NOW)).toThrow(/at least 32 characters/);

    delete process.env["SLOT_TOKEN_SECRET"];
    expect(() => mintSlotToken(claims, NOW)).toThrow(/SLOT_TOKEN_SECRET must be set/);
  });

  /** Two tokens for the same slot differ, so they are distinguishable in a log. */
  it("mints a distinct token each time", () => {
    expect(mintSlotToken(claims, NOW)).not.toBe(mintSlotToken(claims, NOW));
  });
});
