import { IsNotEmpty, IsString, IsUUID, MaxLength, MinLength, IsBoolean, IsOptional } from "class-validator";

/**
 * Request bodies for the auth endpoints.
 *
 * The global pipe runs with `whitelist: true, forbidNonWhitelisted: true` (main.ts), so a property
 * no DTO declares is a 400 rather than a silently stripped field. That matters most here: a login
 * body carrying `tenantId` or `role` must be refused loudly, not quietly ignored.
 *
 * ## Why `identifier` is a plain string and not `@IsPhoneNumber`
 *
 * The shape of a phone number is decided by `normalisePhone()` with the tenant's country as a hint
 * (CLAUDE.md forbids assuming +20), and it accepts Arabic-Indic digits. A `class-validator` phone
 * rule would reject `٠١٠٠١٢٣٤٥٦٧` before the digit folding ever ran — and it would reject it with a
 * *different response, on a different code path, at a different cost* from a wrong password, which
 * is exactly the distinction login must not expose. Validation here is limited to "a non-empty
 * string of sane length"; everything semantic happens inside the endpoint, folded into one answer.
 */

/** Long enough for any real credential, short enough not to be an attack on the hasher. */
const MAX_FIELD = 200;

export class LoginDto {
  /** Phone number in any notation a human types. Email also works, for staff who have one. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD)
  identifier!: string;

  /**
   * «تذكرني» — keep the session on this device across browser restarts.
   *
   * A request, not a decision: the controller grants it only for a DOCTOR or a RECEPTIONIST, and
   * an ADMIN, an OWNER or an operator sending `true` gets a session cookie anyway.
   */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  /**
   * Argon2id is deliberately slow, so an unbounded password is a cheap way to make the server do
   * expensive work. The cap is far above any real passphrase.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD)
  password!: string;
}

export class SwitchTenantDto {
  /**
   * The membership to switch into. This is a *claim*, not a fact: ownership is verified server-side
   * against the memberships the presented refresh token's user actually holds.
   */
  @IsUUID()
  membershipId!: string;
}

/**
 * Replacing a temporary password. PR 10.
 *
 * The current one is required even though the session is already authenticated: an unattended
 * screen is the ordinary case at a reception desk, and "anyone at this keyboard may set a new
 * password" is a worse property than one extra field.
 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD)
  currentPassword!: string;

  /** Twelve is the length of the temporary password this replaces; shorter would be a downgrade. */
  @IsString()
  @MinLength(12)
  @MaxLength(MAX_FIELD)
  newPassword!: string;
}
