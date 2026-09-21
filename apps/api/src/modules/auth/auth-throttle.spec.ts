import {
  AUTH_THROTTLERS,
  AUTH_THROTTLE_LIMITS,
  PASSWORD_THROTTLER,
  identifierTracker,
  ipTracker,
  passwordUserTracker,
} from "./auth-throttle.ts";

/**
 * The two rate-limit buckets are separate on purpose, and the reason is visible only in these
 * keys: what counts as "the same caller" differs between them. These tests assert the key
 * derivation, which is where the design lives. The wiring lands with the endpoints.
 */

describe("auth rate-limit keys", () => {
  describe("per-identifier bucket", () => {
    test("the same account is one bucket however the number is typed", () => {
      // Without digit folding, an attacker gets a fresh allowance per notation -- and there are at
      // least three notations for every Egyptian mobile.
      const canonical = identifierTracker({ body: { identifier: "01001234567" } });
      expect(identifierTracker({ body: { identifier: "٠١٠٠١٢٣٤٥٦٧" } })).toBe(canonical);
      expect(identifierTracker({ body: { identifier: "۰۱۰۰۱۲۳۴۵۶۷" } })).toBe(canonical);
      expect(identifierTracker({ body: { identifier: "  01001234567  " } })).toBe(canonical);
    });

    test("email identifiers are case-folded, since addresses are not case-sensitive in practice", () => {
      expect(identifierTracker({ body: { identifier: "Dina@Clinic.EG" } })).toBe(
        identifierTracker({ body: { identifier: "dina@clinic.eg" } }),
      );
    });

    test("different accounts are different buckets", () => {
      expect(identifierTracker({ body: { identifier: "01001234567" } })).not.toBe(
        identifierTracker({ body: { identifier: "01009999999" } }),
      );
    });

    test("the same account from two IPs is still ONE bucket", () => {
      // The property that defeats an attacker rotating source addresses. A composite (ip,
      // identifier) key would hand them a fresh allowance per IP.
      expect(identifierTracker({ ip: "1.1.1.1", body: { identifier: "01001234567" } })).toBe(
        identifierTracker({ ip: "2.2.2.2", body: { identifier: "01001234567" } }),
      );
    });

    test("with no identifier in the body it falls back to the IP, not to a constant", () => {
      // /auth/refresh and /auth/logout present a cookie. A constant key would put every such
      // request into one global bucket, letting one client deny the endpoint to everyone.
      expect(identifierTracker({ ip: "9.9.9.9", body: {} })).toBe("ip:9.9.9.9");
      expect(identifierTracker({ ip: "9.9.9.9" })).toBe("ip:9.9.9.9");
      expect(identifierTracker({ ip: "9.9.9.9", body: { identifier: 42 } })).toBe("ip:9.9.9.9");
    });
  });

  describe("per-IP bucket", () => {
    test("two accounts from one address share it", () => {
      // The property that catches a spray across many accounts from one machine.
      expect(ipTracker({ ip: "1.1.1.1", body: { identifier: "a" } })).toBe(
        ipTracker({ ip: "1.1.1.1", body: { identifier: "b" } }),
      );
    });

    test("different addresses are different buckets, which is why a clinic behind NAT is not locked out by one attacker elsewhere", () => {
      expect(ipTracker({ ip: "1.1.1.1" })).not.toBe(ipTracker({ ip: "2.2.2.2" }));
    });
  });

  describe("the two buckets are independent", () => {
    test("they never produce the same key for the same request", () => {
      // If they collided, there would effectively be one bucket and one of the two failure modes
      // documented in auth-throttle.ts would be live.
      const request = { ip: "1.1.1.1", body: { identifier: "01001234567" } };
      expect(identifierTracker(request)).not.toBe(ipTracker(request));
    });

    test("all three throttlers are registered, named, and share one window", () => {
      expect(AUTH_THROTTLERS.map((t) => t.name).sort()).toEqual([
        "auth-identifier",
        "auth-ip",
        PASSWORD_THROTTLER,
      ]);
      expect(AUTH_THROTTLERS.every((t) => t.ttl === AUTH_THROTTLE_LIMITS.windowMs)).toBe(true);
    });

    test("the per-IP limit is the looser of the two, because it is shared by a whole clinic", () => {
      // If the IP limit were the tighter one, a busy reception desk would hit it first and the
      // per-identifier control -- the one that actually stops guessing -- would never engage.
      expect(AUTH_THROTTLE_LIMITS.ip).toBeGreaterThan(AUTH_THROTTLE_LIMITS.identifier);
    });
  });

  describe("the change-password bucket", () => {
    test("keys on the authenticated user, not the address", () => {
      // The whole point: a clinic is one public IP. Keyed on the address, one member of staff
      // exhausting the limit would lock the reception desk out of changing passwords.
      const shared = { ip: "203.0.113.10" };
      const amira = passwordUserTracker({ ...shared, authClaims: { sub: "user-amira" } });
      const hossam = passwordUserTracker({ ...shared, authClaims: { sub: "user-hossam" } });

      expect(amira).toBe("user:user-amira");
      expect(amira).not.toBe(hossam);
    });

    test("the same user from two devices shares one bucket", () => {
      const first = passwordUserTracker({ ip: "203.0.113.10", authClaims: { sub: "user-amira" } });
      const second = passwordUserTracker({ ip: "198.51.100.4", authClaims: { sub: "user-amira" } });
      expect(first).toBe(second);
    });

    test("falls back to the address when there are no claims, never to a constant", () => {
      // Unreachable behind AuthGuard, but a fallback that keyed everyone together would let one
      // caller deny the endpoint to every user at once.
      expect(passwordUserTracker({ ip: "203.0.113.10" })).toBe("ip:203.0.113.10");
      expect(passwordUserTracker({ ip: "203.0.113.10", authClaims: { sub: 42 } })).toBe("ip:203.0.113.10");
      expect(passwordUserTracker({ ip: "203.0.113.10" })).not.toBe(passwordUserTracker({ ip: "198.51.100.4" }));
    });

    test("is tighter than the login bucket", () => {
      // A signed-in user knows their own password. Guessing it is what this limit is for.
      expect(AUTH_THROTTLE_LIMITS.password).toBeLessThan(AUTH_THROTTLE_LIMITS.identifier);
    });
  });
});
