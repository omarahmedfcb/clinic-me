import { canonicalPath, encodeSegment, signRequest, timestamps } from "./s3-signature.ts";

/**
 * The signing is ours rather than an SDK's, so it is checked against something that is not ours.
 *
 * `get-vanilla` is from AWS's published SigV4 test suite: fixed credentials, fixed instant, and a
 * signature AWS states. A signer that agrees with it has the HMAC chain, the scope string and the
 * canonical request right — the three places a hand-written implementation goes wrong and then
 * fails only against a real endpoint.
 */
describe("AWS SigV4", () => {
  const credentials = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
  };

  test("reproduces the published get-vanilla signature", () => {
    const headers = signRequest(
      {
        method: "GET",
        path: "/",
        host: "example.amazonaws.com",
        headers: {},
        body: Buffer.alloc(0),
        now: new Date("2015-08-30T12:36:00Z"),
      },
      credentials,
      { contentShaHeader: false },
    );

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("every input is actually signed: changing any one of them changes the signature", () => {
    const base: Parameters<typeof signRequest>[0] = {
      method: "PUT",
      path: "/bucket/key.png",
      host: "obs.af-north-1.example",
      headers: {},
      body: Buffer.from("bytes"),
      now: new Date("2026-09-18T07:15:00Z"),
    };
    const signatureOf = (request: typeof base, creds = credentials): string =>
      /Signature=([0-9a-f]+)/.exec(signRequest(request, creds)["authorization"] ?? "")?.[1] ?? "";

    const original = signatureOf(base);
    expect(signatureOf({ ...base, body: Buffer.from("other bytes") })).not.toBe(original);
    expect(signatureOf({ ...base, path: "/bucket/other.png" })).not.toBe(original);
    expect(signatureOf({ ...base, method: "GET" })).not.toBe(original);
    expect(signatureOf({ ...base, host: "elsewhere.example" })).not.toBe(original);
    expect(signatureOf({ ...base, now: new Date("2026-09-18T07:15:01Z") })).not.toBe(original);
    expect(signatureOf(base, { ...credentials, secretAccessKey: "different" })).not.toBe(original);
    expect(signatureOf(base, { ...credentials, region: "eu-west-1" })).not.toBe(original);
  });

  test("the payload hash is sent, and it is the hash of the body", () => {
    const headers = signRequest(
      {
        method: "PUT",
        path: "/bucket/key.png",
        host: "obs.example",
        headers: {},
        body: Buffer.from("hello"),
        now: new Date("2026-09-18T07:15:00Z"),
      },
      credentials,
    );

    // sha256("hello"), so a proxy that altered the bytes in flight fails the signature check at the
    // store rather than storing something the sender never sent.
    expect(headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("timestamps are the two forms the signature needs", () => {
    expect(timestamps(new Date("2026-09-18T07:15:00.123Z"))).toEqual({
      amzDate: "20260918T071500Z",
      dateStamp: "20260918",
    });
  });

  test("path segments are encoded, including the characters encodeURIComponent leaves alone", () => {
    expect(canonicalPath("bucket", "a/b c.png")).toBe("/bucket/a/b%20c.png");
    expect(encodeSegment("it's(*)!")).toBe("it%27s%28%2A%29%21");
    // A key can never smuggle its way out of the bucket prefix: the slash it would need is encoded
    // when it sits inside one segment, and kept when it is a real separator.
    expect(canonicalPath("bucket", "..%2Fescape")).toBe("/bucket/..%252Fescape");
  });
});
