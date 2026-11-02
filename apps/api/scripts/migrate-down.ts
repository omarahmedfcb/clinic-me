// `npm run migrate:down -- <migration_name>` against DATABASE_URL, the migration superuser.
import "dotenv/config";
import path from "node:path";
import { runDownMigration } from "./down-migration.ts";

const migrationsDir = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "prisma", "migrations");
const name = process.argv[2];
const url = process.env["DATABASE_URL"];
if (name === undefined || url === undefined) {
  console.error("usage: npm run migrate:down -- <migration_name>   (DATABASE_URL must be set)");
  process.exit(2);
}
runDownMigration(url, migrationsDir, name).then(
  () => console.log(`${name}: reversed`),
  (error: unknown) => {
    console.error(`${name}: not reversed. ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
