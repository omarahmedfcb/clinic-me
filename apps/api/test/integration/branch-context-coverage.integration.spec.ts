import { randomUUID } from "node:crypto";
import { RequestMethod, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { APP_INTERCEPTOR, ModulesContainer, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { defer, firstValueFrom, of } from "rxjs";
import { AppModule } from "../../src/app.module.ts";
import { AuthGuard } from "../../src/common/auth.guard.ts";
import { branchContext, NO_MEMBERSHIP } from "../../src/common/branch-context.ts";
import { BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { BranchScopeInterceptor } from "../../src/common/branch-scope.interceptor.ts";
import { mintSlotToken } from "../../src/modules/appointments/slot-token.ts";
import { executeWebchatTool } from "../../src/modules/webchat/webchat-tools.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

type Constructor = abstract new (...args: never[]) => unknown;
const asList = (value: unknown): string[] => (Array.isArray(value) ? value : [value ?? ""]).map(String);

function servedRoutes(app: NestExpressApplication): { key: string; guards: unknown[] }[] {
  const routes: { key: string; guards: unknown[] }[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Constructor | null;
      if (controller === null) continue;
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? [];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
        for (const base of asList(Reflect.getMetadata(PATH_METADATA, controller))) {
          for (const sub of asList(Reflect.getMetadata(PATH_METADATA, handler))) {
            const path = `/${[base, sub].filter((p) => p !== "" && p !== "/").join("/")}`.replace(/\/+/g, "/");
            routes.push({ key: `${RequestMethod[method]} ${path}`, guards: [...classGuards, ...methodGuards] });
          }
        }
      }
    }
  }
  return routes;
}

describe("every HTTP route resolves a branch context", () => {
  let app: NestExpressApplication;
  let routes: { key: string; guards: unknown[] }[] = [];

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await app.init();
    routes = servedRoutes(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  test("the routes Nest serves are exactly the ones BRANCH_ENFORCEMENT classifies", () => {
    expect(routes.map((r) => r.key).sort()).toEqual(Object.keys(BRANCH_ENFORCEMENT).sort());
  });

  test("every route acting for a clinic member authenticates one, so the interceptor resolves its scope", () => {
    const unresolved = routes
      .filter((r) => BRANCH_ENFORCEMENT[r.key] !== "no-clinic" && !r.guards.includes(AuthGuard))
      .map((r) => r.key);
    expect(unresolved).toEqual([]);
  });

  test("the interceptor is global, so no route is outside it", () => {
    const providers = (Reflect.getMetadata("providers", AppModule) as { provide?: unknown; useClass?: unknown }[]) ?? [];
    expect(providers.some((p) => p.provide === APP_INTERCEPTOR && p.useClass === BranchScopeInterceptor)).toBe(true);
  });

  test("a request with no clinic membership runs under an empty scope, so branch checks refuse", async () => {
    const http = { getRequest: () => ({ headers: {} }) };
    const context = { switchToHttp: () => http } as unknown as ExecutionContext;
    const seen = defer(() => of({ bound: branchContext.tryGet(), allows: branchContext.allows(randomUUID()) }));
    const observable = await new BranchScopeInterceptor().intercept(context, { handle: () => seen });
    expect(await firstValueFrom(observable)).toEqual({ bound: NO_MEMBERSHIP, allows: false });
  });
});

describe("the public webchat acts under its bot membership's scope, not the request's", () => {
  let clinic: ClinicFixture;
  let botUserId = "";
  let botMembershipId = "";

  beforeAll(async () => {
    clinic = await seedClinic();
    botUserId = await createTestUser();
    botMembershipId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.create({ data: injected({ id: botMembershipId, userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }) }),
    );
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await deleteTestUser(botUserId);
  });

  test("booking through webchat succeeds inside a request that has no membership of its own", async () => {
    const start = Date.parse("2031-03-05T08:00:00Z");
    const slotToken = mintSlotToken(
      { tenantId: clinic.tenantId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, branchId: clinic.branchId, startMs: start, endMs: start + 30 * 60_000 },
      new Date(),
    );
    const session = {
      id: randomUUID(),
      updatedAt: Date.now(),
      slots: { tenantId: clinic.tenantId, botMembershipId, botUserId, patientId: clinic.patientId, tenantTimezone: "Africa/Cairo" },
    };
    const result = await branchContext.run(NO_MEMBERSHIP, () =>
      executeWebchatTool(session, "book_appointment", JSON.stringify({ slotToken })),
    );
    expect(result).toMatchObject({ ok: true });
  });
});
