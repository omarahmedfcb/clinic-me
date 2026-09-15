// Polls /health until it answers, so a review build never announces itself before it works.
// Extracted from review.mjs so it can be exercised against a dead port without a rebuild.

/**
 * Resolves to `null` when the API is healthy, or to a sentence saying why it never was.
 *
 * `isAlive` is asked on every pass because the interesting failure is not a slow start — it is an
 * API that exited during one. Without it a crashed process is indistinguishable from a cold one
 * until the deadline, which turns a five-second answer into a ninety-second wait.
 */
export async function waitForHealth({
  url,
  timeoutMs = 90_000,
  intervalMs = 500,
  isAlive = () => true,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
}) {
  const deadline = now() + timeoutMs;

  for (;;) {
    if (!isAlive()) return "the API exited before it answered /health";

    try {
      const response = await fetchImpl(url);
      if (response.ok) {
        const body = await response.json();
        // `status: "ok"` and not merely a 200: /health runs a real query, and a body that says
        // anything else means the process is up while the database behind it is not.
        if (body?.status === "ok") return null;
        return `/health answered ${response.status} with ${JSON.stringify(body)}`;
      }
      // A 4xx/5xx is a real answer and worth reporting, but not worth giving up on immediately:
      // Nest can serve before every module has settled.
    } catch {
      // Connection refused: not listening yet. The only way to tell that from "never will" is time.
    }

    if (now() >= deadline) return `/health did not answer within ${Math.round(timeoutMs / 1000)}s`;
    await sleep(intervalMs);
  }
}
