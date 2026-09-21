// AWS Signature Version 4 for S3-compatible object storage, by hand: no SDK, no new dependency.
// Pure functions over strings and buffers, so the whole of it is unit-testable without a network.

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** "s3" everywhere this project talks to: OBS, MinIO and S3 itself all sign as the S3 service. */
  service: string;
}

export interface SignableRequest {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** Already-encoded path, beginning with "/". */
  path: string;
  /** Host header value, including a port when the endpoint carries one. */
  host: string;
  headers: Record<string, string>;
  body: Buffer;
  /** The request instant, passed in rather than read from the clock so a test can pin it. */
  now: Date;
}

const sha256Hex = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value).digest();

/** `20260918T071500Z` and `20260918`, the two forms every part of the signature needs. */
export function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Percent-encodes one path segment the way S3 canonicalisation requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone and S3 does not, which is the classic source of
 * signatures that verify for most keys and fail for a few. Storage keys here are UUIDv7-derived and
 * would never contain those characters; encoding them anyway costs nothing and removes the class.
 */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** "/bucket/a/b.png" with every segment encoded and the slashes kept. */
export function canonicalPath(...segments: string[]): string {
  const parts = segments
    .flatMap((segment) => segment.split("/"))
    .filter((part) => part.length > 0)
    .map(encodeSegment);
  return `/${parts.join("/")}`;
}

/**
 * Returns the headers to send, `Authorization` included.
 *
 * `x-amz-content-sha256` carries the hash of the real payload rather than UNSIGNED-PAYLOAD: the
 * signature then covers the bytes, so a proxy that altered an upload in flight would be rejected by
 * the store rather than accepted and stored wrong.
 */
export function signRequest(
  request: SignableRequest,
  credentials: SigningCredentials,
  /**
   * `false` omits `x-amz-content-sha256`, which is what AWS's own published SigV4 test vectors sign.
   * Every real call here leaves it on; the option exists so the HMAC chain and the canonicalisation
   * can be checked against an external reference rather than against this file's own output.
   */
  options: { contentShaHeader?: boolean } = {},
): Record<string, string> {
  const { amzDate, dateStamp } = timestamps(request.now);
  const payloadHash = sha256Hex(request.body);

  const headers: Record<string, string> = {
    ...request.headers,
    host: request.host,
    ...(options.contentShaHeader === false ? {} : { "x-amz-content-sha256": payloadHash }),
    "x-amz-date": amzDate,
  };

  const canonicalHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lowerCased = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = canonicalHeaderNames
    .map((name) => `${name}:${(lowerCased.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = canonicalHeaderNames.join(";");

  const canonicalRequest = [
    request.method,
    request.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = ["aws4_request"].reduce(
    (key, step) => hmac(key, step),
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), credentials.region), credentials.service),
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
