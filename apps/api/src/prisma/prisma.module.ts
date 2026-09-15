import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.ts";

/**
 * @Global(): every feature module needs database access, and requiring PrismaModule in the
 * imports array of every single one would be pure repetition with no isolation benefit -- there
 * is only ever one PrismaService in this process.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
