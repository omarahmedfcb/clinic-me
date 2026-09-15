import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { prisma } from "./client.ts";

/**
 * Thin NestJS DI wrapper around the singleton client.ts already builds -- deliberately does NOT
 * construct a new PrismaClient. client.ts is the one place APP_DATABASE_URL, the pool options
 * (D10), and the tenant-scoping extension (D6/D7/D12) come together; re-instantiating here would
 * open a second connection pool and, worse, a second extension instance with its own state.
 * Injecting this service just makes that same, already-correct instance available via Nest's DI.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  // DO NOT change this to `export class PrismaService extends PrismaClient`, the pattern in
  // every NestJS/Prisma tutorial. That constructs a second, independent PrismaClient with none
  // of client.ts's setup -- no APP_DATABASE_URL (it would fall back to DATABASE_URL, the
  // migration superuser that bypasses RLS -- D12), and no tenant-scoping extension. It would
  // compile, boot, and silently defeat all three tenant-isolation layers at once.
  readonly client = prisma;

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
