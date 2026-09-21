import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * The client IP recorded in `audit_logs`, end to end: what Express resolves from a proxied request,
 * through `withTenant()`, into the row the audit trigger writes.
 *
 * ## Why this is correctness rather than configuration
 *
 * `audit_logs.ip_address` is one of the few facts a database trigger structurally cannot discover
 * for itself (SCHEMA-DECISIONS.md D16) — it is an HTTP-layer concept, threaded through
 * `withTenant()` as `actor.ip` and bound as `app.current_ip`. Behind a reverse proxy every request
 * arrives from the proxy's address, and Express reports *that* as `req.ip` unless `trust proxy` is
 * set. Without it, every audit row in the system records the proxy — uniformly, silently, in an
 * append-only table that cannot be corrected afterwards.
 *
 * A wrong audit trail that looks complete is worse than an absent one, which is why this is tested
 * rather than configured and hoped for.
 *
 * ## Why `trust proxy` takes a hop count and not `true`
 *
 * `X-Forwarded-For` is a client-supplied header. Trusting it unconditionally means a caller can
 * prepend any address it likes and have that written to the audit trail — corruption from the
 * other direction. A hop count of 1 trusts exactly the last hop (Caddy) and ignores whatever the
 * client appended before it. The third test below is the one that proves that distinction.
 *
 * ## What this does NOT prove
 *
 * That a controller passes `req.ip` into `ActorContext`. No controller writes anything yet —
 * `GET /health` is the only route. That link closes with the auth endpoints, and belongs in their
 * tests. Everything either side of it is proven here.
 */

const CLIENT_IP = "197.51.100.42";
const FORGED_IP = "203.0.113.9";

/** A minimal Express app configured exactly as `main.ts` configures the Nest one. */
function appWithTrustProxy(trustProxy: number | undefined): express.Express {
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.get("/whoami", (request, response) => {
    response.json({ ip: request.ip });
  });
  return app;
}

async function observedIp(app: express.Express, forwardedFor: string): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const result = await fetch(`http://127.0.0.1:${port}/whoami`, {
      headers: { "X-Forwarded-For": forwardedFor },
    });
    const body = (await result.json()) as { ip: string };
    return body.ip;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("forwarded client IP reaches the audit trail", () => {
  describe("what Express resolves behind a proxy", () => {
    test("without trust proxy it reports the connecting address, not the client", async () => {
      // The bug, reproduced. Every audit row would carry this value.
      const ip = await observedIp(appWithTrustProxy(undefined), CLIENT_IP);
      expect(ip).not.toContain(CLIENT_IP);
      expect(ip).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    });

    test("with one trusted hop it reports the client address", async () => {
      const ip = await observedIp(appWithTrustProxy(1), CLIENT_IP);
      expect(ip).toBe(CLIENT_IP);
    });

    test("with one trusted hop a client cannot forge an address by prepending one", async () => {
      // A caller sending "forged, real" gets the RIGHTMOST untrusted entry -- the address the
      // trusted proxy observed -- not the one it invented. Setting `trust proxy` to `true` here
      // would return the forged value instead, which is why the hop count is not cosmetic.
      const ip = await observedIp(appWithTrustProxy(1), `${FORGED_IP}, ${CLIENT_IP}`);
      expect(ip).toBe(CLIENT_IP);
      expect(ip).not.toBe(FORGED_IP);
    });
  });

  describe("what the audit trigger records", () => {
    let fixture: ClinicFixture;

    beforeAll(async () => {
      fixture = await seedClinic();
    });

    afterAll(async () => {
      await teardownClinic(fixture);
    });

    test("the IP bound by withTenant is the IP written to audit_logs", async () => {
      const patientId = randomUUID();

      await withTenant(fixture.tenantId, { ...actorFor(fixture.userId), ip: CLIENT_IP }, async (tx) => {
        await tx.patient.create({
          data: injected({
            id: patientId,
            fullNameAr: "مريض من خلف الوسيط",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
      });

      // Read inside a bound session: audit_logs carries RLS (D17), so an unbound query returns
      // zero rows -- the policy failing closed, not an absent audit row.
      const rows = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.$queryRaw<{ ip_address: string }[]>`
          SELECT ip_address FROM audit_logs WHERE entity_id = ${patientId}::uuid AND action = 'CREATE'
        `,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.ip_address).toBe(CLIENT_IP);
    });

    test("a different IP produces a different row, so the column is not a constant", async () => {
      // Without this, an implementation that hardcoded an address would pass the test above.
      const patientId = randomUUID();

      await withTenant(fixture.tenantId, { ...actorFor(fixture.userId), ip: FORGED_IP }, async (tx) => {
        await tx.patient.create({
          data: injected({
            id: patientId,
            fullNameAr: "مريض آخر",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
      });

      // Read inside a bound session: audit_logs carries RLS (D17), so an unbound query returns
      // zero rows -- the policy failing closed, not an absent audit row.
      const rows = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.$queryRaw<{ ip_address: string }[]>`
          SELECT ip_address FROM audit_logs WHERE entity_id = ${patientId}::uuid AND action = 'CREATE'
        `,
      );

      expect(rows[0]?.ip_address).toBe(FORGED_IP);
    });
  });
});
