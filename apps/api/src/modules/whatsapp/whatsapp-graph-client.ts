// Sending a reply back to the patient. The webhook (whatsapp.controller.ts) is Meta calling us;
// this is the other direction, us calling Meta's Cloud API -- unrelated to bot-credential.service.ts
// / webhook-dispatch.ts, which is *our own* outbound webhook to an external bot developer.
//
// Plain fetch, same reasoning as gpt-client.ts and bot-api-client.ts: one call, one shape, no HTTP
// client dependency for it.

const GRAPH_API_VERSION = "v21.0";

/**
 * One access token for now (`WHATSAPP_ACCESS_TOKEN`), same simplification as
 * `defaultBotCredentialConfig` in bot-api-client.ts: one Meta test number today, a per-clinic token
 * once more than one clinic is subscribed through the tech-provider account. A tech-provider setup
 * generally issues one system-user token capable of sending through every WABA it manages, so this
 * may not even need to become per-clinic -- worth confirming against Meta's own docs when the second
 * clinic is onboarded, rather than guessed now.
 */
function accessToken(): string {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not set -- see .env.example.");
  return token;
}

/**
 * Sends a plain-text reply. `phoneNumberId` is the clinic's own Meta phone number id (the same
 * value stored in `tenants.whatsapp_phone_number_id` and used to resolve the tenant on the way in),
 * never a value the model or the patient supplies.
 *
 * Returns Meta's own message id, so the caller can write it as `messages.external_message_id` on the
 * outbound row -- the same id a delivery-status callback will later refer back to.
 */
export async function sendWhatsAppText(
  phoneNumberId: string,
  toWaId: string,
  body: string,
): Promise<{ externalMessageId: string }> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken()}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "text",
      // No preview_url: a booking reply never carries a link in this phase, and Meta's own
      // unfurling of an accidental URL in free text is not something to opt into by omission.
      text: { body, preview_url: false },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${errorBody}`);
  }

  const data = (await response.json()) as { messages?: Array<{ id: string }> };
  const externalMessageId = data.messages?.[0]?.id;
  if (!externalMessageId) throw new Error("WhatsApp send succeeded but returned no message id.");
  return { externalMessageId };
}
