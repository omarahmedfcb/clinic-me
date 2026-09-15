import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import { ThrottlerModule } from "@nestjs/throttler";
import { AUTH_THROTTLERS } from "../../src/modules/auth/auth-throttle.ts";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { MembershipFreshnessInterceptor } from "../../src/common/membership-freshness.interceptor.ts";
import { PasswordChangeInterceptor } from "../../src/common/password-change.interceptor.ts";
import { AuthController } from "../../src/modules/auth/auth.controller.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { verifyCredentials } from "../../src/modules/auth/user-lookup.ts";
import { StaffController } from "../../src/modules/memberships/staff.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * «المستخدمون» — Phase 5 PR 10.
 *
 * The two guards the plan names, and they are the two that cannot be seen by reading the screen:
 *
 *   - **a suspended account cannot authenticate, and suspension is not deletion** — the membership
 *     and the user survive, because a staff row is the actor on every audit line they ever wrote;
 *   - **a temporary password is single-use and unreadable afterwards** — no plaintext is stored,
 *     and every route refuses the holder until it is replaced.
 */

/** Set before the module is built: profile photos are written under a directory this run owns. */
let storageRoot = "";

@Module({
  // The throttler comes with `AuthController`: its rate limits are configured next to the routes
  // they protect, so a module that mounts the controller must bring them too.
  imports: [ThrottlerModule.forRoot(AUTH_THROTTLERS)],
  controllers: [StaffController, AuthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: PasswordChangeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MembershipFreshnessInterceptor },
    // A temp directory, never the configured root: a test run must not write into whatever the
    // developer's `ATTACHMENTS_STORAGE_ROOT` points at.
    {
      provide: STORAGE_PROVIDER,
      useFactory: () => new LocalFilesystemStorageProvider(storageRoot),
    },
  ],
})
class StaffTestModule {}

describe("staff accounts", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let adminToken = "";
  let adminMembershipId = "";
  const created: string[] = [];

  const call = async (token: string, method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /**
   * A distinct number per created account, unique **across runs** as well as within one.
   *
   * `users.phone_e164` is unique platform-wide and a user row survives a failed teardown, so a
   * per-run serial collides with the previous run: the second run then finds an existing person,
   * takes the "keeps their own password" branch, and fails for a reason that has nothing to do with
   * what it is testing. That happened, and this is the fix.
   */
  const nextPhone = (): string =>
    `+2010${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;

  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "staff-photos-"));
    clinic = await seedClinic();
    const adminMembership = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const id = randomUUID();
      await tx.membership.create({
        data: { id, tenantId: clinic.tenantId, userId: clinic.userId, role: "ADMIN", status: "ACTIVE" },
      });
      return id;
    });
    adminMembershipId = adminMembership;
    adminToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: adminMembership,
      tenantId: clinic.tenantId,
      role: "ADMIN",
    });

    app = await NestFactory.create<NestExpressApplication>(StaffTestModule, { logger: false });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await rm(storageRoot, { recursive: true, force: true });
    await teardownClinic(clinic);
    for (const userId of created) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  async function createReceptionist(): Promise<{ membershipId: string; userId: string; password: string; phone: string }> {
    const phone = nextPhone();
    const response = await call(adminToken, "POST", "/staff", {
      fullName: "منى سعيد",
      phone,
      role: "RECEPTIONIST",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      member: { membershipId: string; userId: string };
      temporaryPassword: string;
    };
    created.push(body.member.userId);
    return {
      membershipId: body.member.membershipId,
      userId: body.member.userId,
      password: body.temporaryPassword,
      phone,
    };
  }

  test("the list carries what the screen shows, and doctors are listed but not editable here", async () => {
    const response = await call(adminToken, "GET", "/staff");
    expect(response.status).toBe(200);
    const rows = (await response.json()) as {
      fullName: string;
      role: string;
      status: string;
      lastLoginAt: string | null;
      editableHere: boolean;
      doctorId: string | null;
    }[];

    const doctor = rows.find((row) => row.role === "DOCTOR");
    expect(doctor).toBeDefined();
    // Listed so "who has an account here" is a complete answer; linked rather than duplicated, so
    // the Doctors tab stays the one place a doctor's record is edited.
    expect(doctor?.editableHere).toBe(false);
    expect(doctor?.doctorId).not.toBeNull();
  });

  test("creating an account returns a temporary password once, and stores no plaintext", async () => {
    const account = await createReceptionist();
    expect(account.password).toHaveLength(12);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: account.userId },
      select: { passwordHash: true, mustChangePassword: true },
    });
    // **The guard.** Hashed, never stored as typed, and no later request can read it back.
    expect(row.passwordHash).not.toContain(account.password);
    expect(row.passwordHash.startsWith("$argon2")).toBe(true);
    expect(row.mustChangePassword).toBe(true);

    // And the list, which is the only other way to reach this account, does not carry it.
    const listed = await (await call(adminToken, "GET", "/staff")).text();
    expect(listed).not.toContain(account.password);
  });

  test("the temporary password works once, and every route refuses until it is replaced", async () => {
    const account = await createReceptionist();

    // It is a real credential: the account can authenticate with it.
    expect(await verifyCredentials(account.phone, account.password)).not.toBeNull();

    // `memberships` is tenant-scoped, so every read of it goes through the same extension the
    // application uses — the tenant context is not optional for a test either.
    const membership = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findFirstOrThrow({ where: { id: account.membershipId }, select: { id: true } }),
    );
    const token = await issueAccessToken({
      sub: account.userId,
      membershipId: membership.id,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    // **The guard.** Not a screen asking nicely: the server refuses, so `curl` is refused too.
    //
    // Asserted against `/auth/me` rather than `/staff`: a receptionist is entitled to the first
    // and never to the second, so a refusal on `/staff` would be the permission matrix doing its
    // job and would prove nothing about this guard. Both are 403, which is exactly how a test can
    // pass while checking the wrong thing.
    const refused = await call(token, "GET", "/auth/me");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });

    const changed = await call(token, "POST", "/auth/password", {
      currentPassword: account.password,
      newPassword: "a-much-longer-replacement",
    });
    expect(changed.status).toBe(200);

    // Single-use: the temporary password no longer authenticates anything.
    expect(await verifyCredentials(account.phone, account.password)).toBeNull();
    expect(await verifyCredentials(account.phone, "a-much-longer-replacement")).not.toBeNull();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: account.userId },
      select: { mustChangePassword: true },
    });
    expect(after.mustChangePassword).toBe(false);

    // And the route that was refused now answers, so the guard let go rather than the token dying.
    const { accessToken } = (await changed.json()) as { accessToken: string };
    expect((await call(accessToken, "GET", "/auth/me")).status).toBe(200);
  });

  test("a suspended account cannot authenticate, and suspension is not deletion", async () => {
    const account = await createReceptionist();

    const suspended = await call(adminToken, "POST", `/staff/${account.membershipId}/status`, {
      status: "SUSPENDED",
    });
    expect(suspended.status).toBe(201);
    expect(await suspended.json()).toMatchObject({ status: "SUSPENDED" });

    // A suspended membership is not an active one, and login refuses an account with none — the
    // same refusal as a wrong password, because which it was is not a caller's business.
    const memberships = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findMany({ where: { userId: account.userId, status: "ACTIVE" } }),
    );
    expect(memberships).toHaveLength(0);

    // **The other half, and the one a delete would pass.** The rows survive: a staff row is the
    // actor on every audit line that person ever wrote.
    expect(await prisma.user.findUnique({ where: { id: account.userId } })).not.toBeNull();
    const survivor = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findFirst({ where: { id: account.membershipId } }),
    );
    expect(survivor).not.toBeNull();

    const back = await call(adminToken, "POST", `/staff/${account.membershipId}/status`, { status: "ACTIVE" });
    expect(await back.json()).toMatchObject({ status: "ACTIVE" });
  });

  /**
   * **This was never a LAST_ADMIN case, and the code it asserted is unreachable from this route.**
   *
   * The only active administrator in this fixture's tenant is the caller's own membership, so what
   * this has always exercised is a caller suspending themselves. It asserted `LAST_ADMIN` because
   * that was the only refusal that existed; with `SELF_SUSPEND` checked first it reports what is
   * actually happening.
   *
   * `LAST_ADMIN` is kept in the service, but nothing can reach it here: every caller holding
   * `users.manage` is themselves an active OWNER or ADMIN, so the count that excludes the target is
   * never zero. The rule is real all the same — it is the database that enforces it, against the
   * seed, direct SQL, and the role editor — and the trigger tests below are where it is proven.
   */
  test("a caller cannot suspend the membership they are acting through", async () => {
    const admins = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } }),
    );
    const only = admins[0];
    expect(admins).toHaveLength(1);
    if (only === undefined) return;

    const refused = await call(adminToken, "POST", `/staff/${only.id}/status`, { status: "SUSPENDED" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "SELF_SUSPEND" });
  });

  test("one role per clinic: the same person is refused a second membership here", async () => {
    const account = await createReceptionist();
    const again = await call(adminToken, "POST", "/staff", {
      fullName: "منى سعيد",
      phone: account.phone,
      role: "ADMIN",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "ALREADY_A_MEMBER" });
  });

  test("a reset issues a new temporary password and forces the change again", async () => {
    const account = await createReceptionist();
    await call(adminToken, "POST", "/auth/password", {});

    const reset = await call(adminToken, "POST", `/staff/${account.membershipId}/password`, undefined);
    expect(reset.status).toBe(201);
    const { temporaryPassword } = (await reset.json()) as { temporaryPassword: string };
    expect(temporaryPassword).toHaveLength(12);
    expect(temporaryPassword).not.toBe(account.password);

    expect(await verifyCredentials(account.phone, temporaryPassword)).not.toBeNull();
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: account.userId },
      select: { mustChangePassword: true },
    });
    expect(row.mustChangePassword).toBe(true);
  });

  /**
   * «بياناتي» for every role — the founder's ruling of 2026-09-13.
   *
   * The membership comes from the token, so this path cannot name anybody else; that is why it needs
   * no `users.manage`. Role is not a field on the DTO, so it cannot be carried even by accident.
   */
  describe("everyone may edit their own name and phone, and nobody else's", () => {
    /** A receptionist's own token: the role with no authority over other accounts. */
    const receptionToken = async (account: { userId: string; membershipId: string; password: string }) => {
      const token = await issueAccessToken({
        sub: account.userId,
        membershipId: account.membershipId,
        tenantId: clinic.tenantId,
        role: "RECEPTIONIST",
      });
      // A temporary password is outstanding until it is replaced, and every other route refuses.
      await call(token, "POST", "/auth/password", {
        currentPassword: account.password,
        newPassword: `replacement-${randomUUID().slice(0, 12)}`,
      });
      return token;
    };

    test("a receptionist may correct her own name", async () => {
      const account = await createReceptionist();
      const token = await receptionToken(account);

      const saved = await call(token, "PATCH", "/staff/me", { fullName: "شيماء طارق بدوي" });
      expect(saved.status).toBe(200);
      expect((await saved.json()) as { fullName: string }).toMatchObject({ fullName: "شيماء طارق بدوي" });
    });

    test("she cannot reach anybody else's row through this path or the admin one", async () => {
      const account = await createReceptionist();
      const other = await createReceptionist();
      const token = await receptionToken(account);

      // The admin route is hers to be refused: `users.manage` is NONE for RECEPTIONIST.
      expect((await call(token, "PATCH", `/staff/${other.membershipId}`, { fullName: "x" })).status).toBe(403);

      // And the list she would pick a victim from is refused too.
      expect((await call(token, "GET", "/staff")).status).toBe(403);

      // Her own row is the only thing that changed: `other` is untouched.
      const rows = (await (await call(adminToken, "GET", "/staff")).json()) as {
        membershipId: string;
        fullName: string;
      }[];
      expect(rows.find((row) => row.membershipId === other.membershipId)?.fullName).not.toBe("x");
    });

    test("a changed phone is re-validated, and a duplicate is refused", async () => {
      const account = await createReceptionist();
      const other = await createReceptionist();
      const token = await receptionToken(account);

      expect((await call(token, "PATCH", "/staff/me", { phone: "not a number" })).status).toBe(400);

      const clash = await call(token, "PATCH", "/staff/me", { phone: other.phone });
      expect(clash.status).toBe(409);
      expect((await clash.json()) as { code: string }).toMatchObject({ code: "DUPLICATE_PHONE" });
    });

    test("changing her own phone ends her sessions, because the phone is the login", async () => {
      const account = await createReceptionist();
      const token = await receptionToken(account);
      const fresh = nextPhone();

      expect((await call(token, "PATCH", "/staff/me", { phone: fresh })).status).toBe(200);

      const live = await prisma.refreshToken.count({ where: { userId: account.userId, revokedAt: null } });
      expect(live).toBe(0);
    });

    test("role is not a field on this path: sending one is rejected, not ignored", async () => {
      const account = await createReceptionist();
      const token = await receptionToken(account);

      // `forbidNonWhitelisted` — an unknown property is a 400 rather than a silent drop, so a client
      // that tries to promote itself is told no rather than left believing it worked.
      const refused = await call(token, "PATCH", "/staff/me", { role: "ADMIN" });
      expect(refused.status).toBe(400);

      const rows = (await (await call(adminToken, "GET", "/staff")).json()) as {
        membershipId: string;
        role: string;
      }[];
      expect(rows.find((row) => row.membershipId === account.membershipId)?.role).toBe("RECEPTIONIST");
    });
  });

  /**
   * **Changes to a person are audited** — the founder's ruling of 2026-09-13.
   *
   * `users` was excluded from `07-audit-triggers.sql` because it has no `tenant_id`, which was a
   * decision made by the mechanism rather than about the content. A name, a phone number, a photo
   * and a password reset are administrative acts, and the trail is how they are answerable.
   */
  describe("a change to a person leaves a trail", () => {
    // Read inside the tenant: `audit_logs` carries RLS (D17), so a bare read returns nothing at all
    // rather than failing — which is what made this look like a missing trigger the first time.
    const trailFor = async (userId: string) => {
      const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "users", entityId: userId },
          orderBy: { createdAt: "desc" },
          select: { action: true, previousState: true, newState: true, actorUserId: true, createdAt: true },
        }),
      );
      return rows.map((row) => ({
        action: row.action,
        previous: (row.previousState ?? {}) as Record<string, unknown>,
        next: (row.newState ?? {}) as Record<string, unknown>,
        actor: row.actorUserId,
        at: row.createdAt,
      }));
    };

    test("a renamed person has the old and the new spelling, with an actor and a time", async () => {
      const account = await createReceptionist();
      await call(adminToken, "PATCH", `/staff/${account.membershipId}`, { fullName: "شيماء طارق بدوي" });

      const trail = await trailFor(account.userId);
      expect(trail).toHaveLength(1);
      expect(trail[0]?.action).toBe("UPDATE");
      expect(trail[0]?.next["full_name"]).toBe("شيماء طارق بدوي");
      // Both spellings: a corrected name is exactly what an audit trail is read for.
      expect(trail[0]?.previous["full_name"]).not.toBe("شيماء طارق بدوي");
      expect(trail[0]?.actor).toBe(clinic.userId);
      expect(trail[0]?.at).toBeInstanceOf(Date);
    });

    test("a password reset is recorded, and the hash is not", async () => {
      const account = await createReceptionist();
      expect((await call(adminToken, "POST", `/staff/${account.membershipId}/password`, undefined)).status).toBe(201);

      const trail = await trailFor(account.userId);
      expect(trail).toHaveLength(1);
      // That it changed, never the credential: `audit_logs` is readable within a tenant, and an
      // Argon2 hash of a live password is not evidence of anything.
      expect(String(trail[0]?.next["password_hash"])).toBe("(redacted: changed)");
      expect(JSON.stringify(trail[0])).not.toContain("$argon2");
    });

    test("signing in writes no audit row: a login timestamp is not an administrative act", async () => {
      const account = await createReceptionist();
      const login = await call("", "POST", "/auth/login", {
        identifier: account.phone,
        password: account.password,
      });
      expect(login.status).toBe(200);

      // `last_login_at` is stamped before any session exists, so requiring an actor there would make
      // logging in impossible. The trigger exempts that column and writes nothing.
      expect(await trailFor(account.userId)).toEqual([]);
    });
  });

  /**
   * Profile photos — finding 2 of the founder's review of #100.
   *
   * The same `StorageProvider` seam and the same `admitImage` guard the logo uses, so the size
   * limit, the HEIC refusal and the "a PDF is not an image" rule are one implementation rather than
   * two that agree today.
   */
  describe("profile photos", () => {
    /** Real PNG magic bytes: admission is decided by what the bytes are, never by the filename. */
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const PDF = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");

    const upload = async (membershipId: string, token: string, bytes: Buffer): Promise<Response> => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), "photo.png");
      return fetch(`${baseUrl}/staff/${membershipId}/photo`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
    };

    test("a photo is stored, the list says so, and the bytes come back unchanged", async () => {
      const account = await createReceptionist();

      expect((await upload(account.membershipId, adminToken, PNG)).status).toBe(201);

      const rows = (await (await call(adminToken, "GET", "/staff")).json()) as {
        membershipId: string;
        hasPhoto: boolean;
      }[];
      expect(rows.find((row) => row.membershipId === account.membershipId)?.hasPhoto).toBe(true);

      const served = await call(adminToken, "GET", `/staff/${account.membershipId}/photo`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      // Sniffed, not echoed from the upload: a browser must not be invited to guess either.
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    });

    test("a person with no photo is a 404, not a broken image", async () => {
      const account = await createReceptionist();
      const served = await call(adminToken, "GET", `/staff/${account.membershipId}/photo`);
      expect(served.status).toBe(404);
    });

    test("the logo's guard is this guard: a PDF is refused as an unsupported type", async () => {
      const account = await createReceptionist();
      const refused = await upload(account.membershipId, adminToken, PDF);
      expect(refused.status).toBe(415);
      expect((await refused.json()) as { code: string }).toMatchObject({ code: "UNSUPPORTED_TYPE" });
    });

    test("an empty file is refused, and says which problem it is", async () => {
      const account = await createReceptionist();
      const refused = await upload(account.membershipId, adminToken, Buffer.alloc(0));
      expect(refused.status).toBe(400);
      expect((await refused.json()) as { code: string }).toMatchObject({ code: "EMPTY_FILE" });
    });

    test("a doctor's photo goes through the same route: every user has one", async () => {
      // The founder's words — staff *and* doctors. A doctor is not editable in the users list, but
      // their face is not a different kind of thing.
      expect((await upload(clinic.membershipId, adminToken, PNG)).status).toBe(201);
      const served = await call(adminToken, "GET", `/staff/${clinic.membershipId}/photo`);
      expect(served.status).toBe(200);
    });

    test("a membership from another clinic is not found, rather than refused", async () => {
      // 404, never 403 (CLAUDE.md): `users` is not tenant-scoped, so the photo is reached through
      // the membership that proves the person works here. Somebody else's does not.
      const elsewhere = await seedClinic();
      try {
        const served = await call(adminToken, "GET", `/staff/${elsewhere.membershipId}/photo`);
        expect(served.status).toBe(404);
        expect((await upload(elsewhere.membershipId, adminToken, PNG)).status).toBe(404);
      } finally {
        await teardownClinic(elsewhere);
      }
    });
  });

  /**
   * **Capabilities drop on the next request, not at the next login** — the founder's ruling of
   * 2026-09-13, after the demoted owner kept every admin screen while the header said RECEPTIONIST.
   *
   * An access token is self-contained, so nothing about a role change reaches it. The interceptor
   * re-reads the membership on every authenticated request, and the refresh family is revoked so the
   * next refresh cannot mint the old capabilities again.
   */
  describe("a changed role ends the session it was changed under", () => {
    test("the old token's next call is 401, and a new login sees the new role", async () => {
      const account = await createReceptionist();
      const theirToken = await issueAccessToken({
        sub: account.userId,
        membershipId: account.membershipId,
        tenantId: clinic.tenantId,
        role: "RECEPTIONIST",
      });
      // It works before the change: otherwise the 401 below would prove nothing.
      await call(theirToken, "POST", "/auth/password", { currentPassword: account.password, newPassword: "replacement-password-1" });
      expect((await call(theirToken, "GET", "/auth/me")).status).toBe(200);

      expect((await call(adminToken, "PATCH", `/staff/${account.membershipId}`, { role: "ADMIN" })).status).toBe(200);

      // The same token, the very next request.
      expect((await call(theirToken, "GET", "/auth/me")).status).toBe(401);
    });

    test("a suspended membership's token stops working at once, too", async () => {
      const account = await createReceptionist();
      const theirToken = await issueAccessToken({
        sub: account.userId,
        membershipId: account.membershipId,
        tenantId: clinic.tenantId,
        role: "RECEPTIONIST",
      });
      await call(theirToken, "POST", "/auth/password", { currentPassword: account.password, newPassword: "replacement-password-2" });
      expect((await call(theirToken, "GET", "/auth/me")).status).toBe(200);

      expect(
        (await call(adminToken, "POST", `/staff/${account.membershipId}/status`, { status: "SUSPENDED" })).status,
      ).toBe(201);

      expect((await call(theirToken, "GET", "/auth/me")).status).toBe(401);
    });

    test("the refresh family goes with it, so a refresh cannot mint the old role back", async () => {
      const account = await createReceptionist();
      expect((await call(adminToken, "PATCH", `/staff/${account.membershipId}`, { role: "ADMIN" })).status).toBe(200);

      const live = await prisma.refreshToken.count({
        where: { userId: account.userId, revokedAt: null },
      });
      expect(live).toBe(0);
    });
  });

  /**
   * An extra OWNER for the length of one test, then gone.
   *
   * Left standing it would be a second active administrator, and the trigger tests further down turn
   * on this tenant having exactly one — they passed for the wrong reason until this was a helper.
   */
  async function withTemporaryOwner(run: (membershipId: string) => Promise<void>): Promise<void> {
    const userId = await createTestUser();
    created.push(userId);
    const membershipId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.create({
        data: { id: membershipId, tenantId: clinic.tenantId, userId, role: "OWNER", status: "ACTIVE" },
      }),
    );
    try {
      await run(membershipId);
    } finally {
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.membership.deleteMany({ where: { id: membershipId } }),
      );
    }
  }

  /** Editing an account — finding 1 of the founder's review of #100. */
  describe("editing a user's name, phone and role", () => {
    test("the three fields are saved, and the list shows them", async () => {
      const account = await createReceptionist();
      const phone = nextPhone();

      const response = await call(adminToken, "PATCH", `/staff/${account.membershipId}`, {
        fullName: "منى سيد فهمي",
        phone,
        role: "ADMIN",
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as unknown).toMatchObject({
        fullName: "منى سيد فهمي",
        phoneE164: phone,
        role: "ADMIN",
      });

      const rows = (await (await call(adminToken, "GET", "/staff")).json()) as { membershipId: string; fullName: string }[];
      expect(rows.find((row) => row.membershipId === account.membershipId)?.fullName).toBe("منى سيد فهمي");

      // Put the role back. The tests below turn on this tenant having exactly one active
      // administrator, and a promotion left standing here makes them pass for the wrong reason.
      const restored = await call(adminToken, "PATCH", `/staff/${account.membershipId}`, { role: "RECEPTIONIST" });
      expect(restored.status).toBe(200);
    });

    test("a changed phone is re-validated as E.164, not taken on trust", async () => {
      const account = await createReceptionist();
      const response = await call(adminToken, "PATCH", `/staff/${account.membershipId}`, { phone: "not a number" });
      expect(response.status).toBe(400);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "INVALID_PHONE" });
    });

    test("a phone that is already somebody's login is refused with a sentence, not merged", async () => {
      const mine = await createReceptionist();
      const theirs = await createReceptionist();

      const response = await call(adminToken, "PATCH", `/staff/${mine.membershipId}`, { phone: theirs.phone });
      expect(response.status).toBe(409);
      // A sentence, not a silent merge: two people cannot share a login.
      expect((await response.json()) as { code: string }).toMatchObject({ code: "DUPLICATE_PHONE" });

      const unchanged = (await (await call(adminToken, "GET", "/staff")).json()) as {
        membershipId: string;
        phoneE164: string;
      }[];
      expect(unchanged.find((row) => row.membershipId === mine.membershipId)?.phoneE164).toBe(mine.phone);
    });

    test("re-saving a user's own unchanged phone is not a duplicate of themselves", async () => {
      const account = await createReceptionist();
      const response = await call(adminToken, "PATCH", `/staff/${account.membershipId}`, {
        phone: account.phone,
        fullName: "شيماء طارق بدوي",
      });
      expect(response.status).toBe(200);
    });

    test("a doctor is not editable here: the screen is told to go to the Doctors tab", async () => {
      const response = await call(adminToken, "PATCH", `/staff/${clinic.membershipId}`, { fullName: "x" });
      expect(response.status).toBe(422);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "NOT_EDITABLE_HERE" });
    });

    /**
     * **The bug that demoted the owner of the pilot clinic**, 2026-09-13.
     *
     * The edit dialog's role select offered two roles, OWNER was neither, so it opened on
     * RECEPTIONIST — and the save sent the role because it differed from OWNER. `audit_logs` recorded
     * it as `UPDATE by أحمد عبد الرحمن الشناوي — role: OWNER -> RECEPTIONIST`. Nothing refused it:
     * an ADMIN was still active, so the "an administrator must remain" guard was satisfied.
     */
    test("an owner's role cannot be changed from here, at the route", async () => {
      await withTemporaryOwner(async (owner) => {
        const refused = await call(adminToken, "PATCH", `/staff/${owner}`, { role: "RECEPTIONIST" });
        expect(refused.status).toBe(422);
        expect((await refused.json()) as { code: string }).toMatchObject({ code: "OWNER_ROLE_FIXED" });

        const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
          tx.membership.findFirstOrThrow({ where: { id: owner }, select: { role: true } }),
        );
        expect(after.role).toBe("OWNER");
      });
    });

    test("and editing an owner's name still works, carrying no role with it", async () => {
      // The actual action the founder took. It must succeed, and must not touch the role.
      await withTemporaryOwner(async (owner) => {
        const saved = await call(adminToken, "PATCH", `/staff/${owner}`, { fullName: "أحمد عبد الرحمن الشناوي" });
        expect(saved.status).toBe(200);
        expect((await saved.json()) as { role: string }).toMatchObject({ role: "OWNER" });
      });
    });

    /**
     * **`LAST_ADMIN` is unreachable at the route through this door too**, and this is the test that
     * used to claim otherwise.
     *
     * Demoting the last administrator means demoting somebody who is the only active OWNER or ADMIN —
     * and any caller who can reach this route is themselves one, so the only such membership is their
     * own, which `SELF_ROLE_CHANGE` refuses first. The rule is real and the database enforces it; the
     * trigger tests below are where it is proven.
     */
    test("a caller cannot change their own role, which is also the last-administrator case", async () => {
      const refused = await call(adminToken, "PATCH", `/staff/${adminMembershipId}`, { role: "RECEPTIONIST" });
      expect(refused.status).toBe(422);
      expect((await refused.json()) as { code: string }).toMatchObject({ code: "SELF_ROLE_CHANGE" });
    });
  });

  /**
   * Suspension safety, both halves — the founder's ruling of 2026-09-12.
   *
   * The route returns a sentence naming which rule was hit; the database refuses the same writes
   * with no application in the path at all. A route check alone is one `prisma.membership.update`
   * away from being bypassed, and the seed and any future writer never go through the route.
   */
  describe("nobody suspends themselves, and a clinic keeps an administrator", () => {
    /**
     * A second actor, so a write can be attempted by somebody who is not the row's own user.
     *
     * A real user, not a fresh uuid: the audit trigger writes `audit_logs.actor_user_id` with a
     * foreign key to `users`, so an invented actor fails on that instead of on the guard under test.
     */
    let someoneElse = "";

    beforeAll(async () => {
      someoneElse = (await createReceptionist()).userId;
    });

    test("the route refuses a caller suspending their own membership", async () => {
      const response = await call(adminToken, "POST", `/staff/${adminMembershipId}/status`, {
        status: "SUSPENDED",
      });
      expect(response.status).toBe(422);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "SELF_SUSPEND" });
    });

    test("and the membership is still active afterwards", async () => {
      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.membership.findFirstOrThrow({ where: { id: adminMembershipId }, select: { status: true } }),
      );
      // The part a passing refusal could still get wrong.
      expect(row.status).toBe("ACTIVE");
    });

    test("the database refuses changing an owner's role, with no route in the path", async () => {
      await withTemporaryOwner(async (owner) => {
        const raw = withTenant(clinic.tenantId, actorFor(someoneElse), (tx) =>
          tx.membership.update({ where: { id: owner }, data: { role: "RECEPTIONIST" } }),
        );
        await expect(raw).rejects.toThrow(/owner role cannot be changed/i);
      });
    });

    test("the database refuses changing your own role", async () => {
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.membership.update({ where: { id: adminMembershipId }, data: { role: "RECEPTIONIST" } }),
      );
      await expect(raw).rejects.toThrow(/cannot change their own role/i);
    });

    test("the database refuses a self-suspension with no route in the path", async () => {
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.membership.update({ where: { id: adminMembershipId }, data: { status: "SUSPENDED" } }),
      );
      await expect(raw).rejects.toThrow(/cannot suspend their own membership/i);
    });

    /**
     * **Its own clinic, not this file's.**
     *
     * These two turn on the tenant having exactly one active administrator, and three separate
     * rounds of this suite broke because another test left a second one standing — each time passing
     * for the wrong reason first. A fixture that states its own precondition cannot be undermined by
     * whatever ran before it.
     */
    async function inAClinicWithOneAdministrator(
      run: (input: { tenantId: string; adminMembershipId: string; actorUserId: string }) => Promise<void>,
    ): Promise<void> {
      const solo = await seedClinic();
      const adminUserId = await createTestUser();
      created.push(adminUserId);
      const soloAdminId = randomUUID();
      // `seedClinic` gives the tenant a DOCTOR membership, so this is its only administrator — and
      // its own user is somebody other than the actor below, which keeps the self rules out of it.
      await withTenant(solo.tenantId, actorFor(solo.userId), (tx) =>
        tx.membership.create({
          data: { id: soloAdminId, tenantId: solo.tenantId, userId: adminUserId, role: "ADMIN", status: "ACTIVE" },
        }),
      );
      try {
        await run({ tenantId: solo.tenantId, adminMembershipId: soloAdminId, actorUserId: solo.userId });
      } finally {
        await teardownClinic(solo);
      }
    }

    test("the database refuses suspending the clinic's last active administrator", async () => {
      await inAClinicWithOneAdministrator(async ({ tenantId, adminMembershipId: only, actorUserId }) => {
        const raw = withTenant(tenantId, actorFor(actorUserId), (tx) =>
          tx.membership.update({ where: { id: only }, data: { status: "SUSPENDED" } }),
        );
        await expect(raw).rejects.toThrow(/no active administrator/i);
      });
    });

    test("the database refuses demoting the last administrator, which suspension's guard would miss", async () => {
      // The same hole through a different door, and the reason the trigger watches `role` too: a
      // clinic whose last admin becomes a receptionist is in exactly the state suspending them would
      // leave it in.
      await inAClinicWithOneAdministrator(async ({ tenantId, adminMembershipId: only, actorUserId }) => {
        const raw = withTenant(tenantId, actorFor(actorUserId), (tx) =>
          tx.membership.update({ where: { id: only }, data: { role: "RECEPTIONIST" } }),
        );
        await expect(raw).rejects.toThrow(/no active administrator/i);
      });
    });

    test("a clinic with a second administrator may still suspend one of them", async () => {
      // The guard has to permit the ordinary case, or it is just a broken screen.
      const spare = await createReceptionist();
      await withTenant(clinic.tenantId, actorFor(someoneElse), (tx) =>
        tx.membership.update({ where: { id: spare.membershipId }, data: { role: "ADMIN" } }),
      );

      const response = await call(adminToken, "POST", `/staff/${spare.membershipId}/status`, {
        status: "SUSPENDED",
      });
      expect(response.status).toBe(201);
      expect((await response.json()) as { status: string }).toMatchObject({ status: "SUSPENDED" });
    });
  });
});
