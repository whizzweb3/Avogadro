import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

const campaignId = "f1c0f0f0-1111-4111-8111-111111111111";
const artifactId = "a1c0f0f0-1111-4111-8111-111111111111";
const metadata = { id: artifactId, campaignId, name: "stdout.txt", objectKey: `campaigns/${campaignId}/attempt-1/evidence/stdout.txt`, mediaType: "text/plain; charset=utf-8", digest: `0x${"a".repeat(64)}`, byteCount: 7, retainUntil: new Date(Date.now() + 60_000) };
const ownerAuth = async (request: import("fastify").FastifyRequest) => typeof request.headers["x-test-owner"] === "string" ? request.headers["x-test-owner"] as string : null;

function appWithArtifact(record = metadata) {
  const storageCalls: string[] = [];
  const app = buildApp({
    logger: false,
    authenticate: ownerAuth,
    campaignStore: { getArtifact: async (ownerId: string) => ownerId === "owner" ? record : null } as never,
    artifactStorage: {
      async get(key, bytes, digest) { storageCalls.push(`get:${key}:${bytes}:${digest}`); return Buffer.from("evidence"); },
      async delete(key) { storageCalls.push(`delete:${key}`); },
    },
  });
  return { app, storageCalls };
}

test("artifact endpoint requires owner authorization and returns private evidence bytes", async () => {
  const { app, storageCalls } = appWithArtifact();
  try {
    const unauthenticated = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/artifacts/${artifactId}` });
    assert.equal(unauthenticated.statusCode, 401);
    const foreign = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/artifacts/${artifactId}`, headers: { "x-test-owner": "other" } });
    assert.equal(foreign.statusCode, 404);
    assert.equal(storageCalls.length, 0);
    const owner = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/artifacts/${artifactId}`, headers: { "x-test-owner": "owner" } });
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.body, "evidence");
    assert.equal(owner.headers["cache-control"], "private, no-store");
    assert.match(storageCalls[0] ?? "", /^get:/);
  } finally { await app.close(); }
});

test("expired artifact is not retrieved and requests best-effort object deletion", async () => {
  const expired = { ...metadata, retainUntil: new Date(Date.now() - 1_000) };
  const { app, storageCalls } = appWithArtifact(expired);
  try {
    const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/artifacts/${artifactId}`, headers: { "x-test-owner": "owner" } });
    assert.equal(response.statusCode, 410);
    assert.deepEqual(storageCalls, [`delete:${metadata.objectKey}`]);
  } finally { await app.close(); }
});

test("expired counterexample evidence is not exposed through the findings projection", async () => {
  const expired = { ...metadata, retainUntil: new Date(Date.now() - 1_000) };
  const storageCalls: string[] = [];
  const app = buildApp({
    logger: false,
    authenticate: ownerAuth,
    campaignStore: {
      async findings(ownerId: string) { return ownerId === "owner" ? { findings: [{ counterexample: { sha256: expired.digest, bytes: expired.byteCount, steps: [], artifact: { id: expired.id } } }] } : null; },
      async getArtifact(ownerId: string) { return ownerId === "owner" ? expired : null; },
    } as never,
    artifactStorage: {
      async get(key) { storageCalls.push(`get:${key}`); return Buffer.from("evidence"); },
      async delete(key) { storageCalls.push(`delete:${key}`); },
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/campaigns/${campaignId}/counterexample`, headers: { "x-test-owner": "owner" } });
    assert.equal(response.statusCode, 410);
    assert.deepEqual(storageCalls, [`delete:${metadata.objectKey}`]);
  } finally { await app.close(); }
});
