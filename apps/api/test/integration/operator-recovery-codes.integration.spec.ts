import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { PlatformOperatorsController } from "../../src/modules/platform/platform-operators.controller.ts";
import { PlatformController } from "../../src/modules/platform/platform.controller.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { totpCode } from "../../src/modules/platform/totp.ts";
import { prisma } from "../../src/prisma/client.ts";
import {
  createTestUser,
  deleteTestUser,
  makeOperator,
  readPlatformAuditRows,
  FIXTURE_TOTP_SECRET,
} from "./fixtures.ts";

/**
 * Recovery codes — the operator's lost-phone path.
 *
 * Every guard here is asserted in the failing direction, because each one is the difference between
 * a bypass that is used once and a bypass that is a standing credential.
 */

const OPERATOR_PASSWORD = "operator-only-not-a-real-password";

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 1_000 }])],
  controllers: [PlatformController, PlatformOperatorsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class RecoveryModule {}

describe("operator recovery codes", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const cleanup: Array<() => Promise<void>> = [];

  let ownerId = "";
  let ownerToken = "";
  let supportId = "";
  let supportToken = "";

  const call = async (
    method: "POST" | "GET",
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  };

  /** A live authenticator code for the fixture secret, at this instant. */
  const liveCode = (): string => totpCode(FIXTURE_TOTP_SECRET, Math.floor(Date.now() / 1000)) ?? "";

  /** Enrols a fresh operator and returns their first set of codes. */
  async function enrolOperator(): Promise<{ userId: string; codes: string[]; token: string }> {
    const userId = await createTestUser();
    cleanup.push(() => deleteTestUser(userId));
    await makeOperator(userId, {
      platformRole: "SUPPORT",
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });

    const token = await issuePlatformToken(userId, "full");
    const regenerated = await call("POST", "/platform/recovery-codes/regenerate", token, {
      password: OPERATOR_PASSWORD,
      totpCode: liveCode(),
    });
    expect(regenerated.status).toBe(200);
    return { userId, codes: regenerated.body["recoveryCodes"] as string[], token };
  }

  beforeAll(async () => {
    ownerId = await createTestUser();
    cleanup.push(() => deleteTestUser(ownerId));
    await makeOperator(ownerId, {
      platformRole: "OWNER",
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    ownerToken = await issuePlatformToken(ownerId, "full");

    supportId = await createTestUser();
    cleanup.push(() => deleteTestUser(supportId));
    await makeOperator(supportId, {
      platformRole: "SUPPORT",
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    supportToken = await issuePlatformToken(supportId, "full");

    app = await NestFactory.create<NestExpressApplication>(RecoveryModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    app.set("trust proxy", 1);
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    for (const undo of cleanup.reverse()) await undo();
  }, 120_000);

  describe("issuing", () => {
    test("a full set is issued, and the plaintext is never readable again", async () => {
      const { userId, codes } = await enrolOperator();

      expect(codes).toHaveLength(8);
      expect(new Set(codes).size).toBe(8);
      for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$/);

      // Stored hashed, never as typed: the row must not contain the code.
      const stored = await prisma.operatorRecoveryCode.findMany({ where: { userId }, select: { codeHash: true } });
      expect(stored).toHaveLength(8);
      for (const row of stored) {
        expect(row.codeHash.startsWith("$argon2id$")).toBe(true);
        expect(codes).not.toContain(row.codeHash);
      }
    }, 120_000);
  });

  describe("consuming", () => {
    test("a code works once and NEVER a second time", async () => {
      const { userId, codes } = await enrolOperator();
      const pending = await issuePlatformToken(userId, "pending");
      const code = codes[0]!;

      const first = await call("POST", "/platform/totp/recovery", pending, { recoveryCode: code });
      expect(first.status).toBe(200);
      expect(typeof first.body["accessToken"]).toBe("string");
      expect(first.body["recoveryCodesRemaining"]).toBe(7);

      // The guard. Single-use means the row is gone, so the same code is now simply wrong.
      const second = await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
        recoveryCode: code,
      });
      expect(second.status).toBe(401);
      expect(await prisma.operatorRecoveryCode.count({ where: { userId } })).toBe(7);
    }, 120_000);

    test("a recovery sign-in writes OPERATOR_RECOVERY_CODE_USED, not a plain LOGIN", async () => {
      const { userId, codes } = await enrolOperator();
      const pending = await issuePlatformToken(userId, "pending");

      expect((await call("POST", "/platform/totp/recovery", pending, { recoveryCode: codes[1]! })).status).toBe(200);

      const rows = await readPlatformAuditRows("actor_user_id = $1 AND action = 'OPERATOR_RECOVERY_CODE_USED'", [userId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["entity_id"]).toBe(userId);
      // The operator has no clinic, and the row must not claim one.
      expect(rows[0]?.["tenant_id"]).toBeNull();
      expect(rows[0]?.["actor_role"]).toBe("PLATFORM_ADMIN");

      // Not a LOGIN wearing a detail field: the action column is what an incident review filters on.
      const asLogin = await readPlatformAuditRows("actor_user_id = $1 AND action = 'LOGIN'", [userId]);
      expect(asLogin).toHaveLength(0);
    }, 120_000);

    test("wrong, malformed and already-spent codes are one answer", async () => {
      const { userId, codes } = await enrolOperator();
      const spent = codes[0]!;
      expect(
        (await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
          recoveryCode: spent,
        })).status,
      ).toBe(200);

      for (const attempt of [spent, "ZZZZZZZZZZ", "nope", ""]) {
        const refused = await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
          recoveryCode: attempt,
        });
        // 401 for a real refusal, 400 only for a DTO rejection on the empty string.
        expect([400, 401]).toContain(refused.status);
        if (refused.status === 401) expect(refused.body["message"]).toBe("Invalid credentials.");
      }
    }, 120_000);
  });

  describe("regenerating", () => {
    test("the OLD set stops working the moment a new one is issued", async () => {
      const { userId, codes, token } = await enrolOperator();
      const old = codes[3]!;

      const again = await call("POST", "/platform/recovery-codes/regenerate", token, {
        password: OPERATOR_PASSWORD,
        totpCode: liveCode(),
      });
      expect(again.status).toBe(200);
      const fresh = again.body["recoveryCodes"] as string[];
      expect(fresh).toHaveLength(8);
      expect(fresh).not.toContain(old);

      // The guard: a code from the revoked set must be as dead as one already spent.
      const refused = await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
        recoveryCode: old,
      });
      expect(refused.status).toBe(401);
      expect(await prisma.operatorRecoveryCode.count({ where: { userId } })).toBe(8);
    }, 120_000);

    test("refuses without the password, and without a live authenticator code", async () => {
      const { token } = await enrolOperator();

      expect(
        (await call("POST", "/platform/recovery-codes/regenerate", token, {
          password: "not-the-password",
          totpCode: liveCode(),
        })).status,
      ).toBe(401);

      expect(
        (await call("POST", "/platform/recovery-codes/regenerate", token, {
          password: OPERATOR_PASSWORD,
          totpCode: "000000",
        })).status,
      ).toBe(401);
    }, 120_000);
  });

  describe("the OWNER-only reset", () => {
    test("a non-OWNER is refused, and nothing is cleared", async () => {
      const victim = await enrolOperator();

      const refused = await call("POST", `/platform/operators/${victim.userId}/totp/reset`, supportToken, {
        reason: "trying it on",
      });
      expect(refused.status).toBe(422);
      expect(await prisma.operatorRecoveryCode.count({ where: { userId: victim.userId } })).toBe(8);
    }, 120_000);

    test("an OWNER clears the authenticator AND the codes, with the reason on the audit row", async () => {
      const victim = await enrolOperator();

      const reset = await call("POST", `/platform/operators/${victim.userId}/totp/reset`, ownerToken, {
        reason: "lost the phone at the clinic",
      });
      expect(reset.status).toBe(200);

      // Both halves: leaving the codes would revoke the factor and keep the eight that bypass it.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: victim.userId },
        select: { totpSecret: true, totpConfirmedAt: true },
      });
      expect(user.totpSecret).toBeNull();
      expect(user.totpConfirmedAt).toBeNull();
      expect(await prisma.operatorRecoveryCode.count({ where: { userId: victim.userId } })).toBe(0);

      const audit = await readPlatformAuditRows(
        "actor_user_id = $1 AND action = 'BREAK_GLASS_ACCESS' AND entity_id = $2",
        [ownerId, victim.userId],
      );
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit.at(-1)?.["new_state"])).toContain("lost the phone at the clinic");
    }, 120_000);

    test("a reset with no reason is refused by the DTO", async () => {
      const victim = await enrolOperator();
      const refused = await call("POST", `/platform/operators/${victim.userId}/totp/reset`, ownerToken, {});
      expect(refused.status).toBe(400);
      expect(await prisma.operatorRecoveryCode.count({ where: { userId: victim.userId } })).toBe(8);
    }, 120_000);
  });

  describe("replacing the lost authenticator", () => {
    /** Signs in with a code and returns the `via: "recovery"` session it opens. */
    async function recoverySession(): Promise<{ userId: string; token: string; codes: string[] }> {
      const { userId, codes } = await enrolOperator();
      const opened = await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
        recoveryCode: codes[0]!,
      });
      expect(opened.status).toBe(200);
      return { userId, token: opened.body["accessToken"] as string, codes };
    }

    test("a NORMAL session cannot reach it — the guard, in the failing direction", async () => {
      // An operator who still holds their authenticator wants `recovery-codes/regenerate`, which
      // demands that authenticator and leaves the secret alone.
      const { token } = await enrolOperator();
      const refused = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      expect(refused.status).toBe(403);
      expect(refused.body["code"]).toBe("NOT_RECOVERY_SESSION");

      const alsoRefused = await call("POST", "/platform/totp/replace/confirm", token, { totpCode: liveCode() });
      expect(alsoRefused.status).toBe(403);
    }, 120_000);

    test("a recovery session replaces the secret and reissues every code, atomically", async () => {
      const { userId, token, codes } = await recoverySession();

      const begun = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      expect(begun.status).toBe(200);
      const newSecret = begun.body["secretBase32"] as string;
      expect(newSecret).not.toBe(FIXTURE_TOTP_SECRET);

      // Nothing has changed yet: an abandoned replacement must leave the operator able to sign in.
      const midway = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecret: true },
      });
      expect(midway.totpSecret).toBe(FIXTURE_TOTP_SECRET);

      const confirmed = await call("POST", "/platform/totp/replace/confirm", token, {
        totpCode: totpCode(newSecret, Math.floor(Date.now() / 1000)) ?? "",
      });
      expect(confirmed.status).toBe(200);

      const fresh = confirmed.body["recoveryCodes"] as string[];
      expect(fresh).toHaveLength(8);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecret: true, totpPendingSecret: true },
      });
      expect(after.totpSecret).toBe(newSecret);
      expect(after.totpSecret).not.toBe(FIXTURE_TOTP_SECRET);
      expect(after.totpPendingSecret).toBeNull();
    }, 120_000);

    test("after replacement the OLD authenticator and EVERY old code are dead", async () => {
      const { userId, token, codes } = await recoverySession();

      const begun = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      const newSecret = begun.body["secretBase32"] as string;
      await call("POST", "/platform/totp/replace/confirm", token, {
        totpCode: totpCode(newSecret, Math.floor(Date.now() / 1000)) ?? "",
      });

      // The old authenticator no longer answers.
      const oldFactor = await call("POST", "/platform/totp/verify", await issuePlatformToken(userId, "pending"), {
        totpCode: totpCode(FIXTURE_TOTP_SECRET, Math.floor(Date.now() / 1000)) ?? "",
      });
      expect(oldFactor.status).toBe(401);

      // And every code from the old file — the lost device very likely held that too.
      for (const old of codes.slice(1)) {
        const refused = await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
          recoveryCode: old,
        });
        expect(refused.status).toBe(401);
      }
      expect(await prisma.operatorRecoveryCode.count({ where: { userId } })).toBe(8);
    }, 240_000);

    test("the replacement writes its own audit row on the operator, with no tenant", async () => {
      const { userId, token } = await recoverySession();
      const begun = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      await call("POST", "/platform/totp/replace/confirm", token, {
        totpCode: totpCode(begun.body["secretBase32"] as string, Math.floor(Date.now() / 1000)) ?? "",
      });

      // Its own action, not an UPDATE wearing a detail: a second-factor change on the console has
      // to be findable by filtering the column.
      const rows = await readPlatformAuditRows("actor_user_id = $1 AND action = 'OPERATOR_TOTP_REPLACED'", [
        userId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["entity_id"]).toBe(userId);
      expect(rows[0]?.["tenant_id"]).toBeNull();
      expect(JSON.stringify(rows[0]?.["new_state"])).toContain("authenticator replaced");

      // Not filed under a generic action, which is the thing that makes it unfindable later. The
      // `users_audit` trigger writes its own UPDATE rows for the column change and that is correct;
      // what must not happen is the replacement being recorded ONLY as one of those.
      const generic = await readPlatformAuditRows("actor_user_id = $1 AND action = 'UPDATE'", [userId]);
      expect(generic.every((row) => !JSON.stringify(row["new_state"]).includes("authenticator replaced"))).toBe(
        true,
      );
    }, 120_000);

    test("the trigger never records the authenticator secret itself", async () => {
      // Found on 2026-09-16 in the JSON of a passing test: `audit_user_change()` redacted
      // `password_hash` and nothing else, so every update to an operator wrote the shared secret of
      // their second factor into a table built to be read.
      const { userId, token } = await recoverySession();
      const begun = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      const newSecret = begun.body["secretBase32"] as string;
      await call("POST", "/platform/totp/replace/confirm", token, {
        totpCode: totpCode(newSecret, Math.floor(Date.now() / 1000)) ?? "",
      });

      const rows = await readPlatformAuditRows("actor_user_id = $1", [userId]);
      expect(rows.length).toBeGreaterThan(0);
      const everything = JSON.stringify(rows);
      expect(everything).not.toContain(newSecret);
      expect(everything).not.toContain(FIXTURE_TOTP_SECRET);
      // The fact of the change is still recorded — redacted, not omitted.
      expect(everything).toContain("(redacted: set)");
    }, 120_000);

    test("the session stops being a recovery session once the replacement is proved", async () => {
      const { token } = await recoverySession();
      const begun = await call("POST", "/platform/totp/replace", token, { password: OPERATOR_PASSWORD });
      const confirmed = await call("POST", "/platform/totp/replace/confirm", token, {
        totpCode: totpCode(begun.body["secretBase32"] as string, Math.floor(Date.now() / 1000)) ?? "",
      });

      // The new token has no `via`, so it can no longer reach the replacement route.
      const withNewToken = await call("POST", "/platform/totp/replace", confirmed.body["accessToken"] as string, {
        password: OPERATOR_PASSWORD,
      });
      expect(withNewToken.status).toBe(403);
    }, 120_000);
  });

  describe("the banner's number", () => {
    test("/platform/me carries how many are left", async () => {
      const { userId, token, codes } = await enrolOperator();
      expect((await call("GET", "/platform/me", token)).body["recoveryCodesRemaining"]).toBe(8);

      await call("POST", "/platform/totp/recovery", await issuePlatformToken(userId, "pending"), {
        recoveryCode: codes[0]!,
      });
      expect((await call("GET", "/platform/me", token)).body["recoveryCodesRemaining"]).toBe(7);
    }, 120_000);
  });
});
