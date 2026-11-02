// Support access PR 3: no request or transaction may start with less left on its session than the longest transaction the
// client allows, or one could outlive the hour. Read from source, so the guard needs no database (CLAUDE.md, import graph).
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..", "src");
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");
const number = (source: string, pattern: RegExp): number => {
  const match = pattern.exec(source)?.[1];
  if (match === undefined) throw new Error(`not found: ${pattern}`);
  return Number(match.replace(/_/g, ""));
};

describe("the support session margins outlast the longest transaction", () => {
  const transactionCapMs = number(read("prisma/client.ts"), /transactionOptions:\s*\{\s*timeout:\s*([\d_]+)/);
  const guardMarginMs = number(read("common/membership-freshness.interceptor.ts"), /SUPPORT_MARGIN_SECONDS\s*=\s*([\d_]+)/) * 1000;
  const transactionMarginMs = number(read("prisma/with-tenant.ts"), /SUPPORT_TRANSACTION_MARGIN_MS\s*=\s*([\d_]+)/);

  test("the guard's margin is at least the client's transaction cap", () => {
    expect(guardMarginMs).toBeGreaterThanOrEqual(transactionCapMs);
  });

  test("each transaction's margin is at least the client's transaction cap", () => {
    expect(transactionMarginMs).toBeGreaterThanOrEqual(transactionCapMs);
  });
});
