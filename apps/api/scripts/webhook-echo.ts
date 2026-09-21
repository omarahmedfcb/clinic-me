// The sandbox's webhook receiver: logs every delivery and says whether its signature verified, so
// the external developer can see a correct one before writing their own. Review builds only.

import { createServer } from "node:http";
import { assertSandboxScriptAllowed } from "../src/modules/bot/sandbox-policy.ts";
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../src/modules/bot/webhook-signing.ts";

const PORT = Number(process.env["SANDBOX_WEBHOOK_PORT"] ?? 5183);
const SECRET = process.env["SANDBOX_WEBHOOK_SECRET"] ?? "";

/** Keys already seen, so a replayed delivery is visible as one rather than looking like a new event. */
const seen = new Set<string>();

function readBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

assertSandboxScriptAllowed("webhook-echo");
if (SECRET === "") throw new Error("webhook-echo: SANDBOX_WEBHOOK_SECRET is not set; nothing could be verified.");

const server = createServer((request, response) => {
  void (async () => {
    const body = await readBody(request);
    const header = (name: string): string => String(request.headers[name] ?? "");

    const key = header(IDEMPOTENCY_HEADER);
    const signed = verifyWebhookSignature(SECRET, header(TIMESTAMP_HEADER), body, header(SIGNATURE_HEADER), new Date());
    const repeat = seen.has(key);
    seen.add(key);

    // One line per delivery, saying the three things the developer's own receiver has to get right.
    console.log(
      `[webhook-echo] ${signed ? "signature OK " : "SIGNATURE BAD"} ` +
        `${repeat ? "REPLAY  " : "first   "} key=${key || "(none)"} ${body}`,
    );

    // A bad signature is refused, because a receiver that answers 200 to anything teaches the wrong
    // lesson — and the contract requires the bot to reject one.
    response.writeHead(signed ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ received: signed }));
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[webhook-echo] listening on http://localhost:${PORT}/webhook`);
});
