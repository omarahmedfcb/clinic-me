// A DTO rejection that names the field, added 2026-09-15 after a mistyped short name reached the
// operator as "a system error occurred". Additive: `message` stays, so no existing screen changes.

import { BadRequestException, ValidationPipe } from "@nestjs/common";
import type { ValidationError } from "class-validator";
import { FIELD_NAMES, type FieldName } from "./refusals.ts";

/** The first field the validator complained about, or null if it named none the registry knows. */
export function firstInvalidField(errors: readonly ValidationError[]): FieldName | null {
  for (const error of errors) {
    if ((FIELD_NAMES as readonly string[]).includes(error.property)) return error.property as FieldName;
    const nested = firstInvalidField(error.children ?? []);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * The application's one `ValidationPipe`.
 *
 * Nest's default rejection is `{ message: [...], error: "Bad Request", statusCode: 400 }` — English
 * prose and no `code`. The platform console maps a body with no `code` to `INTERNAL` and renders its
 * generic apology, so "the short name may not contain a space" arrived as "a system error occurred.
 * Nothing was changed. Tell your system administrator": the server blamed for a typing mistake, with
 * nothing for the operator to correct.
 *
 * **`code` and `params` are added; `message` is kept.** Three screens built before the refusal-code
 * ruling still read `body.message` for validation failures (`doctors-api.ts`, `patients-api.ts`,
 * `schedules-api.ts`), and dropping it would have turned their error text into `undefined` — a
 * second silent regression while fixing the first. Those screens can migrate to the code later; this
 * change does not force it.
 *
 * A field the registry does not list falls back to a bare `INVALID_FIELD`, whose sentence says a
 * field was rejected without naming one. Still a refusal somebody can act on, and never the
 * system-error apology.
 */
export const refusingValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // Without this, every numeric or boolean field arriving as a string from a query parameter
    // needs its own @Type decorator, and the one that is forgotten fails at the database instead.
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors: ValidationError[]) => {
      const field = firstInvalidField(errors);
      return new BadRequestException({
        code: "INVALID_FIELD",
        params: field === null ? {} : { field },
        message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
        error: "Bad Request",
        statusCode: 400,
      });
    },
  });
