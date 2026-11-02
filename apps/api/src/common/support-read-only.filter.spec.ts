// The database's read-only refusal answers 403 SUPPORT_READ_ONLY; every other database error goes on to Nest's default handling.
import type { ArgumentsHost } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { Prisma } from "../generated/prisma/client.ts";
import { SupportReadOnlyFilter } from "./support-read-only.filter.ts";

function host() {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  const value = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  return { value, response };
}

const databaseError = (message: string) => new Prisma.PrismaClientKnownRequestError(message, { code: "P2010", clientVersion: "test" });

describe("SupportReadOnlyFilter", () => {
  afterEach(() => jest.restoreAllMocks());

  test("the database's read-only refusal answers 403 SUPPORT_READ_ONLY", () => {
    const h = host();
    new SupportReadOnlyFilter().catch(databaseError("Database error. Code: `23514`. Message: `support session 1 is read-only: the approving admin has not allowed changes`"), h.value);
    expect(h.response.status).toHaveBeenCalledWith(403);
    expect(h.response.json).toHaveBeenCalledWith({ code: "SUPPORT_READ_ONLY", params: {} });
  });

  test("any other database error is handed on untouched", () => {
    const passed = jest.spyOn(BaseExceptionFilter.prototype, "catch").mockImplementation(() => undefined);
    const h = host();
    const other = databaseError("Database error. Code: `23514`. Message: `support session 1 is not live: no write is allowed under it`");
    new SupportReadOnlyFilter().catch(other, h.value);
    expect(passed).toHaveBeenCalledWith(other, h.value);
    expect(h.response.status).not.toHaveBeenCalled();
  });
});
