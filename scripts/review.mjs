// The only build the founder reviews: pull-check, install, migrate, seed, build, serve, print URL.
// Targets clinic_os_review, never the dev database, and refuses on a dirty tree or a stale develop.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "./wait-for-health.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = path.join(ROOT, "apps", "api");
const WEB = path.join(ROOT, "apps", "web");
const MARKETING = path.join(ROOT, "apps", "marketing");

const REVIEW_DB = "clinic_os_review";
const PORT_API = 3100;
const PORT_WEB = 4173;
// The marketing site's own `npm run preview` port, so both URLs are the ones its README names.
const PORT_MARKETING = 4180;
// Where the sandbox's webhook receiver listens, and how often the outbox is swept for it. A minute
// is right for cron on a server and wrong for somebody watching a conversation.
const PORT_WEBHOOK_ECHO = 5183;
const WEBHOOK_INTERVAL_MS = 5000;

/**
 * `allowFailure` returns the output instead of throwing.
 *
 * For the two commands whose failure is a fact to read rather than a fault: deleting a branch that
 * may not exist, and a merge that may conflict — which this script has to inspect and explain
 * rather than die on with a stack trace.
 */
const run = (cmd, args, opts = {}) => {
  const { allowFailure = false, ...rest } = opts;
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...rest }).trim();
  } catch (error) {
    if (!allowFailure) throw error;
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  }
};
const step = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

function refuse(what, detail) {
  console.error(`\n  REFUSED: ${what}\n\n${detail}\n`);
  process.exit(1);
}

/**
 * `--pr <n>` reviews that pull request's head instead of develop. Same gates, minus the two that
 * are about develop being current — a PR head is not expected to be, and often must not be.
 *
 * **Repeatable.** Two independent pull requests, each opened from develop, are two branches the
 * founder would otherwise have to build and look at one after the other — and the second build
 * overwrites the first, so comparing them means rebuilding. Given more than one, this builds a
 * throwaway merge of all of them onto develop and serves that, which is the only way one URL can
 * show both. A conflict is refused loudly rather than resolved: a review build that silently picked
 * a side would be showing code nobody wrote.
 */
const prNumbers = process.argv.flatMap((argument, index) =>
  argument === "--pr" ? [process.argv[index + 1]] : [],
);
if (prNumbers.some((value) => value === undefined || !/^\d+$/.test(value))) {
  refuse(
    "--pr needs a pull request number",
    "For example: npm run preview -- --pr 72, or --pr 100 --pr 101 to see two at once.",
  );
}
const prNumber = prNumbers.length === 1 ? prNumbers[0] : null;
const prCombination = prNumbers.length > 1 ? prNumbers : null;

// `--reseed` drops the review database so the seed runs again. Without it the script seeds only an
// empty database, which is how a build of today's code was once reviewed against last week's data:
// PR 7i stopped seeding a dual membership and the review database went on holding one.
const reseed = process.argv.includes("--reseed");

// --- gates -------------------------------------------------------------------------------------
// Checked before the checkout, not after: `gh pr checkout` on a dirty tree can carry uncommitted
// work onto another branch, which is a worse outcome than the refusal.
const dirty = run("git", ["status", "--porcelain"], { cwd: ROOT });
if (dirty !== "") {
  refuse(
    "the working tree is dirty",
    `A review build must correspond to a commit, or feedback cannot be traced to code anyone\n` +
      `else can check out. Uncommitted:\n\n${dirty}\n\nCommit or stash, then run this again.`,
  );
}

step("git", ["fetch", "origin", "--quiet"], { cwd: ROOT });

if (prCombination !== null) {
  // A throwaway branch off origin/develop with each pull request merged into it. Deleted and
  // remade on every run, never pushed: it exists for the length of one review and is not a place
  // anybody should commit to.
  const combined = `review/combined-${prCombination.join("-")}`;
  console.log(`\n  Building pull requests ${prCombination.map((n) => `#${n}`).join(" + ")} together.\n`);

  step("git", ["checkout", "--quiet", "develop"], { cwd: ROOT });
  run("git", ["branch", "-D", combined], { cwd: ROOT, allowFailure: true });
  step("git", ["checkout", "--quiet", "-b", combined, "origin/develop"], { cwd: ROOT });

  for (const number of prCombination) {
    const head = run("gh", ["pr", "view", number, "--json", "headRefName", "--jq", ".headRefName"], {
      cwd: ROOT,
      shell: true,
    });
    if (head === "") refuse(`could not read the head branch of #${number}`, "Is the number right?");
    step("git", ["fetch", "origin", "--quiet", head], { cwd: ROOT });
    const merged = run("git", ["merge", "--no-edit", "FETCH_HEAD"], { cwd: ROOT, allowFailure: true });
    const conflicted = run("git", ["ls-files", "--unmerged"], { cwd: ROOT });
    if (conflicted !== "") {
      run("git", ["merge", "--abort"], { cwd: ROOT, allowFailure: true });
      refuse(
        `#${number} conflicts with the other pull request(s)`,
        `They cannot be reviewed in one build until that is resolved. Build them one at a time:\n` +
          `npm run preview -- --pr ${number}\n\n${merged}`,
      );
    }
  }
} else if (prNumber !== null) {
  console.log(`\n  Checking out pull request #${prNumber}.\n`);
  step("gh", ["pr", "checkout", prNumber], { cwd: ROOT, shell: true });
} else {
  const branch = run("git", ["branch", "--show-current"], { cwd: ROOT });
  if (branch !== "develop") {
    refuse(
      `on branch '${branch}', not develop`,
      "This command reviews develop. `git checkout develop`, or pass --pr <n> to review a\npull request's head.",
    );
  }

  const behind = run("git", ["rev-list", "--count", "HEAD..origin/develop"], { cwd: ROOT });
  if (behind !== "0") {
    refuse(
      `develop is ${behind} commit(s) behind origin`,
      "This is the stale-build trap the command exists to prevent. `git pull`, then run this again.",
    );
  }
}

// --- connection strings ------------------------------------------------------------------------
const envFile = path.join(API, ".env");
if (!existsSync(envFile)) refuse("apps/api/.env is missing", "See docs/SETUP.md §3.");
const env = readFileSync(envFile, "utf8");

const read = (key) => new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m").exec(env)?.[1];

const superUrl = read("DATABASE_URL");
const appUrl = read("APP_DATABASE_URL");
if (superUrl === undefined || appUrl === undefined) {
  refuse("DATABASE_URL or APP_DATABASE_URL is not set in apps/api/.env", "See docs/SETUP.md §3.");
}

// Swap only the database name, so the review stack reuses the same host, roles and passwords.
const toReview = (url) => url.replace(/\/[^/?]+(\?|$)/, `/${REVIEW_DB}$1`);
const reviewSuper = toReview(superUrl);
const reviewApp = toReview(appUrl);
const adminUrl = superUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");

console.log(`\n  develop is current. Review target: ${REVIEW_DB}\n`);

// --- install -----------------------------------------------------------------------------------
step("npm", ["ci"], { cwd: API, shell: true });
step("npm", ["ci"], { cwd: WEB, shell: true });

// Decided after any checkout, because `--pr` may bring the marketing app in or leave it out.
const hasMarketing = existsSync(path.join(MARKETING, "package.json"));
if (hasMarketing) step("npm", ["ci"], { cwd: MARKETING, shell: true });

// --- the review database -----------------------------------------------------------------------
// Created if absent. Nothing else in the project migrates it, which is how it was once found two
// migrations behind -- every transfers screen would have failed at the database, looking like a UI bug.
const pgEval = (script, ...args) =>
  run(process.execPath, ["-e", script, ...args], { cwd: API });

const exists = pgEval(
  `const {Client}=require("pg");const c=new Client({connectionString:process.argv[1]});` +
    `c.connect().then(()=>c.query("select 1 from pg_database where datname=$1",[process.argv[2]]))` +
    `.then(r=>{process.stdout.write(r.rowCount?"yes":"no");return c.end()})` +
    `.catch(e=>{process.stdout.write("ERR:"+e.message);process.exit(0)})`,
  adminUrl,
  REVIEW_DB,
);
if (exists.startsWith("ERR:")) refuse("could not reach Postgres", exists.slice(4));

if (reseed && exists === "yes") {
  console.log(`  --reseed: dropping ${REVIEW_DB}.\n`);
  // Existing sessions are terminated first: a previous review stack holds connections, and
  // PostgreSQL refuses to drop a database anything is still attached to.
  pgEval(
    `const {Client}=require("pg");const c=new Client({connectionString:process.argv[1]});` +
      `c.connect()` +
      `.then(()=>c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",[process.argv[2]]))` +
      `.then(()=>c.query('DROP DATABASE IF EXISTS "'+process.argv[2]+'"'))` +
      `.then(()=>c.end())`,
    adminUrl,
    REVIEW_DB,
  );
}

if (reseed || exists === "no") {
  console.log(`  Creating ${REVIEW_DB}.\n`);
  pgEval(
    `const {Client}=require("pg");const c=new Client({connectionString:process.argv[1]});` +
      `c.connect().then(()=>c.query('CREATE DATABASE "'+process.argv[2]+'"')).then(()=>c.end())`,
    adminUrl,
    REVIEW_DB,
  );
}

step("npx", ["prisma", "migrate", "deploy"], {
  cwd: API,
  shell: true,
  env: { ...process.env, DATABASE_URL: reviewSuper },
});
step("npm", ["run", "prisma:generate"], { cwd: API, shell: true });

// --- seed if empty -----------------------------------------------------------------------------
const tenants = pgEval(
  `const {Client}=require("pg");const c=new Client({connectionString:process.argv[1]});` +
    `c.connect().then(()=>c.query("select count(*)::int n from tenants"))` +
    `.then(r=>{process.stdout.write(String(r.rows[0].n));return c.end()})` +
    `.catch(e=>{process.stdout.write("ERR:"+e.message);process.exit(0)})`,
  reviewApp,
);
if (tenants.startsWith("ERR:")) {
  refuse(
    `could not reach ${REVIEW_DB} as clinic_os_app`,
    `${tenants.slice(4)}\n\nOn a database whose volume was recreated the app role has no password.\n` +
      "docs/SETUP.md §6 has the ALTER ROLE command.",
  );
}
if (Number(tenants) === 0) {
  console.log("\n  Review database is empty. Seeding.\n");
  // **R3, and it is a review convenience rather than a product rule.** The seed is deterministic
  // from a reference instant it is given (CLAUDE.md), and the pinned default puts "today's"
  // appointments on a day in the past — which is correct for a fixture and useless for a review
  // build, where the founder opens the queue expecting to see today. The build day is passed in
  // explicitly here; nothing in the seed reads the clock.
  const today = new Date().toISOString().slice(0, 10);
  console.log(`  R3: seeding today's appointments on ${today} (seed-only).\n`);
  step("npm", ["run", "seed"], {
    cwd: API,
    shell: true,
    env: {
      ...process.env,
      DATABASE_URL: reviewSuper,
      APP_DATABASE_URL: reviewApp,
      SEED_REFERENCE_DATE: today,
    },
  });
} else {
  console.log(`\n  Review database holds ${tenants} tenant(s). Not seeding.\n`);
}

// --- build -------------------------------------------------------------------------------------
const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
const builtAt = new Date().toISOString();
// Read after any checkout, so --pr reports the branch actually built rather than the one started on.
const builtBranch = run("git", ["branch", "--show-current"], { cwd: ROOT });
// Which pull requests this build is of, named in the banner so feedback can be traced to one.
const prLabel =
  prCombination !== null
    ? `   (pull requests ${prCombination.map((n) => `#${n}`).join(" + ")})`
    : prNumber === null
      ? ""
      : `   (pull request #${prNumber})`;

step("npm", ["run", "build"], { cwd: API, shell: true });
step("npm", ["run", "build"], {
  cwd: WEB,
  shell: true,
  env: {
    ...process.env,
    VITE_BUILD_COMMIT: commit,
    VITE_BUILD_TIME: builtAt,
    VITE_BUILD_BRANCH: builtBranch,
  },
});
if (hasMarketing) step("npm", ["run", "build"], { cwd: MARKETING, shell: true });

// --- serve -------------------------------------------------------------------------------------
// Outside the repository, per CLAUDE.md: a storage root inside it gets committed by a later `git add -A`.
const attachments = path.resolve(ROOT, "..", "clinic-os-review-attachments");
if (!existsSync(attachments)) mkdirSync(attachments, { recursive: true });

// -r dotenv/config because dist/main.js does not load .env itself. The explicit env wins over it,
// since dotenv never overwrites a variable already set.
const api = spawn(process.execPath, ["-r", "dotenv/config", path.join(API, "dist", "main.js")], {
  cwd: API,
  stdio: "inherit",
  env: {
    ...process.env,
    APP_DATABASE_URL: reviewApp,
    DATABASE_URL: reviewSuper,
    PORT: String(PORT_API),
    ATTACHMENTS_STORAGE_ROOT: attachments,
    // The sandbox is a review-build fact, and the API refuses to boot with it under production.
    BOT_SANDBOX: "on",
    /*
     * The operator's second factor is off in a review build — 2026-09-15.
     *
     * A reviewer has no authenticator loaded with the seeded operator's secret, so the code prompt
     * cannot be satisfied and the console is unreachable. `assertOperatorTotpAllowed` refuses to
     * boot with this set when `NODE_ENV=production`, so it is a review convenience that physically
     * cannot follow a build to a server.
     *
     * `OPERATOR_TOTP=on npm run preview -- --reseed` turns it on without editing this file: the seed
     * enrols no authenticator, so the first operator sign-in lands on enrolment, then recovery codes.
     */
    OPERATOR_TOTP: process.env["OPERATOR_TOTP"] ?? "off",
  },
});

const web = spawn("npx", ["vite", "preview", "--port", String(PORT_WEB), "--strictPort"], {
  cwd: WEB,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VITE_API_TARGET: `http://localhost:${PORT_API}` },
});

// A separate app with no API client, so it needs nothing from the stack above and is started beside it.
const marketing = hasMarketing
  ? spawn("npx", ["vite", "preview", "--port", String(PORT_MARKETING), "--strictPort"], {
      cwd: MARKETING,
      stdio: "inherit",
      shell: true,
    })
  : null;

/**
 * The bot sandbox: a credential for the first seeded clinic, a receiver that logs and verifies each
 * delivery, and a sweep often enough to watch. `BOT_SANDBOX=on` is what turns all three on, and the
 * API and both scripts refuse it under `NODE_ENV=production` — so this cannot follow a build to a
 * server.
 */
const sandboxEnv = { ...process.env, DATABASE_URL: reviewSuper, APP_DATABASE_URL: reviewApp, BOT_SANDBOX: "on" };
let sandbox = null;
try {
  sandbox = JSON.parse(
    run(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/sandbox-bot.ts"], {
      cwd: API,
      env: { ...sandboxEnv, SANDBOX_WEBHOOK_URL: `http://localhost:${PORT_WEBHOOK_ECHO}/webhook` },
    }),
  );
} catch (error) {
  // A review build without a bot is still a review build: the founder reviews screens here, and the
  // sandbox is for the external developer. Say so and carry on rather than refusing the whole stack.
  console.log(`\n  No bot sandbox this run: ${String(error.message ?? error).split("\n")[0]}\n`);
}

const webhookEcho =
  sandbox === null
    ? null
    : spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/webhook-echo.ts"], {
        cwd: API,
        stdio: "inherit",
        env: {
          ...sandboxEnv,
          SANDBOX_WEBHOOK_PORT: String(PORT_WEBHOOK_ECHO),
          SANDBOX_WEBHOOK_SECRET: sandbox.webhookSecret,
        },
      });

const webhookDispatch =
  sandbox === null
    ? null
    : spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/webhook-dispatch.ts"], {
        cwd: API,
        stdio: "inherit",
        env: { ...sandboxEnv, WEBHOOK_DISPATCH_INTERVAL_MS: String(WEBHOOK_INTERVAL_MS) },
      });

const shutdown = () => {
  api.kill();
  web.kill();
  marketing?.kill();
  webhookEcho?.kill();
  webhookDispatch?.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Waited for, never assumed. This was a fixed 2.5s timer until 2026-09-09, and a cold API takes
// longer, so READY printed over a stack that answered every request with a connection refused.
const unhealthy = await waitForHealth({
  url: `http://localhost:${PORT_API}/health`,
  isAlive: () => api.exitCode === null && api.signalCode === null,
});
if (unhealthy !== null) {
  api.kill();
  web.kill();
  marketing?.kill();
  webhookEcho?.kill();
  webhookDispatch?.kill();
  refuse(
    "the API never became healthy",
    `${unhealthy}\n\nThe web build is fine; nothing behind it is answering. The API's own output is\n` +
      "above this line -- a failed migration or a bad APP_DATABASE_URL is the usual cause.",
  );
}

// Waited for too, and for the same reason as the API: READY must not print over a site not answering.
if (marketing !== null) {
  const deadline = Date.now() + 60_000;
  let answered = false;
  while (!answered && Date.now() < deadline && marketing.exitCode === null) {
    answered = await fetch(`http://localhost:${PORT_MARKETING}`).then((r) => r.ok, () => false);
    if (!answered) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!answered) {
    api.kill();
    web.kill();
    marketing.kill();
    refuse(
      `the marketing site never answered on :${PORT_MARKETING}`,
      "Its own output is above this line. Another process holding the port is the usual cause.",
    );
  }
}

{
  const rule = "─".repeat(72);
  const marketingLine = marketing === null ? "" : `      http://localhost:${PORT_MARKETING}   (marketing site)\n`;
  // Printed once, because there is no second chance: the secrets are hashed at rest and the only
  // way back to them is to revoke and re-issue, which is what the next `npm run preview` does.
  const sandboxBlock =
    sandbox === null
      ? ""
      : `\n  BOT SANDBOX  (${sandbox.clinicName})\n\n` +
        `      credential id   ${sandbox.credentialId}\n` +
        `      secret          ${sandbox.secret}\n` +
        `      webhook secret  ${sandbox.webhookSecret}\n` +
        `      webhook         ${sandbox.webhookUrl}   (echo receiver, verifies each signature)\n` +
        `      token           POST http://localhost:${PORT_API}/bot/auth/token {credentialId, secret}\n` +
        `      test phone      ${sandbox.phone ?? "(none seeded)"}\n` +
        `\n      The acceptance suite of WHATSAPP-BOT-CONTRACT.md §9, for the developer to run:\n\n` +
        `      cd apps/api && npm run bot:acceptance -- \\\n` +
        `        --base-url http://localhost:${PORT_API} --credential-id ${sandbox.credentialId} \\\n` +
        `        --secret ${sandbox.secret} --phone ${sandbox.phone ?? ""} \\\n` +
        `        --doctor-id ${sandbox.doctorId ?? ""} --service-id ${sandbox.serviceId ?? ""} \\\n` +
        `        --foreign-appointment-id ${sandbox.foreignAppointmentId ?? ""} \\\n` +
        `        --webhook-secret ${sandbox.webhookSecret} --json acceptance.json\n\n` +
        `      Shown once. The next preview revokes this credential and issues another.\n`;
  console.log(
    `\n${rule}\n  REVIEW BUILD READY\n\n      http://localhost:${PORT_WEB}\n${marketingLine}${sandboxBlock}\n` +
      `  branch ${builtBranch}${prLabel}\n` +
      `  commit ${commit}   built ${builtAt}\n  database ${REVIEW_DB}   api :${PORT_API}\n\n` +
      `  The login footer shows that branch and commit. If it shows anything else you are\n` +
      `  looking at a cached page -- hard-reload before giving feedback.\n\n` +
      `  Ctrl+C to stop.\n${rule}\n`,
  );
}
