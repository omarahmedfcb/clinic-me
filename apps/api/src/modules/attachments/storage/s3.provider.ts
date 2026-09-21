// The second StorageProvider: an S3-compatible object store (Huawei OBS in Cairo, MinIO in a drill).
// Path-style addressing and SigV4 from s3-signature.ts, over node:http(s). No SDK, no new dependency.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ObjectAlreadyExists, ObjectNotFound, type StorageProvider } from "./storage-provider.ts";
import { canonicalPath, signRequest, type SigningCredentials } from "./s3-signature.ts";

export interface S3StorageSettings {
  /** `https://obs.af-north-1.myhuaweicloud.com`, or `http://localhost:9000` for MinIO. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key prefix, so one bucket can hold more than this system's objects. */
  prefix?: string;
}

interface Response {
  status: number;
  body: Buffer;
}

export class S3StorageProvider implements StorageProvider {
  private readonly url: URL;
  private readonly credentials: SigningCredentials;
  private readonly settings: S3StorageSettings;

  constructor(settings: S3StorageSettings) {
    this.settings = settings;
    this.url = new URL(settings.endpoint);
    this.credentials = {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: settings.region,
      service: "s3",
    };
  }

  /**
   * Path-style (`/bucket/key`) rather than virtual-host style (`bucket.host/key`).
   *
   * Virtual-host style needs DNS for every bucket name and TLS certificates that cover it; MinIO
   * serves path-style by default and OBS accepts it. One addressing mode everywhere is one fewer
   * thing that works in a drill and fails in Cairo.
   */
  private pathFor(key: string): string {
    const prefix = this.settings.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    return canonicalPath(this.settings.bucket, prefix, key);
  }

  private send(method: "GET" | "PUT" | "HEAD", path: string, body: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const host = this.url.host;
    const headers = signRequest(
      { method, path, host, headers: { ...extra, "content-length": String(body.byteLength) }, body, now: new Date() },
      this.credentials,
    );

    const send = this.url.protocol === "http:" ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const call = send(
        { protocol: this.url.protocol, hostname: this.url.hostname, port: this.url.port, path, method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      call.on("error", reject);
      call.end(body);
    });
  }

  /**
   * Create-only, like the filesystem provider: a HEAD that finds an object refuses the write.
   *
   * **This is a check-then-write, and it has a race the filesystem's `wx` flag does not.** Keys are
   * a fresh UUIDv7 per attachment, so two writers colliding on one key means something is already
   * badly wrong; what this protects against is a retry or a replay overwriting a stored record.
   * Said plainly rather than left for a reader to notice: S3's own `If-None-Match: *` would close it,
   * and it is not relied on here because OBS's support for it is not something this project has
   * verified.
   */
  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(key);
    const existing = await this.send("HEAD", path, Buffer.alloc(0));
    if (existing.status === 200) throw new ObjectAlreadyExists(key);

    const written = await this.send("PUT", path, bytes, { "content-type": "application/octet-stream" });
    if (written.status !== 200 && written.status !== 204) {
      throw new Error(`Storing ${key} failed: the object store answered ${written.status}.`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.send("GET", this.pathFor(key), Buffer.alloc(0));
    // 403 as well as 404: a bucket policy that hides an object must not tell a caller it exists,
    // which is the same reason the interface forbids distinguishing the two.
    if (response.status === 404 || response.status === 403) throw new ObjectNotFound(key);
    if (response.status !== 200) {
      throw new Error(`Reading ${key} failed: the object store answered ${response.status}.`);
    }
    return response.body;
  }

  /**
   * Proves at boot that the endpoint answers, the credentials sign correctly and the bucket is
   * there — the same argument the filesystem provider makes for checking its root: a storage
   * backend that cannot do its job should say so at startup, not with a patient in the room.
   */
  async assertUsable(): Promise<void> {
    const response = await this.send("HEAD", canonicalPath(this.settings.bucket), Buffer.alloc(0));
    if (response.status === 200) return;
    throw new Error(
      `The attachments bucket "${this.settings.bucket}" at ${this.settings.endpoint} answered ` +
        `${response.status} to a HEAD. 403 usually means the credentials are wrong or unsigned, ` +
        "404 that the bucket does not exist in this region.",
    );
  }
}
