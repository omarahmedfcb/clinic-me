// What a clinic's WhatsApp pipeline needs to act as that clinic: the Meta business token to send
// with, and a BotApiClient holding its bot credential. Reads through `resolve_whatsapp_connection`
// because the inbound webhook knows only a phone_number_id, so there is no tenant to bind yet.
//
// A clinic with no connection row falls back to the single global pair in .env
// (WHATSAPP_ACCESS_TOKEN, BOT_CREDENTIAL_ID/SECRET): the manually wired Meta test number keeps
// working unchanged next to clinics that arrived through Embedded Signup.

import { prisma } from "../../prisma/client.ts";
import { ActorContext, withTenant } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { BotApiClient, defaultApiBaseUrl, getDefaultBotApiClient } from "./bot-api-client.ts";
import { decryptSecret, loadEncryptionKey } from "./connection-crypto.ts";
import { WhatsAppSendError } from "./whatsapp-graph-client.ts";


/** NEW_NUMBER: a number that only the bot uses. COEXISTENCE: also live in the WhatsApp Business app. */
export type NumberMode = "NEW_NUMBER" | "COEXISTENCE";
export type ConnectionStatus = "ACTIVE" | "TOKEN_INVALID" | "DISCONNECTED";

export interface WhatsAppAccess {
  accessToken: string;
  client: BotApiClient;
  numberMode: NumberMode;
}


interface ConnectionRow {
  tenantId: string;
  status: string;
  accessTokenEnc: string;
  botCredentialId: string;
  botSecretEnc: string;
  numberMode: string;
}

/** The AAD each encrypted column is bound to. One definition, used by signup to write and here to read. */
export const accessTokenAad = (tenantId: string): string => `${tenantId}:access-token`;
export const botSecretAad = (tenantId: string): string => `${tenantId}:bot-secret`;

/** One client per credential, so its cached access token survives across messages. */
const clients = new Map<string, BotApiClient>();

function envFallback(): WhatsAppAccess | null {
  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!accessToken || !process.env["BOT_CREDENTIAL_ID"] || !process.env["BOT_CREDENTIAL_SECRET"]) return null;
  // Testing only: lets the Meta test number exercise the handoff flow. It has no WhatsApp Business app
  // behind it, so staff replies (echoes) can't happen on it; only the patient-request pause can be tried.
  const numberMode: NumberMode = process.env["WHATSAPP_ENV_NUMBER_MODE"] === "COEXISTENCE" ? "COEXISTENCE" : "NEW_NUMBER";
  return { accessToken, client: getDefaultBotApiClient(), numberMode };
}

export async function resolveWhatsAppAccess(tenantId: string, phoneNumberId: string): Promise<WhatsAppAccess | null> {
  const rows = await prisma.$queryRaw<ConnectionRow[]>`
    SELECT tenant_id AS "tenantId", status, access_token_enc AS "accessTokenEnc",
           bot_credential_id AS "botCredentialId", bot_secret_enc AS "botSecretEnc",
           number_mode AS "numberMode"
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

  return {
    accessToken: decryptSecret(row.accessTokenEnc, key, accessTokenAad(tenantId)),
    client,
    numberMode: row.numberMode === "COEXISTENCE" ? "COEXISTENCE" : "NEW_NUMBER",
  };
}

/** The write path for events nobody is signed in for: Meta's webhooks and a failed send. */
async function unattendedActor(): Promise<ActorContext> {
  return { ...(await systemActor()), ip: "whatsapp", userAgent: "clinic-os-whatsapp" };
}

/**
 * Moves a clinic's connection out of ACTIVE (or leaves it be). Only a real change is written, so a
 * burst of failed sends is one audit row, not one per message. A clinic with no connection row (the
 * .env test number) matches nothing and this is a no-op.
 */
export async function setConnectionStatus(
  tenantId: string,
  status: Exclude<ConnectionStatus, "ACTIVE">,
  reason: string,
): Promise<void> {
  const actor = await unattendedActor();
  await withTenant(tenantId, actor, (tx) =>
    tx.whatsAppConnection.updateMany({
      where: { tenantId, status: { not: status } },
      data: { status, disconnectReason: reason, statusChangedAt: new Date() },
    }),
  );
  console.warn(`WhatsApp: connection for tenant ${tenantId} is now ${status} (${reason})`);
}

/**
 * Called wherever a send to Meta fails. Only "the token is no longer valid" flags the connection;
 * every other failure is about that one message and stays a log line.
 */
export async function noteSendFailure(tenantId: string, error: unknown): Promise<void> {
  if (!(error instanceof WhatsAppSendError) || !error.tokenInvalid) return;
  await setConnectionStatus(tenantId, "TOKEN_INVALID", "INVALID_TOKEN").catch((statusError: unknown) => {
    console.error("WhatsApp: could not flag the connection as TOKEN_INVALID", statusError);
  });
}

export interface ConnectionSummary {
  status: ConnectionStatus;
  numberMode: NumberMode;
  displayPhoneNumber: string | null;
  disconnectReason: string | null;
}

/** What the clinic owner's banner needs, and nothing secret. `null`: no connection row. */
export async function readConnectionSummary(tenantId: string, actor: ActorContext): Promise<ConnectionSummary | null> {
  return withTenant(tenantId, actor, async (tx) => {
    const row = await tx.whatsAppConnection.findFirst({
      select: { status: true, numberMode: true, displayPhoneNumber: true, disconnectReason: true },
    });
    if (row === null) return null;
    return {
      status: row.status as ConnectionStatus,
      numberMode: row.numberMode === "COEXISTENCE" ? "COEXISTENCE" : "NEW_NUMBER",
      displayPhoneNumber: row.displayPhoneNumber,
      disconnectReason: row.disconnectReason,
    };
  });
}

/** `account_update` names the WABA, not the number, so this is the lookup that finds the clinics. */
export async function tenantsByWaba(wabaId: string): Promise<Array<{ tenantId: string; phoneNumberId: string; status: string }>> {
  return prisma.$queryRaw`
    SELECT tenant_id AS "tenantId", phone_number_id AS "phoneNumberId", status
    FROM resolve_whatsapp_connections_by_waba(${wabaId})
  `;
}