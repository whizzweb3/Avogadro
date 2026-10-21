import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createArtifactStorage } from "./index.js";

const config = { endpoint: "http://localhost:9000", region: "us-east-1", bucket: "avogadro-local", accessKeyId: "test-artifact-key", secretAccessKey: "test-artifact-secret", retentionDays: 7 };
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("artifact store writes a digest-addressed bounded object and retrieves verified bytes", async () => {
  const writes: Array<{ input: Record<string, unknown>; command: string }> = [];
  const body = Buffer.from("trusted Foundry evidence");
  const client = { async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
    writes.push({ input: command.input, command: command.constructor.name });
    if (command.constructor.name === "GetObjectCommand") return { ContentLength: body.length, Body: { async *[Symbol.asyncIterator]() { yield body; } } };
    return {};
  } };
  const storage = createArtifactStorage(config, client as never);
  const campaignId = "f1c0f0f0-1111-4111-8111-111111111111";
  const manifest = { name: "stdout.txt", content: body.toString(), sha256: hash(body), bytes: body.length };
  const stored = await storage.put(campaignId, 2, manifest);
  assert.equal(stored.digest, `0x${hash(body)}`);
  assert.equal(stored.byteCount, body.length);
  assert.equal(stored.objectKey.startsWith(`campaigns/${campaignId}/attempt-2/`), true);
  assert.equal(stored.retainUntil.getTime() > Date.now(), true);
  const fetched = await storage.get(stored.objectKey, stored.byteCount, stored.digest);
  assert.deepEqual(fetched, body);
  assert.deepEqual(writes.map((write) => write.command), ["PutObjectCommand", "GetObjectCommand"]);
  assert.equal(writes[0]?.input.Bucket, config.bucket);
  assert.equal(writes[0]?.input.Key, stored.objectKey);
});

test("artifact store refuses corrupt manifests, invalid names, and unexpected content digests", async () => {
  let sends = 0;
  const storage = createArtifactStorage(config, { async send() { sends++; return {}; } } as never);
  const body = Buffer.from("evidence");
  const base = { name: "stdout.txt", content: body.toString(), sha256: hash(body), bytes: body.length };
  await assert.rejects(() => storage.put("f1c0f0f0-1111-4111-8111-111111111111", 1, { ...base, sha256: "0".repeat(64) }), /does not match/);
  await assert.rejects(() => storage.put("f1c0f0f0-1111-4111-8111-111111111111", 1, { ...base, name: "../secret" }), /Invalid artifact name/);
  assert.equal(sends, 0);
});

test("artifact store rejects non-local plaintext endpoints and endpoint-embedded credentials", () => {
  assert.throws(() => createArtifactStorage({ ...config, endpoint: "http://objects.example.test" }), /HTTPS/);
  assert.throws(() => createArtifactStorage({ ...config, endpoint: "https://user:secret@objects.example.test" }), /cannot contain credentials/);
});

test("artifact store rejects unexpected object hashes and oversized metadata on read", async () => {
  const body = Buffer.from("altered evidence");
  const storage = createArtifactStorage(config, { async send() { return { ContentLength: body.length, Body: { async *[Symbol.asyncIterator]() { yield body; } } }; } } as never);
  await assert.rejects(() => storage.get("campaigns/id/key", body.length, `0x${"0".repeat(64)}`), /SHA-256/);
  await assert.rejects(() => storage.get("campaigns/id/key", 65_537, `0x${"0".repeat(64)}`), /Invalid artifact metadata/);
});

test("artifact store stops a stream that exceeds the authorized metadata size", async () => {
  const body = Buffer.from("unexpectedly long object");
  let destroyed = false;
  const storage = createArtifactStorage(config, { async send() { return { Body: { async *[Symbol.asyncIterator]() { yield body; }, destroy() { destroyed = true; } } }; } } as never);
  await assert.rejects(() => storage.get("campaigns/id/key", 1, `0x${hash(body)}`), /exceeds its metadata size/);
  assert.equal(destroyed, true);
});
