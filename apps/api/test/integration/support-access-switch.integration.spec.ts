// Support access PR 1 (docs/SUPPORT-ACCESS.md): BUILT, NOT ENABLED. The database refuses the flag without a current contract
// carrying the data-processor clause; off is always allowed; a clinic session can never turn it on (it cannot see contracts).
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("the support access switch (support access PR 1)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let operatorId = "";
  let token = "";

  const flag = (enabled: boolean) =>
    fetch(`${baseUrl}/platform/clinics/${clinic.tenantId}/support-access`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled, reason: "signed agreement on file" }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  const enabled = async () => (await withPlatformActor(actorFor(operatorId), (tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { supportAccessEnabled: true } }))).supportAccessEnabled;
  const contract = (startsOn: string, endsOn: string, dataProcessorClause: boolean) =>
    withPlatformActor(actorFor(operatorId), (tx) => tx.platformClinicContract.create({ data: { id: uuidv7(), tenantId: clinic.tenantId, fileName: "c.pdf", storageKey: `test/${uuidv7()}`,
      mimeType: "application/pdf", sizeBytes: 10, startsOn: new Date(`${startsOn}T00:00:00Z`), endsOn: new Date(`${endsOn}T00:00:00Z`), dataProcessorClause, uploadedByUserId: operatorId } }));

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= mkdtempSync(join(tmpdir(), "support-switch-"));
    clinic = await seedClinic();
    operatorId = await createTestUser();
    await makeOperator(operatorId);
    token = await issuePlatformToken(operatorId, "full");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await deleteTestUser(operatorId);
  });

  test("off by default, and refused with no contract, a contract without the clause, or an expired one with it", async () => {
    expect(await enabled()).toBe(false);
    expect((await flag(true)).body).toMatchObject({ code: "DATA_PROCESSOR_CLAUSE_REQUIRED" });
    await contract(day(-30), day(335), false);
    expect((await flag(true)).body).toMatchObject({ code: "DATA_PROCESSOR_CLAUSE_REQUIRED" });
    await contract(day(-400), day(-1), true);
    expect((await flag(true)).body).toMatchObject({ code: "DATA_PROCESSOR_CLAUSE_REQUIRED" });
    expect(await enabled()).toBe(false);
  });

  test("a clinic session can never turn it on, even with a valid contract on file: it cannot see the contracts", async () => {
    await contract(day(-1), day(364), true);
    const tried = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { supportAccessEnabled: true } }))
      .then(() => "no error", (e: Error) => e.message);
    expect(tried).toContain("data-processor clause");
    expect(await enabled()).toBe(false);
  });

  test("a contract uploaded with the clause lets the operator turn it on, recorded in the clinic's trail; off is always allowed", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(PDF)], { type: "application/pdf" }), "agreement.pdf");
    form.append("startsOn", day(-1));
    form.append("endsOn", day(364));
    form.append("dataProcessorClause", "true");
    const uploaded = await fetch(`${baseUrl}/platform/clinics/${clinic.tenantId}/contracts`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    expect((await withPlatformActor(actorFor(operatorId), (tx) => tx.platformClinicContract.findUniqueOrThrow({ where: { id }, select: { dataProcessorClause: true } }))).dataProcessorClause).toBe(true);

    expect(await flag(true)).toEqual({ status: 200, body: { enabled: true } });
    expect((await flag(true)).body).toMatchObject({ code: "ALREADY_IN_THAT_STATE" });
    const trail = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) => tx.auditLog.count({ where: { entityType: "tenants", actorUserId: operatorId, action: "UPDATE" } }));
    expect(trail).toBeGreaterThan(0);
    expect(await flag(false)).toEqual({ status: 200, body: { enabled: false } });
    expect(await enabled()).toBe(false);
  });
});
