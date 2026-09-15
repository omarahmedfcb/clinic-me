/**
 * The re-seed recipe, in one place, so it cannot drift from `docs/SETUP.md`.
 *
 * ## Why this is its own module
 *
 * Two reasons, and both are standing rules rather than preferences.
 *
 * **It is pure.** `prisma/seed/index.ts` imports the Prisma client, which reads
 * `APP_DATABASE_URL` at module scope — so a unit spec that imported the seed to check this string
 * would acquire a hidden dependency on a running database, pass locally where `dotenv` loads
 * `apps/api/.env`, and fail to even load on CI. `CLAUDE.md` calls that an import-graph bug rather
 * than a missing environment variable, and the fix it names is exactly this one: split the pure
 * part out, as `prisma/seed/generate.ts` was split from `seed-clinical.ts`.
 *
 * **It is the only copy.** The recipe used to be written twice — once in the module docblock of
 * `index.ts` and once in the string it prints — which is two chances to be wrong and one guarantee
 * that they eventually disagree. `seed-reseed-instructions.spec.ts` asserts there is still only
 * one, so a second copy fails the build rather than rotting quietly.
 *
 * ## Why the ALTER ROLE step is in here
 *
 * Because without it the recipe does not work, and it was printed without it until 2026-09-07.
 *
 * `docker compose down -v` discards the volume, and the `20260821194449_app_role` migration
 * recreates `clinic_os_app` **with no password** — deliberately, since migration files are
 * committed and a password in one would be a secret in source control (`SCHEMA-DECISIONS.md`
 * D12/D13). The only code in the repository that ever sets that password is
 * `test/integration/globalSetup.ts`, and it sets it for `clinic_os_test`, not `clinic_os_dev`.
 *
 * So a reader who followed the printed instructions reached `npm run seed` and got
 * `AuthenticationFailed` — a failure with no obvious connection to the command that caused it,
 * three steps earlier. `docs/SETUP.md` §6 documents the missing command and calls it "the sharpest
 * edge in the whole setup"; the seed's own recovery message simply did not carry it.
 */

/**
 * The command that sets the app role's password, character-identical to the one in
 * `docs/SETUP.md` §6.
 *
 * Kept as its own constant so the guard can assert the two are the same string rather than merely
 * that both mention `ALTER ROLE`. The placeholders are SETUP.md's — the seed cannot know these
 * secrets, and inventing plausible-looking values would be worse than a placeholder a reader has
 * to substitute, because a wrong password fails in exactly the same way as a missing one.
 */
export const ALTER_APP_ROLE_PASSWORD = `docker compose exec -e PGPASSWORD='<secret 1>' postgres \\
  psql -U clinic_os -d clinic_os_dev -v ON_ERROR_STOP=1 \\
  -c "ALTER ROLE clinic_os_app WITH PASSWORD '<secret 2>';"`;

/**
 * What to run to genuinely start over, printed when the seed finds data already present.
 *
 * Ordered as it must actually be executed: the role password is set after the migrations, because
 * `20260821194449_app_role` is what creates the role, and before the seed, because the seed is the
 * first thing that connects as it.
 */
export const RESEED_INSTRUCTIONS = `    docker compose down -v && docker compose up -d
    cd apps/api && npx prisma migrate deploy && cd ..

    # A fresh volume leaves clinic_os_app with no password, so the seed cannot connect.
    # This is docs/SETUP.md section 6 -- run it from the repository root:
${ALTER_APP_ROLE_PASSWORD.split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}

    cd apps/api && npm run seed`;
