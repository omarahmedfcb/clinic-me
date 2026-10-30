// The running commit is readable by a signed-in operator and by nobody else: never on /health.
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { prisma } from "../../src/prisma/client.ts";
import { createTestUser, deleteTestUser, makeOperator } from "./fixtures.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("the deployed commit", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let operatorId = "";
  let token = "";
  const saved = { commit: process.env["DEPLOYED_COMMIT"], root: process.env["ATTACHMENTS_STORAGE_ROOT"] };

  beforeAll(async () => {
    process.env["DEPLOYED_COMMIT"] = COMMIT;
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= mkdtempSync(join(tmpdir(), "deployed-commit-"));
    operatorId = await createTestUser();
    await makeOperator(operatorId, { platformRole: "SUPPORT" });
    token = await issuePlatformToken(operatorId, "full");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of [["DEPLOYED_COMMIT", saved.commit], ["ATTACHMENTS_STORAGE_ROOT", saved.root]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await deleteTestUser(operatorId);
    await prisma.$disconnect();
  });

  test("a signed-in operator reads it", async () => {
    const response = await fetch(`${baseUrl}/platform/build`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commit: COMMIT });
  });

  test("anyone else is refused", async () => {
    expect((await fetch(`${baseUrl}/platform/build`)).status).toBe(401);
  });

  test("/health stays status and database, and nothing more, while the commit is set", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(await response.json()).toEqual({ status: "ok", database: "reachable" });
  });
});
