import { SetMetadata } from "@nestjs/common";

/**
 * **A forced password change is enforced, not asked for.**
 *
 * PR 10 lets an admin issue a temporary password. "Forced change at next login" is a sentence a
 * screen can honour and a caller with `curl` cannot, so the refusal lives in `AuthGuard`: while
 * `users.must_change_password` is set, every authenticated route refuses except the one that clears
 * it.
 *
 * **Why not a global guard.** That was the first attempt and it could never have worked: Nest runs
 * global guards *before* route-level ones, so it ran before `AuthGuard` had put any claims on the
 * request, read `undefined`, and allowed everything through. It passed every test that asked
 * whether a refused route refused — because the routes it was pointed at were refused by the
 * permission matrix instead, and both answers are 403.
 */
export const ALLOWED_WHILE_PASSWORD_EXPIRED = "allowedWhilePasswordExpired";

/** The one route that may run while a temporary password is outstanding: the one that replaces it. */
export const AllowsPasswordChange = () => SetMetadata(ALLOWED_WHILE_PASSWORD_EXPIRED, true);
