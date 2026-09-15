// Unit specs never touch a real database or read a real .env, but jwt.spec.ts needs *some*
// JWT_SECRET to sign/verify against -- this is that value. Never used for anything but signing
// tokens this same process immediately verifies again; it has no relationship to the real
// JWT_SECRET in apps/api/.env.
process.env["JWT_SECRET"] ??= "unit-test-secret-do-not-use-outside-tests";
