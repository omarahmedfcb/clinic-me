import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { withTenantScoping } from "./tenant-scoping.extension.ts";

/**
 * APP_DATABASE_URL, never DATABASE_URL (CLAUDE.md, SCHEMA-DECISIONS.md D12). DATABASE_URL is the
 * Postgres superuser used by Prisma CLI migrations -- it has BYPASSRLS, so every Row-Level
 * Security policy in prisma/sql/01-constraints.sql becomes a silent no-op if the running
 * application ever connects with it.
 */
const connectionString = process.env["APP_DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "APP_DATABASE_URL is not set. The application must never fall back to DATABASE_URL -- that " +
    "role is a Postgres superuser and bypasses Row-Level Security. See SCHEMA-DECISIONS.md D12.",
  );
}

// Pool options are not optional (SCHEMA-DECISIONS.md D10): the pg driver's default connect
// timeout is 0 (no timeout), so an unreachable database hangs forever instead of failing fast.
const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 5000,
  max: 10,
});

const adapter = new PrismaPg(pool);

export const prisma = withTenantScoping(new PrismaClient({ adapter }));
