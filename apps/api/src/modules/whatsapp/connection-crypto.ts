// At-rest encryption for the two credentials a WhatsApp connection keeps. Pure: no database import,
// so it unit-tests without an environment (CLAUDE.md: a unit spec that needs a database has an
// import-graph bug).
//
// AES-256-GCM, with the row's identity as additional authenticated data, so a ciphertext copied
// into another clinic's row fails to decrypt instead of quietly working.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** `WHATSAPP_ENCRYPTION_KEY`: 32 random bytes, base64. Generate with `openssl rand -base64 32`. */
export function loadEncryptionKey(raw: string | undefined = process.env["WHATSAPP_ENCRYPTION_KEY"]): Buffer {
  if (!raw) throw new Error("WHATSAPP_ENCRYPTION_KEY is not set -- see .env.example.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`WHATSAPP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`);
  }
  return key;
}

/** `aad` names what the value belongs to, e.g. `${tenantId}:access-token`. Decrypt needs the same. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const [version, iv, tag, ciphertext] = blob.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Unrecognised encrypted value.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
