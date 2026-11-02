// A transaction refused because its support session ended (support access PR 3) answers 401, as the guard's refusal does,
// never 500: the operator's next step is a new session, not a bug report.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { SupportSessionEndedError } from "../prisma/with-tenant.ts";

@Catch(SupportSessionEndedError)
export class SupportSessionEndedFilter implements ExceptionFilter {
  catch(_error: SupportSessionEndedError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(401).json({ statusCode: 401, message: "The support session has ended." });
  }
}
