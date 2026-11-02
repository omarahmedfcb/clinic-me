// Runs a migration's down.sql in one transaction. Prisma has no down migrations; the few that have one
// carry it beside migration.sql, and it deletes its own _prisma_migrations row so deploy re-applies it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export async function runDownMigration(
  connectionString: string,
  migrationsDir: string,
  migrationName: string,
): Promise<void> {
  const file = path.join(migrationsDir, migrationName, "down.sql");
  if (!existsSync(file)) throw new Error(`${migrationName} has no down.sql`);
  const database = new URL(connectionString).pathname.replace(/^\//, "");
  if (database === "clinic_os_review") {
    throw new Error("Refusing to reverse a migration on clinic_os_review: the review database is a deliverable.");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(file, "utf8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
