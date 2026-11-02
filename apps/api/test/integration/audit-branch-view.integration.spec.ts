// The audit viewer decides per event, on the whole transaction (§4.6): shown if any entry is in the read set or unscoped
// (BEFORE_BRANCHES shares UNSCOPED's clause), then shown whole; filter options come only from events the reader sees.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { branchContext, type BranchContext } from "../../src/common/branch-context.ts";
import { ALL_BRANCHES } from "../../src/common/branch-scope.ts";
import { auditFilterOptions, listAuditLog } from "../../src/modules/audit/audit.service.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

const ownerUrl = (): string => process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "";

describe("the audit viewer's branch filter, per event (step 5f)", () => {
  let clinic: ClinicFixture;
  let actorId = "";
  let branchA = "";
  let branchB = "";
  let suspended = "";
  const suspendedAt = new Date(Date.UTC(2026, 5, 15));
  const at = (day: number): Date => new Date(Date.UTC(2026, 5, day, 9));
  const EVENTS: Record<string, { day: number; entries: (string | null)[] }> = {};

  const view = async (context: Partial<BranchContext>): Promise<number[]> => {
    const full: BranchContext = { allowed: [branchA, branchB], selected: ALL_BRANCHES, isMultiBranch: true, branches: [], readSuspended: [], ...context };
    const page = await branchContext.run(full, () => listAuditLog({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) }, { actorUserId: actorId, limit: 200 }));
    expect(page.total).toBe(page.events.length);
    return page.events.map((event) => new Date(event.at).getUTCDate()).sort((x, y) => x - y);
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    actorId = await createTestUser();
    branchA = clinic.branchId;
    branchB = randomUUID();
    suspended = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      for (const [id, p] of [[branchB, "B"], [suspended, "S"]] as const) {
        await tx.branch.create({ data: injected({ id, name: p, address: "Giza", phone: "+201000000001", receiptPrefix: p, invoicePrefix: p }) });
      }
    });
    Object.assign(EVENTS, {
      onlyA: { day: 1, entries: [branchA, branchA] },
      onlyB: { day: 2, entries: [branchB] },
      bAndUnscoped: { day: 3, entries: [branchB, null] },
      aAndB: { day: 4, entries: [branchA, branchB] },
      unscoped: { day: 5, entries: [null] },
      suspendedBefore: { day: 10, entries: [suspended] },
      suspendedAfter: { day: 20, entries: [suspended] },
    });
    const client = new Client({ connectionString: ownerUrl() });
    await client.connect();
    try {
      for (const { day, entries } of Object.values(EVENTS)) {
        for (const branch of entries) {
          await client.query(
            `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, branch_id, scope, created_at)
             VALUES ($1, $2, $3, 'ADMIN', 'UPDATE', 'patients', $4, 'x', 'x', $5, $6, $7)`,
            [randomUUID(), clinic.tenantId, actorId, randomUUID(), branch, branch === null ? "UNSCOPED" : "ONE_BRANCH", at(day)],
          );
        }
      }
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await deleteTestUser(actorId);
  });

  test("branch A's view: its own events, the unscoped ones, and a mixed event that touches A", async () => {
    expect(await view({ allowed: [branchA, branchB], selected: branchA, named: true })).toEqual([1, 3, 4, 5]);
  });

  test("branch B's view: its own, the event mixing B with an unscoped entry, and the A-and-B event", async () => {
    expect(await view({ allowed: [branchA, branchB], selected: branchB, named: true })).toEqual([2, 3, 4, 5]);
  });

  test("a caller scoped to A with no branch named reads A and the unscoped events only", async () => {
    expect(await view({ allowed: [branchA], selected: ALL_BRANCHES })).toEqual([1, 3, 4, 5]);
  });

  test("every branch held, with a suspended one: its events before the suspension stay, after it they do not", async () => {
    expect(await view({ readSuspended: [{ id: suspended, suspendedAt }] })).toEqual([1, 2, 3, 4, 5, 10]);
  });

  test("an event that qualifies shows whole, every entry in it", async () => {
    const full: BranchContext = { allowed: [branchA, branchB], selected: branchB, isMultiBranch: true, branches: [], named: true };
    const page = await branchContext.run(full, () => listAuditLog({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) }, { actorUserId: actorId, limit: 200 }));
    const mixed = page.events.find((event) => new Date(event.at).getUTCDate() === EVENTS["aAndB"]!.day)!;
    expect(mixed.entryCount).toBe(2);
    expect(mixed.entries).toHaveLength(2);
  });
});

describe("the whole transaction decides, and the filter options follow it (ruled 2026-10-31)", () => {
  let clinic: ClinicFixture;
  let branchB = "";
  const actors = { inBoth: "", onlyInA: "" };
  const day = new Date(Date.UTC(2026, 6, 1, 9));
  const onlyA = new Date(Date.UTC(2026, 6, 2, 9));
  const asB = <T>(work: () => Promise<T>): Promise<T> =>
    branchContext.run({ allowed: [branchB], selected: ALL_BRANCHES, isMultiBranch: true, branches: [], readSuspended: [] }, work);
  const caller = () => ({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) });

  beforeAll(async () => {
    clinic = await seedClinic();
    branchB = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.branch.create({ data: injected({ id: branchB, name: "B", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }) }));
    actors.inBoth = await createTestUser();
    actors.onlyInA = await createTestUser();
    const rows: [string, string, string, Date][] = [
      [actors.inBoth, "visits", branchB, day],
      [actors.inBoth, "patients", clinic.branchId, day],
      [actors.onlyInA, "a_only_records", clinic.branchId, onlyA],
    ];
    const client = new Client({ connectionString: ownerUrl() });
    await client.connect();
    try {
      for (const [actor, entityType, branch, at] of rows) {
        await client.query(
          `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, branch_id, scope, created_at)
           VALUES ($1, $2, $3, 'ADMIN', 'UPDATE', $4, $5, 'x', 'x', $6, 'ONE_BRANCH', $7)`,
          [randomUUID(), clinic.tenantId, actor, entityType, randomUUID(), branch, at],
        );
      }
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    for (const id of Object.values(actors)) await deleteTestUser(id);
  });

  test("a record-type filter never hides an event that happened in the reader's branch", async () => {
    const page = await asB(() => listAuditLog(caller(), { actorUserId: actors.inBoth, entityType: "patients", limit: 200 }));
    expect(page.events.map((event) => event.entries.map((entry) => entry.entityType))).toEqual([["patients"]]);
  });

  test("the filter options list only actors and record types from events this reader can see", async () => {
    const options = await asB(() => auditFilterOptions(caller()));
    const ids = options.actors.map((actor) => actor.userId);
    expect(ids).toContain(actors.inBoth);
    expect(ids).not.toContain(actors.onlyInA);
    expect(options.entityTypes).not.toContain("a_only_records");
    const everything = await auditFilterOptions(caller());
    expect(everything.actors.map((actor) => actor.userId)).toContain(actors.onlyInA);
    expect(everything.entityTypes).toContain("a_only_records");
  });
});
