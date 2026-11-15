import assert from "node:assert/strict";
import { test } from "node:test";
import { checksumOf, encodeRfc3986, presignUrl } from "../src/presign.ts";

test("a presigned GET matches the AWS Signature Version 4 query-string example", async () => {
  const url = await presignUrl(
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
    },
    "GET",
    "https://examplebucket.s3.amazonaws.com",
    ["test.txt"],
    86400,
    new Date("2013-05-24T00:00:00Z"),
  );
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("key segments are encoded as RFC 3986 asks, beyond what encodeURIComponent does", () => {
  assert.equal(encodeRfc3986("a b!'()*~._-"), "a%20b%21%27%28%29%2A~._-");
});

test("a pack PUT signs the base64 SHA-256 of its key as x-amz-checksum-sha256", async () => {
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.equal(checksumOf(empty), "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  const credentials = { accessKeyId: "AKID", secretAccessKey: "secret", region: "auto", service: "s3" };
  const signed = (checksum: string) =>
    presignUrl(credentials, "PUT", "https://r2.example", ["bucket", "packs", empty], 60, new Date(0), [
      ["x-amz-checksum-sha256", checksum],
    ]);
  const url = new URL(await signed(checksumOf(empty)));
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host;x-amz-checksum-sha256");
  assert.notEqual(
    url.searchParams.get("X-Amz-Signature"),
    new URL(await signed("other")).searchParams.get("X-Amz-Signature"),
  );
});
