import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service.ts";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: "ok"; database: "reachable" }> {
    // A real query, not just a response, so this route proves two things at once: the HTTP
    // layer is wired up, and Nest's DI actually injected PrismaService -- exactly the
    // decorator-metadata reflection this scaffold exists to confirm still works under TS7's
    // compiled CJS output.
    await this.prisma.client.$queryRaw`SELECT 1`;
    return { status: "ok", database: "reachable" };
  }
}
