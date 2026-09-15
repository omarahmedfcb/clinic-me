// @ts-expect-error -- plain JS build tooling, deliberately outside the TypeScript project.
import { waitForHealth } from "../../../../scripts/wait-for-health.mjs";

/**
 * **A review build must not announce itself before it works.**
 *
 * `scripts/review.mjs` printed "REVIEW BUILD READY" on a fixed 2.5-second timer. A cold API takes
 * longer than that, so on 2026-09-09 the banner appeared over a stack whose every request came
 * back `ECONNREFUSED`. Nothing was broken; the message was simply not about anything it had
 * checked.
 *
 * That matters more here than a cosmetic race would, because of what the founder's review loop
 * costs: he reads READY, opens the page, finds it dead, and the feedback he gives is about a
 * product that was never running. His standing rule is the one this restores — *verify by running
 * the thing and inspecting the result, never by trusting a claim.*
 *
 * A fake clock and a fake `fetch` are injected rather than a real port being opened, so these run
 * in milliseconds and assert the decision rather than the timing.
 */

const OK = { ok: true, status: 200, json: async () => ({ status: "ok", database: "reachable" }) };

/** A clock that jumps by whatever the code asks to sleep, so a 90s deadline costs no real time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waiting for the API before saying READY", () => {
  test("resolves to null once /health answers ok", async () => {
    const { now, sleep } = fakeClock();
    const failure = await waitForHealth({ url: "http://x/health", now, sleep, fetchImpl: async () => OK });
    expect(failure).toBeNull();
  });

  test("keeps waiting through a connection refused, then succeeds", async () => {
    // The real sequence on every cold start: the port is not listening yet, and the only way to
    // tell that from "never will be" is to ask again.
    const { now, sleep } = fakeClock();
    let calls = 0;
    const failure = await waitForHealth({
      url: "http://x/health",
      now,
      sleep,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 5) throw new Error("ECONNREFUSED");
        return OK;
      },
    });
    expect({ failure, calls }).toEqual({ failure: null, calls: 5 });
  });

  test("gives up with a reason rather than waiting forever", async () => {
    const { now, sleep } = fakeClock();
    const failure = await waitForHealth({
      url: "http://x/health",
      timeoutMs: 30_000,
      now,
      sleep,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(failure).toBe("/health did not answer within 30s");
  });

  test("says so immediately when the API has exited", async () => {
    // The failure worth distinguishing: a crashed API is not a slow one, and waiting the full
    // deadline for a process that is already gone turns a clear error into a hang.
    const { now, sleep } = fakeClock();
    const failure = await waitForHealth({
      url: "http://x/health",
      now,
      sleep,
      isAlive: () => false,
      fetchImpl: async () => OK,
    });
    expect(failure).toBe("the API exited before it answered /health");
  });

  test("a 200 whose body is not ok is a failure, not a pass", async () => {
    // /health runs a real query. A process that is up with an unreachable database answers, and
    // "answered at all" is the weaker test of the two.
    const { now, sleep } = fakeClock();
    const failure = await waitForHealth({
      url: "http://x/health",
      now,
      sleep,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: "degraded" }) }),
    });
    expect(failure).toBe('/health answered 200 with {"status":"degraded"}');
  });
});
