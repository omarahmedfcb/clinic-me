import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Body, Controller, Module, Post, UseGuards } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { actorContext } from "../../src/common/actor-context.ts";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { AuthGuard } from "../../src/common/auth.guard.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * The audit chain, closed end to end over real HTTP:
 *
 *     X-Forwarded-For  ->  Express `trust proxy`  ->  req.ip
 *                      ->  ActorContextInterceptor  ->  actorContext
 *                      ->  withTenant()  ->  app.current_ip
 *                      ->  the audit trigger  ->  audit_logs.ip_address
 *
 * Every link is the production one: the real `AuthGuard`, the real `ActorContextInterceptor`, the
 * real `withTenant()`, the real trigger. Only the controller is written here, and that is the
 * point of the warning below.
 *
 * ## No production endpoint closes this chain yet, and that is by design
 *
 * **Do not read a green test named "the audit chain closes" as "the product audits logins." It
 * does not.** The audit triggers in `prisma/sql/07-audit-triggers.sql` are installed on the 29
 * tenant-scoped tables only, matching the RLS list exactly. `users` and `refresh_tokens` are
 * deliberately excluded — they are cross-tenant tables — so **no auth endpoint writes an audit row
 * at all**. Logging in, refreshing, switching tenant and logging out leave no trace in
 * `audit_logs`, on purpose.
 *
 * The first production route that closes this chain will be **Patients CRUD, in Phase 2**. It is
 * out of scope for Phase 1 (PHASE-1.md §2), which is why the write below happens in a controller
 * defined in this file rather than one the application serves. When that route exists, this test
 * has done its job and its assertions belong on the real endpoint.
 *
 * Whether authentication events *should* be audited is a separate question and an open one — see
 * `AuditAction`, which already has values this system does not yet emit.
 */

const CLIENT_IP = "197.51.100.77";
const PROXY_HOP = "10.0.0.1";

/**
 * A controller that exists only in this file. It performs the one thing no Phase 1 route does:
 * a tenant-scoped write, inside the actor bound by the interceptor.
 */
@Controller("test-only")
class TenantScopedWriteController {
  @Post("patient")
  @UseGuards(AuthGuard)
  async createPatient(@Body() body: { tenantId: string; patientId: string }): Promise<{ ok: true }> {
    // actorContext.getOrThrow() is the link under test: it returns whatever the interceptor bound
    // from req.ip. Nothing here reads the request directly.
    const actor = actorContext.getOrThrow();
    await withTenant(body.tenantId, actor, async (tx) => {
      await tx.patient.create({
        data: injected({
          id: body.patientId,
          fullNameAr: "مريض عبر الوسيط",
          phoneE164: `+2018${body.patientId.replace(/-/g, "").slice(0, 8)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
    return { ok: true };
  }
}

@Module({
  controllers: [TenantScopedWriteController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class AuditChainTestModule {}

describe("the audit chain closes over a real HTTP request", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let fixture: ClinicFixture;
  let accessToken: string;

  beforeAll(async () => {
    fixture = await seedClinic();

    // NestFactory, not @nestjs/testing's Test.createTestingModule -- partly to avoid adding a
    // dependency for one file, and partly because this is the same call main.ts makes, so the app
    // under test is assembled the way the real one is.
    app = await NestFactory.create<NestExpressApplication>(AuditChainTestModule, { logger: false });

    // The same setting main.ts applies, and the reason this test exists. One trusted hop: the
    // last proxy. Anything a client appended before that is ignored.
    app.set("trust proxy", 1);

    await app.init();
    await app.listen(0, "127.0.0.1");

    const server = app.getHttpServer() as Server;
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    accessToken = await issueAccessToken({
      sub: fixture.userId,
      membershipId: randomUUID(),
      tenantId: fixture.tenantId,
      role: "DOCTOR",
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(fixture);
  });

  async function postPatient(patientId: string, forwardedFor: string): Promise<number> {
    const response = await fetch(`${baseUrl}/test-only/patient`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ tenantId: fixture.tenantId, patientId }),
    });
    return response.status;
  }

  async function auditIpFor(patientId: string): Promise<string | undefined> {
    // Bound, because audit_logs carries RLS (D17) -- an unbound read returns zero rows.
    const rows = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
      tx.$queryRaw<{ ip_address: string }[]>`
        SELECT ip_address FROM audit_logs WHERE entity_id = ${patientId}::uuid AND action = 'CREATE'
      `,
    );
    return rows[0]?.ip_address;
  }

  test("the forwarded client address reaches audit_logs, not the proxy's", async () => {
    const patientId = randomUUID();
    expect(await postPatient(patientId, CLIENT_IP)).toBe(201);
    expect(await auditIpFor(patientId)).toBe(CLIENT_IP);
  });

  test("a client cannot forge its address by prepending one to the header", async () => {
    // The more important of the two break-proofs on this file, and the reason `trust proxy` takes a
    // hop count rather than `true`.
    //
    // X-Forwarded-For is a client-supplied header. With `trust proxy: true`, Express believes the
    // LEFTMOST entry -- so a caller sending "203.0.113.5, <their real address>" has the address of
    // their choosing written into audit_logs. That table is append-only by trigger (D5): there is
    // no UPDATE and no DELETE, for any role, ever. A forged entry is therefore not a wrong value
    // that can be corrected later; it is a permanently corrupted audit trail, and it is
    // indistinguishable from a true one after the fact.
    //
    // With one trusted hop, the rightmost untrusted entry wins -- the address the trusted proxy
    // actually observed -- and anything the client prepended is discarded. Verified by breaking it:
    // switching this app to `trust proxy: true` makes this test receive 203.0.113.5.
    const patientId = randomUUID();
    expect(await postPatient(patientId, `203.0.113.5, ${CLIENT_IP}`)).toBe(201);
    expect(await auditIpFor(patientId)).toBe(CLIENT_IP);
  });

  test("a second address produces a second row, so the column is not a constant", async () => {
    const patientId = randomUUID();
    expect(await postPatient(patientId, PROXY_HOP)).toBe(201);
    expect(await auditIpFor(patientId)).toBe(PROXY_HOP);
  });

  test("the request is rejected without a valid access token, so the chain requires auth", async () => {
    const response = await fetch(`${baseUrl}/test-only/patient`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
      body: JSON.stringify({ tenantId: fixture.tenantId, patientId: randomUUID() }),
    });
    expect(response.status).toBe(401);
  });
});
