/**
 * The public web chat's only call. No token, no cookie -- `apps/api/src/modules/webchat` is
 * reachable with no session at all, so this is a plain fetch rather than the authFetch pattern
 * every other feature in this app uses.
 */

export interface WebchatResponse {
  sessionId: string;
  reply: string;
}

export async function sendWebchatMessage(sessionId: string | undefined, message: string): Promise<WebchatResponse> {
  const response = await fetch("/api/public/webchat/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });

  if (!response.ok) {
    throw new Error(`Web chat request failed (${response.status}).`);
  }

  return (await response.json()) as WebchatResponse;
}
