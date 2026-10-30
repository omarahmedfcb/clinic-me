// The branches migration up, down and up again, in a throwaway database this spec creates and drops:
// reversing it under the suite's own clinic_os_test would pull columns from beneath every later spec.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { runDownMigration } from "../../scripts/down-migration.ts";

const NAME = "20261027100000_branches";
// Applied on top of NAME, so it is reversed first, as any later migration must be.
const STAGE_1 = "20261029070000_branches_interim_accepts_named_branch";
const SCOPE = "20261029155000_schedule_exception_scope";
const AUDIT_SCOPE = "20261029163000_audit_scope";
const ORPHAN_READ = "20261029175000_orphaned_audit_read_by_transaction";
const STAGE_5 = "20261029180500_branches_stage5_retire_interim";
// Reversed newest first, as a real rollback must; the branches down then runs as the next one due.
const reverseAboveBranches = async (): Promise<void> => {
  for (const name of [STAGE_5, ORPHAN_READ, AUDIT_SCOPE, SCOPE, STAGE_1]) await runDownMigration(url, MIGRATIONS, name);
};
const reverseToBeforeBranches = async (): Promise<void> => {
  await reverseAboveBranches();
  await runDownMigration(url, MIGRATIONS, NAME);
};
const API_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const DATABASE = "clinic_os_branches_roundtrip";

const serverUrl = process.env["TEST_DATABASE_URL"] ?? "";
const url = (() => {
  const target = new URL(serverUrl);
  target.pathname = `/${DATABASE}`;
  return target.toString();
})();

async function query<T = Record<string, unknown>>(text: string, params: unknown[] = [], on = url): Promise<T[]> {
  const client = new Client({ connectionString: on });
  await client.connect();
  try {
    // Every write here goes through audit triggers, which refuse an unbound actor (D16).
    await client.query("SELECT set_config('app.current_actor_id', system_actor_id()::text, false)").catch(() => undefined);
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** One simple-protocol query: Postgres runs the whole script as one implicit transaction, as Prisma does. */
async function runScript(sql: string): Promise<string> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    return "no error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.end();
  }
}

function deploy(): string {
  try {
    execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
    return "applied";
  } catch (error) {
    const failed = error as { stdout?: Buffer; stderr?: Buffer };
    return `${failed.stdout?.toString() ?? ""}${failed.stderr?.toString() ?? ""}`;
  }
}

const branchesExist = async () => (await query<{ t: string | null }>("SELECT to_regclass('branches')::text AS t"))[0]?.t !== null;
const one = async <T>(text: string, params: unknown[] = []) => (await query<T>(text, params))[0]!;

interface Seeded {
  a: string;
  b: string;
  patientA: string;
  appointmentA: string;
  receiptsA: number[];
}

/** Old-shape data, as clinics hold it today: two clinics, receipts, a charge, a credit, an adjustment. */
async function seedOldShape(): Promise<Seeded> {
  const [a, b, userA, userB, desk] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const ids = { patientA: randomUUID(), patientB: randomUUID(), appointmentA: randomUUID(), visitA: randomUUID(), chargeA: randomUUID() };
  const payment = { a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), b1: randomUUID() };
  const seed = `
    INSERT INTO users (id, phone_e164, password_hash, full_name, status, updated_at) VALUES
      ('${userA}', '+20100${userA.slice(0, 7).replace(/\D/g, "1").padEnd(7, "1")}', 'x', 'Doctor A', 'ACTIVE', now()),
      ('${userB}', '+20101${userB.slice(0, 7).replace(/\D/g, "2").padEnd(7, "2")}', 'x', 'Doctor B', 'ACTIVE', now()),
      ('${desk}', '+20102${desk.slice(0, 7).replace(/\D/g, "3").padEnd(7, "3")}', 'x', 'Desk A', 'ACTIVE', now());
    INSERT INTO tenants (id, name, slug, phone, address, locale, currency, status, settings, updated_at, country) VALUES
      ('${a}', 'Clinic A', 'rt-a-${a}', '+201000000001', 'Cairo', 'ar', 'EGP', 'ACTIVE', '{}', now(), 'EG'),
      ('${b}', 'Clinic B', 'rt-b-${b}', '+201000000002', 'Giza', 'ar', 'EGP', 'ACTIVE', '{}', now(), 'EG');
    INSERT INTO memberships (id, user_id, tenant_id, role, status, updated_at) VALUES
      ('${userA}', '${userA}', '${a}', 'DOCTOR', 'ACTIVE', now()),
      ('${userB}', '${userB}', '${b}', 'DOCTOR', 'ACTIVE', now()),
      ('${desk}', '${desk}', '${a}', 'RECEPTIONIST', 'ACTIVE', now());
    INSERT INTO doctors (id, tenant_id, membership_id, specialty, license_number, title, updated_at) VALUES
      ('${userA}', '${a}', '${userA}', 'General', 'LA', 'Dr.', now()),
      ('${userB}', '${b}', '${userB}', 'General', 'LB', 'Dr.', now());
    INSERT INTO services (id, tenant_id, name_ar, name_en, type, duration_minutes, price_minor, updated_at) VALUES
      ('${a}', '${a}', 'Consult', 'Consult', 'NEW', 30, 10000, now());
    INSERT INTO patients (id, tenant_id, full_name_ar, phone_e164, relationship_to_contact, status, updated_at) VALUES
      ('${ids.patientA}', '${a}', 'Patient A', '+201110000001', 'SELF', 'ACTIVE', now()),
      ('${ids.patientB}', '${b}', 'Patient B', '+201110000002', 'SELF', 'ACTIVE', now());
    INSERT INTO schedule_templates (id, tenant_id, doctor_id, weekday, start_time, end_time, valid_from, updated_at) VALUES
      ('${randomUUID()}', '${a}', '${userA}', 1, '09:00', '13:00', '2026-01-01', now());
    INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, service_id, scheduled_start, scheduled_end, status, source, created_by, updated_by, updated_at) VALUES
      ('${ids.appointmentA}', '${a}', '${ids.patientA}', '${userA}', '${a}', '2026-10-01T07:00Z', '2026-10-01T07:30Z', 'BOOKED', 'RECEPTION', '${userA}', '${userA}', now());
    INSERT INTO visits (id, tenant_id, patient_id, doctor_id, appointment_id, status, created_by, updated_at) VALUES
      ('${ids.visitA}', '${a}', '${ids.patientA}', '${userA}', '${ids.appointmentA}', 'DRAFT', '${userA}', now());
    INSERT INTO visit_charges (id, tenant_id, visit_id, patient_id) VALUES ('${ids.chargeA}', '${a}', '${ids.visitA}', '${ids.patientA}');
    INSERT INTO visit_charge_lines (id, tenant_id, charge_id, name_snapshot, unit_price_minor, source, updated_at) VALUES
      ('${randomUUID()}', '${a}', '${ids.chargeA}', 'Consult', 10000, 'AD_HOC', now());
    INSERT INTO payments (id, tenant_id, patient_id, charge_id, amount_minor, method, status, updated_at) VALUES
      ('${payment.a1}', '${a}', '${ids.patientA}', '${ids.chargeA}', 4000, 'CASH', 'PAID', now());
    INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at) VALUES
      ('${payment.a2}', '${a}', '${ids.patientA}', 3000, 'CASH', 'PAID', now());
    INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at) VALUES
      ('${payment.a3}', '${a}', '${ids.patientA}', 2000, 'CASH', 'PAID', now());
    INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at) VALUES
      ('${payment.b1}', '${b}', '${ids.patientB}', 1000, 'CASH', 'PAID', now());
    INSERT INTO payment_adjustments (id, tenant_id, payment_id, adjustment_type, amount_minor, reason, actor_user_id, previous_status, new_status) VALUES
      ('${randomUUID()}', '${a}', '${payment.a2}', 'CORRECTION', 0, 'round trip', '${userA}', 'PAID', 'PAID');
    INSERT INTO patient_credits (id, tenant_id, patient_id, movement, amount_minor, actor_user_id, source_payment_id) VALUES
      ('${randomUUID()}', '${b}', '${ids.patientB}', 'CREDIT', 500, '${userB}', '${payment.b1}');`;
  await query(seed);
  const receipts = await query<{ receipt_number: number }>(
    "SELECT receipt_number FROM payments WHERE tenant_id = $1 ORDER BY receipt_number",
    [a],
  );
  return { a, b, patientA: ids.patientA, appointmentA: ids.appointmentA, receiptsA: receipts.map((r) => r.receipt_number) };
}

const migration = readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
const breakBefore = (anchor: string, corruption: string): string => {
  const at = migration.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  return `${migration.slice(0, at)}${corruption}\n${migration.slice(at)}`;
};

// The RLS-ownership drill has no role that may create a database; the ci job, migrating as superuser, runs this.
const describeRoundTrip = process.env["TEST_CANNOT_CREATE_DATABASES"] === "1" ? describe.skip : describe;

describeRoundTrip("the branches migration, up, down and up again", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
    await query(`CREATE DATABASE ${DATABASE}`, [], serverUrl);
    expect(deploy()).toBe("applied");
    // Back to the shape every clinic has before this migration, so the backfill has real rows to stamp.
    await reverseToBeforeBranches();
    expect(await branchesExist()).toBe(false);
    seeded = await seedOldShape();
  }, 240_000);

  afterAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
  });

  test("each in-migration assertion refuses a broken backfill, and a refusal leaves nothing behind", async () => {
    const breaks: [string, string, string][] = [
      ["-- Asserted here, before NOT NULL", "UPDATE appointments SET branch_id = NULL;", "rows still have no branch after the backfill"],
      [
        "-- 10. Assertions",
        "INSERT INTO branches (id, tenant_id, name, address, phone, receipt_prefix, invoice_prefix, updated_at) SELECT uuid_generate_v7(), id, 'Extra', 'x', 'x', 'X', 'X', now() FROM tenants LIMIT 1;",
        "clinics do not have exactly one branch",
      ],
      ["-- 10. Assertions", "UPDATE branches SET next_receipt_number = next_receipt_number - 1 WHERE next_receipt_number > 1;", "would not issue the receipt number that comes next"],
      ["-- 10. Assertions", "UPDATE branches SET next_invoice_number = 1;", "would reissue an invoice number"],
    ];
    for (const [anchor, corruption, expected] of breaks) {
      expect(await runScript(breakBefore(anchor, corruption))).toContain(expected);
      expect(await branchesExist()).toBe(false);
    }
  });

  test("a real deploy that fails an assertion rolls back whole, and records itself as failed", async () => {
    // Clinic B owns an append-only credit; in a second currency, one column default cannot be true for both.
    await query("UPDATE tenants SET currency = 'SAR' WHERE id = $1", [seeded.b]);
    expect(deploy()).toContain("append-only money rows belong to clinics in 2 currencies");
    expect(await branchesExist()).toBe(false);
    await query("UPDATE tenants SET currency = 'EGP' WHERE id = $1", [seeded.b]);
    execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "resolve", "--rolled-back", NAME], {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  }, 120_000);

  test("up: every row is stamped with the default branch, and the next receipt is the one that would have come next", async () => {
    const before = await query<{ id: string; next_receipt_number: number }>("SELECT id, next_receipt_number FROM tenants ORDER BY id");
    expect(deploy()).toBe("applied");

    const branches = await query<{ tenant_id: string; id: string; next_receipt_number: number; next_invoice_number: number }>(
      "SELECT tenant_id, id, next_receipt_number, next_invoice_number FROM branches WHERE is_default ORDER BY tenant_id",
    );
    expect(branches.map((b) => [b.tenant_id, b.next_receipt_number])).toEqual(before.map((t) => [t.id, t.next_receipt_number]));
    const branchA = branches.find((b) => b.tenant_id === seeded.a)!;

    const stamped = await one<{ wrong: string }>(
      `SELECT (SELECT count(*) FROM appointments WHERE branch_id <> $1) + (SELECT count(*) FROM visits WHERE branch_id <> $1)
            + (SELECT count(*) FROM visit_charges WHERE branch_id <> $1) + (SELECT count(*) FROM schedule_templates WHERE branch_id <> $1)
            + (SELECT count(*) FROM payments WHERE tenant_id = $2 AND branch_id <> $1) AS wrong`,
      [branchA.id, seeded.a],
    );
    expect(Number(stamped.wrong)).toBe(0);
    expect(await one("SELECT invoice_number FROM visit_charges WHERE tenant_id = $1", [seeded.a])).toEqual({ invoice_number: 1 });
    expect(branchA.next_invoice_number).toBe(2);
    const receipts = await query<{ receipt_number: number }>("SELECT receipt_number FROM payments WHERE tenant_id = $1 ORDER BY receipt_number", [seeded.a]);
    expect(receipts.map((r) => r.receipt_number)).toEqual(seeded.receiptsA);

    const desk = await query("SELECT m.branch_scope, mb.branch_id FROM memberships m JOIN membership_branches mb ON mb.membership_id = m.id WHERE m.role = 'RECEPTIONIST'");
    expect(desk).toEqual([{ branch_scope: "SELECTED", branch_id: branchA.id }]);
    const currencies = await one<{ c: string[] }>(
      `SELECT array_agg(DISTINCT currency) AS c FROM (SELECT currency FROM visit_charges UNION ALL SELECT currency FROM visit_charge_lines
         UNION ALL SELECT currency FROM payments UNION ALL SELECT currency FROM payment_adjustments UNION ALL SELECT currency FROM patient_credits) m`,
    );
    expect(currencies.c).toEqual(["EGP"]);

    const next = await one<{ receipt_number: number }>(
      `INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at, branch_id)
       VALUES ($1, $2, $3, 100, 'CASH', 'PAID', now(), (SELECT id FROM branches WHERE tenant_id = $2 AND is_default)) RETURNING receipt_number`,
      [randomUUID(), seeded.a, seeded.patientA],
    );
    expect(next.receipt_number).toBe(before.find((t) => t.id === seeded.a)!.next_receipt_number);
  }, 120_000);

  test("down refuses while a clinic has a second branch, and once an invoice number has been issued", async () => {
    await reverseAboveBranches();
    const second = randomUUID();
    await query("INSERT INTO branches (id, tenant_id, name, address, phone, receipt_prefix, invoice_prefix, updated_at) VALUES ($1, $2, 'Second', 'Giza', '+201000000009', 'B', 'B', now())", [second, seeded.a]);
    await expect(runDownMigration(url, MIGRATIONS, NAME)).rejects.toThrow("cannot be merged back into one");
    expect(await branchesExist()).toBe(true);
    await query("DELETE FROM branches WHERE id = $1", [second]);

    const visit = randomUUID();
    const charge = randomUUID();
    await query(
      `INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, service_id, scheduled_start, scheduled_end, status, source, created_by, updated_by, updated_at)
         SELECT $1, tenant_id, patient_id, doctor_id, service_id, scheduled_start + interval '1 day', scheduled_end + interval '1 day', 'BOOKED', 'RECEPTION', created_by, updated_by, now()
           FROM appointments WHERE id = $2`,
      [visit, seeded.appointmentA],
    );
    await query(
      "INSERT INTO visits (id, tenant_id, patient_id, doctor_id, appointment_id, status, created_by, updated_at) SELECT $1, tenant_id, patient_id, doctor_id, id, 'DRAFT', created_by, now() FROM appointments WHERE id = $1",
      [visit],
    );
    await query("INSERT INTO visit_charges (id, tenant_id, visit_id, patient_id) SELECT $1, tenant_id, id, patient_id FROM visits WHERE id = $2", [charge, visit]);
    await expect(runDownMigration(url, MIGRATIONS, NAME)).rejects.toThrow("dropping it is data loss, not a rollback");
    expect(await branchesExist()).toBe(true);
    // Only for the test: the charge is removed so the reversal can be exercised on the remaining data.
    await query("DELETE FROM visit_charges WHERE id = $1", [charge]);
  }, 120_000);

  test("down restores the clinic's own counter, and up again continues it", async () => {
    const counter = await one<{ next_receipt_number: number }>("SELECT next_receipt_number FROM branches WHERE tenant_id = $1 AND is_default", [seeded.a]);
    await runDownMigration(url, MIGRATIONS, NAME);
    expect(await branchesExist()).toBe(false);
    expect(await one("SELECT next_receipt_number FROM tenants WHERE id = $1", [seeded.a])).toEqual(counter);

    expect(deploy()).toBe("applied");
    const next = await one<{ receipt_number: number }>(
      `INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at, branch_id)
       VALUES ($1, $2, $3, 100, 'CASH', 'PAID', now(), (SELECT id FROM branches WHERE tenant_id = $2 AND is_default)) RETURNING receipt_number`,
      [randomUUID(), seeded.a, seeded.patientA],
    );
    expect(next.receipt_number).toBe(counter.next_receipt_number);
  }, 240_000);
});
