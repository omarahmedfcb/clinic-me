// Whether clinic_os_test holds migrations the current branch does not. Pure: no database import,
// so the unit project can hold the guard that proves it.

export interface DriftReport {
  /** Applied in the database, absent from the tree. The direction `migrate deploy` cannot repair. */
  ahead: string[];
  /** In the tree, not yet applied. Normal — `migrate deploy` is about to apply them. */
  pending: string[];
}

/**
 * Compares what the database has applied with what the branch carries.
 *
 * `prisma migrate deploy` only moves forward, so a database that has already applied a migration
 * the checked-out tree does not contain cannot be repaired by running it again — the schema keeps
 * a column the branch's code knows nothing about. That happened twice on 2026-09-16 while moving
 * between #113 and develop: `tenants.country` stayed NOT NULL, and twelve specs failed with a null
 * constraint violation that looked like a code defect and was not.
 */
export function compareMigrations(applied: readonly string[], onDisk: readonly string[]): DriftReport {
  const tree = new Set(onDisk);
  const database = new Set(applied);

  return {
    ahead: applied.filter((name) => !tree.has(name)).sort(),
    pending: onDisk.filter((name) => !database.has(name)).sort(),
  };
}

/** The sentence the suite dies with. One line the reader can act on, not a diagnosis to interpret. */
export function driftMessage(databaseName: string, ahead: readonly string[]): string {
  return (
    `${databaseName} has ${ahead.length} migration(s) this branch does not contain: ${ahead.join(", ")}. ` +
    "`prisma migrate deploy` only moves forward, so it cannot undo them and the schema no longer " +
    "matches this branch. Recreate the database:\n" +
    `  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres ` +
    `-c 'DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);' -c 'CREATE DATABASE ${databaseName};'`
  );
}
