// Screenshots of the four screens the rebrand changes, for the PR body.
// `node scripts/brand/screenshots.mjs <before|after>` against a running review stack.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.env.REPO_ROOT ?? path.resolve(import.meta.dirname, "..", "..");
const { chromium } = createRequire(path.join(ROOT, "apps", "web", "package.json"))("@playwright/test");

const BASE = "http://localhost:4173";
const LABEL = process.argv[2] ?? "after";
const OUT = path.join(ROOT, "docs", "brand", LABEL);

/**
 * A doctor, because three of the four screens are the doctor's.
 *
 * The seed's password is in the repository and is not a secret — `blueprint.ts` says so, and
 * `seed-is-not-production.spec.ts` keeps the seed out of a live database.
 */
const SEED_PASSWORD = "dev-only-not-a-real-password";

async function signIn(page, phone) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // The field's test id changed with the rebrand, so both are tried rather than the script being
  // forked into two — a screenshot tool that only works on one side cannot produce a comparison.
  const phoneField = (await page.locator('[data-testid="login-phone"]').count())
    ? page.locator('[data-testid="login-phone"]')
    : page.locator('input[type="tel"]').first();

  await phoneField.fill(phone);
  await page.locator('input[type="password"]').first().fill(SEED_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/day|\/queue/, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
}

async function shoot(page, name) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`${LABEL}/${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-EG" });
  const page = await context.newPage();

  // 1. Login — signed out, so it is taken first and on its own page.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shoot(page, "1-login");

  // 2 and 3. Today and a visit, as the doctor.
  await signIn(page, "01005551002");
  await page.goto(`${BASE}/day`, { waitUntil: "networkidle" });
  await shoot(page, "2-today");

  await page.goto(`${BASE}/visits`, { waitUntil: "networkidle" });
  await shoot(page, "3-visits");

  // 4. The desk, as reception — a different role, so a fresh context.
  await context.clearCookies();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-EG" });
  const deskPage = await desk.newPage();
  await signIn(deskPage, "01005551003");
  await deskPage.goto(`${BASE}/payments`, { waitUntil: "networkidle" });
  await deskPage.waitForTimeout(1500);
  await deskPage.screenshot({ path: path.join(OUT, "4-desk.png") });
  console.log(`${LABEL}/4-desk.png`);

  await browser.close();
}

await main();
