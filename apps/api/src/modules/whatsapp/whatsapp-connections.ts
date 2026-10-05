// What a clinic's WhatsApp pipeline needs to act as that clinic: the Meta business token to send
// with, and a BotApiClient holding its bot credential. Reads through `resolve_whatsapp_connection`
// because the inbound webhook knows only a phone_number_id, so there is no tenant to bind yet.
//
// A clinic with no connection row falls back to the single global pair in .env
// (WHATSAPP_ACCESS_TOKEN, BOT_CREDENTIAL_ID/SECRET): the manually wired Meta test number keeps
// working unchanged next to clinics that arrived through Embedded Signup.

import { prisma } from "../../prisma/client.ts";
import { BotApiClient, defaultApiBaseUrl, getDefaultBotApiClient } from "./bot-api-client.ts";
import { decryptSecret, loadEncryptionKey } from "./connection-crypto.ts";

export interface WhatsAppAccess {
  accessToken: string;
  client: BotApiClient;
}

interface ConnectionRow {
  tenantId: string;
  status: string;
  accessTokenEnc: string;
  botCredentialId: string;
  botSecretEnc: string;
}

/** The AAD each encrypted column is bound to. One definition, used by signup to write and here to read. */
export const accessTokenAad = (tenantId: string): string => `${tenantId}:access-token`;
export const botSecretAad = (tenantId: string): string => `${tenantId}:bot-secret`;

/** One client per credential, so its cached access token survives across messages. */
const clients = new Map<string, BotApiClient>();

function envFallback(): WhatsAppAccess | null {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!accessToken || !process.env["BOT_CREDENTIAL_ID"] || !process.env["BOT_CREDENTIAL_SECRET"]) return null;
  return { accessToken, client: getDefaultBotApiClient() };
}

export async function resolveWhatsAppAccess(tenantId: string, phoneNumberId: string): Promise<WhatsAppAccess | null> {
  const rows = await prisma.$queryRaw<ConnectionRow[]>`
    SELECT tenant_id AS "tenantId", status, access_token_enc AS "accessTokenEnc",
           bot_credential_id AS "botCredentialId", bot_secret_enc AS "botSecretEnc"
    FROM resolve_whatsapp_connection(${phoneNumberId})
  `;
  const row = rows[0];
  if (row === undefined) return envFallback();

  // The number is the lookup key, so a row that names a different clinic is a data fault, not a clinic.
  if (row.tenantId !== tenantId) return null;
  if (row.status !== "ACTIVE") return null;

  const key = loadEncryptionKey();
  let client = clients.get(row.botCredentialId);
  if (client === undefined) {
    client = new BotApiClient({
      apiBaseUrl: defaultApiBaseUrl(),
      credentialId: row.botCredentialId,
      secret: decryptSecret(row.botSecretEnc, key, botSecretAad(tenantId)),
    });
    clients.set(row.botCredentialId, client);
  }

  return { accessToken: decryptSecret(row.accessTokenEnc, key, accessTokenAad(tenantId)), client };
}
