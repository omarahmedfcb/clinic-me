// Sending a reply back to the patient. The webhook (whatsapp.controller.ts) is Meta calling us;
// this is the other direction, us calling Meta's Cloud API -- unrelated to bot-credential.service.ts
// / webhook-dispatch.ts, which is *our own* outbound webhook to an external bot developer.
//
// Plain fetch, same reasoning as gpt-client.ts and bot-api-client.ts: one call, one shape, no HTTP
// client dependency for it.

const GRAPH_API_VERSION = process.env["WHATSAPP_GRAPH_VERSION"] ?? "v26.0";

/**
 * One access token for now (`WHATSAPP_ACCESS_TOKEN`), same simplification as
 * `defaultBotCredentialConfig` in bot-api-client.ts: one Meta test number today, a per-clinic token
 * once more than one clinic is subscribed through the tech-provider account. A tech-provider setup
 * generally issues one system-user token capable of sending through every WABA it manages, so this
 * may not even need to become per-clinic -- worth confirming against Meta's own docs when the second
 * clinic is onboarded, rather than guessed now.
 */
function accessToken(clinicToken?: string): string {
  if (clinicToken) return clinicToken;
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not set -- see .env.example.");
  return token;
}

/**
 * A failed send, with Meta's own error code kept. Code 190 is "this access token is no longer valid"
 * (expired, revoked, or the clinic removed our app) -- the one failure that is the connection's fault
 * and not the message's, which is what lets the caller flag the connection instead of just logging.
 * The message text is unchanged, so anything matching on it keeps working.
 */
export class WhatsAppSendError extends Error {
  readonly httpStatus: number;
  readonly metaCode: number | null;

  constructor(httpStatus: number, metaCode: number | null, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.metaCode = metaCode;
  }

  get tokenInvalid(): boolean {
    return this.metaCode === 190;
  }
}

function sendError(label: string, httpStatus: number, body: string): WhatsAppSendError {
  let metaCode: number | null = null;
  try {
    metaCode = (JSON.parse(body) as { error?: { code?: number } }).error?.code ?? null;
  } catch {
    // Not JSON: leave the code unknown.
  }
  return new WhatsAppSendError(httpStatus, metaCode, `${label}: ${httpStatus} ${body}`);
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
  token?: string
): Promise<{ externalMessageId: string }> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(token)}` },
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
    throw sendError("WhatsApp send failed", response.status, errorBody);
  }

  const data = (await response.json()) as { messages?: Array<{ id: string }> };
  const externalMessageId = data.messages?.[0]?.id;
  if (!externalMessageId) throw new Error("WhatsApp send succeeded but returned no message id.");
  return { externalMessageId };
}

/** One tappable reply button. Meta's own limits, enforced by `sendWhatsAppButtons` below rather
 *  than trusted of the caller: at most 3 per message, `id` under 256 bytes, `title` under 20
 *  UTF-16 code units (Meta counts codepoints, not bytes, for this one). */
export interface WhatsAppButton {
  id: string;
  title: string;
}

/**
 * A short question with up to three tappable buttons -- the flow's default for anything with 2 or
 * 3 fixed answers (yes/no, doctor A vs B when there happen to be only two). `bodyText` is the
 * question itself; the buttons carry no separate label the way a list's opening button does.
 *
 * Meta rejects the whole send if a title exceeds 20 characters or there are more than 3 buttons --
 * caught here, before the HTTP call, so a template that has drifted past the limit fails loudly in
 * the template itself (whatsapp-flow-text.ts) rather than as an opaque 400 from Meta at runtime.
 */
export async function sendWhatsAppButtons(
  phoneNumberId: string,
  toWaId: string,
  bodyText: string,
  buttons: WhatsAppButton[],
  token?: string
): Promise<{ externalMessageId: string }> {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error(`sendWhatsAppButtons: need 1-3 buttons, got ${buttons.length}`);
  }
  for (const button of buttons) {
    if (button.title.length > 20) {
      throw new Error(`sendWhatsAppButtons: button title over 20 chars: "${button.title}"`);
    }
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(token)}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw sendError("WhatsApp interactive-button send failed", response.status, errorBody);
  }

  const data = (await response.json()) as { messages?: Array<{ id: string }> };
  const externalMessageId = data.messages?.[0]?.id;
  if (!externalMessageId) throw new Error("WhatsApp interactive-button send succeeded but returned no message id.");
  return { externalMessageId };
}

/** One row of a list message. Meta's limits: `id` under 200 bytes, `title` under 24 characters,
 *  `description` (optional) under 72. */
export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

/**
 * A question with many answers, shown as a tappable list rather than free text -- doctors,
 * services, dates, and slots (paginated into pages of 9 plus a "more" row by the caller; this
 * function itself enforces only Meta's hard ceiling of 10 rows *total* across every section, which
 * is what one page of the paginated slot list is already sized to).
 *
 * `buttonLabel` is what opens the list (e.g. "اختر", "More options") -- distinct from any row's own
 * title, and under Meta's 20-character limit for it, same as a reply button's title.
 */
export async function sendWhatsAppList(
  phoneNumberId: string,
  toWaId: string,
  bodyText: string,
  buttonLabel: string,
  sections: WhatsAppListSection[],
  token?: string
): Promise<{ externalMessageId: string }> {
  const totalRows = sections.reduce((sum, section) => sum + section.rows.length, 0);
  if (totalRows === 0 || totalRows > 10) {
    throw new Error(`sendWhatsAppList: need 1-10 rows total, got ${totalRows}`);
  }
  if (buttonLabel.length > 20) {
    throw new Error(`sendWhatsAppList: button label over 20 chars: "${buttonLabel}"`);
  }
  for (const section of sections) {
    if (section.title.length > 24) {
      throw new Error(`sendWhatsAppList: section title over 24 chars: "${section.title}"`);
    }
    for (const row of section.rows) {
      if (row.title.length > 24) throw new Error(`sendWhatsAppList: row title over 24 chars: "${row.title}"`);
      if ((row.description?.length ?? 0) > 72) {
        throw new Error(`sendWhatsAppList: row description over 72 chars: "${row.description}"`);
      }
    }
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(token)}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({ id: row.id, title: row.title, description: row.description })),
          })),
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw sendError("WhatsApp interactive-list send failed", response.status, errorBody);
  }

  const data = (await response.json()) as { messages?: Array<{ id: string }> };
  const externalMessageId = data.messages?.[0]?.id;
  if (!externalMessageId) throw new Error("WhatsApp interactive-list send succeeded but returned no message id.");
  return { externalMessageId };
}

/**
 * What a template send carries. Templates are the only way to message a patient who has not written
 * to the clinic in the last 24 hours (Meta's customer-service window), which is exactly who a reminder,
 * a cancellation notice and a documents link are for.
 *
 * Everything variable is positional -- `{{1}}`, `{{2}}` in the approved template text -- so the
 * *wording* lives in whatsapp-templates.ts, next to the text submitted to Meta, and cannot drift from it.
 */
export interface WhatsAppTemplateSend {
  name: string;
  /** Meta's language code for the approved translation, e.g. "ar". */
  language: string;
  bodyParams: string[];
  /** One payload per QUICK_REPLY button, in button order. Echoed back to us when the patient taps. */
  quickReplyPayloads?: string[];
  /** The text appended to a URL button's base address (`https://…/d/{{1}}`). */
  urlButtonSuffix?: string;
  /** Which button slot the URL button occupies. 0 unless quick-reply buttons come first. */
  urlButtonIndex?: number;
}

export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  toWaId: string,
  template: WhatsAppTemplateSend,
  token?: string,
): Promise<{ externalMessageId: string }> {
  const components: Array<Record<string, unknown>> = [];

  if (template.bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: template.bodyParams.map((text) => ({ type: "text", text })),
    });
  }
  (template.quickReplyPayloads ?? []).forEach((payload, index) => {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload }],
    });
  });
  if (template.urlButtonSuffix !== undefined) {
    components.push({
      type: "button",
      sub_type: "url",
      index: String(template.urlButtonIndex ?? 0),
      parameters: [{ type: "text", text: template.urlButtonSuffix }],
    });
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(token)}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "template",
      template: { name: template.name, language: { code: template.language }, components },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw sendError("WhatsApp template send failed", response.status, errorBody);
  }

  const data = (await response.json()) as { messages?: Array<{ id: string }> };
  const externalMessageId = data.messages?.[0]?.id;
  if (!externalMessageId) throw new Error("WhatsApp template send succeeded but returned no message id.");
  return { externalMessageId };
}

/** A template as Meta stores it, for the status check -- `APPROVED`, `PENDING`, `REJECTED`, ... */
export interface WhatsAppTemplateStatus {
  name: string;
  language: string;
  status: string;
}

/**
 * Submits one template to a clinic's WhatsApp Business Account for review. Templates belong to the
 * WABA, not to the platform, so this runs once per clinic -- `scripts/whatsapp-templates.mjs`.
 * `components` is Meta's own shape (HEADER / BODY / BUTTONS), built in whatsapp-templates.ts.
 */
export async function submitWhatsAppTemplate(
  wabaId: string,
  definition: { name: string; language: string; category: "UTILITY"; components: unknown[] },
  token?: string,
): Promise<{ id: string; status: string }> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(token)}` },
    body: JSON.stringify(definition),
  });
  if (!response.ok) {
    throw sendError("WhatsApp template submission failed", response.status, await response.text());
  }
  const data = (await response.json()) as { id?: string; status?: string };
  return { id: data.id ?? "", status: data.status ?? "PENDING" };
}

/** The templates a clinic's WABA already has, so submitting is idempotent and approval is visible. */
export async function listWhatsAppTemplates(wabaId: string, token?: string): Promise<WhatsAppTemplateStatus[]> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?fields=name,language,status&limit=100`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken(token)}` } });
  if (!response.ok) {
    throw sendError("WhatsApp template listing failed", response.status, await response.text());
  }
  const data = (await response.json()) as { data?: WhatsAppTemplateStatus[] };
  return data.data ?? [];
}
