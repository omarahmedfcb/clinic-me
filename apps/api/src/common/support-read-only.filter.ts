// A write the database refused because its support session is read-only (support access PR 5a) answers 403 SUPPORT_READ_ONLY,
// as the request check does, never 500; every other database error goes on to Nest's default handling unchanged.
import { ArgumentsHost, Catch } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { Response } from "express";
import { Prisma } from "../generated/prisma/client.ts";
import { refusal } from "./refusals.ts";

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class SupportReadOnlyFilter extends BaseExceptionFilter {
  override catch(error: Error, host: ArgumentsHost): void {
    if (!error.message.includes("support_session_read_only") && !error.message.includes("the approving admin has not allowed changes")) {
      super.catch(error, host);
      return;
    }
    host.switchToHttp().getResponse<Response>().status(403).json(refusal("SUPPORT_READ_ONLY", {}));
  }
}
