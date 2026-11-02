// $disconnect() must end the pool client.ts hands the adapter, which by default keeps it until pg's 10 s idle timeout
// (holding Jest open after the run). Tracks the sockets this pool opened; an ended pool's close within ~50 ms.
import type { Socket } from "node:net";
import { prisma } from "../../src/prisma/client.ts";

const dbPort = Number(new URL(process.env["APP_DATABASE_URL"] ?? "postgres://x@localhost:5432/x").port || 5432);
const dbSockets = (): Set<Socket> =>
  new Set((process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
    .filter((h): h is Socket => (h as { constructor?: { name?: string } }).constructor?.name === "Socket" && (h as Socket).remotePort === dbPort));

test("disconnecting the client closes every database socket its pool opened", async () => {
  const before = dbSockets();
  await Promise.all([1, 2, 3].map(() => prisma.$queryRaw`SELECT pg_sleep(0.05)::text AS slept`));
  const opened = [...dbSockets()].filter((socket) => !before.has(socket));
  expect(opened.length).toBeGreaterThan(0);
  await prisma.$disconnect();
  const stillOpen = () => opened.filter((socket) => dbSockets().has(socket)).length;
  for (let waited = 0; stillOpen() > 0 && waited < 1000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stillOpen()).toBe(0);
});
