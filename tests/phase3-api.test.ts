import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import { buildApp, type AuthStore, type CampaignStore } from "../apps/api/src/app.js";
import type { CampaignCreate } from "@avogadro/db";

const id = "22222222-2222-4222-8222-222222222222";
const bobId = "44444444-4444-4444-8444-444444444444";
const replayId = "33333333-3333-4333-8333-333333333333";
const seed = `0x${"ab".repeat(32)}`;
const campaignInput = {
  fixtureId: "vault-accounting-v1",
  invariants: ["invariant_accountingMatchesSuccessfulActions"],
  seed,
  runs: 64,
  depth: 32,
  timeoutSeconds: 30,
};

type RecordValue = { id: string; ownerId: string; status: string; config: CampaignCreate; cancelRequestedAt?: string; parentCampaignId?: string };

/** Route contract double only; persistence/transaction behavior belongs to PostgreSQL integration tests. */
function campaignStore(): CampaignStore {
  const records = new Map<string, RecordValue>();
  const keys = new Map<string, { digest: string; id: string }>();
  return {
    async create(ownerId, config, key) {
      const digest = JSON.stringify(config);
      const keyId = `${ownerId}:${key}`;
      const prior = keys.get(keyId);
      if (prior) {
        if (prior.digest !== digest) throw Object.assign(new Error("Idempotency key was used with different campaign configuration"), { statusCode: 409 });
        return { id: prior.id, status: "queued" as const };
      }
      const recordId = ownerId === "bob" ? bobId : id;
      const record = { id: recordId, ownerId, status: "queued", config };
      records.set(recordId, record);
      keys.set(keyId, { digest, id: recordId });
      return { id: recordId, status: "queued" as const };
    },
    async list(ownerId) { return [...records.values()].filter((record) => record.ownerId === ownerId); },
    async get(ownerId, campaignId) {
      const record = records.get(campaignId);
      return record?.ownerId === ownerId ? record : null;
    },
    async cancel(ownerId, campaignId) {
      const record = records.get(campaignId);
      if (!record || record.ownerId !== ownerId) return null;
      if (!["completed", "failed", "cancelled", "infrastructure_blocked"].includes(record.status)) {
        record.cancelRequestedAt ??= new Date(0).toISOString();
        if (record.status === "queued") record.status = "cancelled";
      }
      return { id: record.id, status: record.status, cancelRequestedAt: record.cancelRequestedAt ?? null };
    },
    async replay(ownerId, campaignId) {
      const source = records.get(campaignId);
      if (!source || source.ownerId !== ownerId) return null;
      records.set(replayId, { id: replayId, ownerId, status: "queued", config: source.config, parentCampaignId: campaignId });
      return { id: replayId, replayOf: campaignId, status: "queued" as const };
    },
  };
}

const testAuth = async (request: import("fastify").FastifyRequest) => {
  const owner = request.headers["x-test-owner"];
  return typeof owner === "string" ? owner : null;
};

test("campaign routes fail closed without authenticated SIWE session", async () => {
  const app = buildApp({ logger: false, campaignStore: campaignStore() });
  try {
    const requests = [
      app.inject({ method: "POST", url: "/v1/campaigns", headers: { "idempotency-key": "campaign-key-001" }, payload: campaignInput }),
      app.inject({ method: "GET", url: "/v1/campaigns" }),
      app.inject({ method: "GET", url: `/v1/campaigns/${id}` }),
      app.inject({ method: "POST", url: `/v1/campaigns/${id}/cancel` }),
      app.inject({ method: "POST", url: `/v1/campaigns/${id}/replay` }),
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, "UNAUTHENTICATED");
    }
  } finally { await app.close(); }
});

test("SIWE session cookie authenticates reads and requires its matching CSRF token for mutations", async () => {
  const sessionToken = "test-session-token";
  const csrfToken = "test-csrf-token";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const authStore: AuthStore = {
    async issueNonce() {},
    async consumeNonce() { return false; },
    async createSession() { throw new Error("not used in this session guard test"); },
    async getSession(tokenHash) {
      return tokenHash === hash(sessionToken) ? { userId: "alice", csrfHash: hash(csrfToken), expiresAt: new Date(Date.now() + 60_000), revokedAt: null } : null;
    },
    async revokeSession() {},
  };
  let creates = 0;
  const base = campaignStore();
  const store: CampaignStore = { ...base, async create(...args) { creates++; return base.create(...args); } };
  const app = buildApp({ logger: false, campaignStore: store, authStore, siweConfig: { domain: "localhost", uri: "http://localhost", chainId: 4663 } });
  const cookies = `avogadro_session=${sessionToken}; avogadro_csrf=${csrfToken}`;
  try {
    const session = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: cookies } });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().ownerId, "alice");

    for (const csrf of [undefined, "wrong-csrf-token"]) {
      const response = await app.inject({
        method: "POST", url: "/v1/campaigns",
        headers: { cookie: cookies, "idempotency-key": "campaign-key-csrf" , ...(csrf ? { "x-csrf-token": csrf } : {}) },
        payload: campaignInput,
      });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(creates, 0);

    const accepted = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { cookie: cookies, "x-csrf-token": csrfToken, "idempotency-key": "campaign-key-csrf" }, payload: campaignInput });
    assert.equal(accepted.statusCode, 202);
    assert.equal(creates, 1);
  } finally { await app.close(); }
});

test("SIWE verifier accepts a signed Robinhood Chain message and enforces domain, URI, chain, age, and one-use nonce", async () => {
  const wallet = Wallet.createRandom();
  const expected = { domain: "localhost", uri: "http://localhost", chainId: 4663 as const };
  const issued = new Map<string, { domain: string; chainId: number; expiresAt: Date }>();
  const consumed = new Set<string>();
  const createdSessions: Array<{ address: string; tokenHash: string; csrfHash: string }> = [];
  const authStore: AuthStore = {
    async issueNonce(nonce, domain, chainId, expiresAt) { issued.set(nonce, { domain, chainId, expiresAt }); },
    async consumeNonce(nonce, domain, chainId) {
      const record = issued.get(nonce);
      if (!record || record.domain !== domain || record.chainId !== chainId || record.expiresAt <= new Date() || consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
    async createSession(address, tokenHash, csrfHash) { createdSessions.push({ address, tokenHash, csrfHash }); return "session-id"; },
    async getSession() { return null; },
    async revokeSession() {},
  };
  const app = buildApp({ logger: false, authStore, siweConfig: expected });
  try {
    const nonceResponse = await app.inject({ method: "GET", url: "/v1/auth/nonce" });
    assert.equal(nonceResponse.statusCode, 200);
    const nonce = nonceResponse.json().nonce as string;
    assert.equal(nonceResponse.json().chainId, 4663);

    const makeSignedMessage = async (overrides: Partial<ConstructorParameters<typeof SiweMessage>[0]> = {}) => {
      const message = new SiweMessage({
        domain: expected.domain,
        address: wallet.address,
        statement: "Sign in to AVOGADRO.",
        uri: expected.uri,
        version: "1",
        chainId: expected.chainId,
        nonce,
        issuedAt: new Date().toISOString(),
        ...overrides,
      });
      const serialized = message.prepareMessage();
      return { message: serialized, signature: await wallet.signMessage(serialized) };
    };

    for (const altered of [
      { domain: "attacker.example" },
      { uri: "https://attacker.example" },
      { chainId: 1 },
    ]) {
      const signed = await makeSignedMessage(altered);
      const rejected = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: signed });
      assert.equal(rejected.statusCode, 401);
      assert.equal(rejected.json().error.code, "SIWE_INVALID");
    }
    assert.equal(consumed.size, 0, "misbound messages must not consume the valid nonce");

    const stale = await makeSignedMessage({ issuedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    const staleResponse = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: stale });
    assert.equal(staleResponse.statusCode, 401);
    assert.equal(consumed.size, 0, "stale messages must not consume the valid nonce");

    const valid = await makeSignedMessage();
    const accepted = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: valid });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().authenticated, true);
    assert.equal(accepted.json().address.toLowerCase(), wallet.address.toLowerCase());
    assert.match(accepted.headers["set-cookie"]?.toString() ?? "", /avogadro_session=.*HttpOnly/);
    assert.equal(createdSessions.length, 1);
    assert.equal(createdSessions[0]?.address.toLowerCase(), wallet.address.toLowerCase());

    const replay = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: valid });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, "SIWE_INVALID");
    assert.equal(createdSessions.length, 1, "replayed nonce must not create another session");
  } finally { await app.close(); }
});

test("SIWE nonce and verify endpoints enforce independent per-IP minute limits", async () => {
  let issued = 0;
  const authStore: AuthStore = {
    async issueNonce() { issued++; },
    async consumeNonce() { return false; },
    async createSession() { throw new Error("not used by rate-limit test"); },
    async getSession() { return null; },
    async revokeSession() {},
  };
  const app = buildApp({ logger: false, authStore, siweConfig: { domain: "localhost", uri: "http://localhost", chainId: 4663 } });
  try {
    for (let request = 0; request < 30; request++) {
      assert.equal((await app.inject({ method: "GET", url: "/v1/auth/nonce" })).statusCode, 200);
    }
    const nonceLimited = await app.inject({ method: "GET", url: "/v1/auth/nonce" });
    assert.equal(nonceLimited.statusCode, 429);
    assert.equal(nonceLimited.json().error.code, "AUTH_RATE_LIMITED");
    assert.equal(issued, 30, "rate-limited requests must not issue additional nonces");

    for (let request = 0; request < 15; request++) {
      assert.equal((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: {} })).statusCode, 400);
    }
    const verifyLimited = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: {} });
    assert.equal(verifyLimited.statusCode, 429);
    assert.equal(verifyLimited.json().error.code, "AUTH_RATE_LIMITED");
  } finally { await app.close(); }
});

test("campaign lifecycle routes enforce ownership and replay the exact source configuration", async () => {
  const store = campaignStore();
  const app = buildApp({ logger: false, campaignStore: store, authenticate: testAuth });
  const alice = { "x-test-owner": "alice" };
  const bob = { "x-test-owner": "bob" };
  try {
    const created = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { ...alice, "idempotency-key": "campaign-key-001" }, payload: campaignInput });
    assert.equal(created.statusCode, 202);
    assert.deepEqual(created.json(), { id, status: "queued" });

    const listing = await app.inject({ method: "GET", url: "/v1/campaigns", headers: alice });
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.json().length, 1);
    assert.equal((await app.inject({ method: "GET", url: "/v1/campaigns", headers: bob })).json().length, 0);
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}`, headers: bob })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/campaigns/${id}/cancel`, headers: bob })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/campaigns/${id}/replay`, headers: bob })).statusCode, 404);

    const own = await app.inject({ method: "GET", url: `/v1/campaigns/${id}`, headers: alice });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().config.fixtureId, "vault-accounting-v1");
    assert.equal(own.json().config.seed, seed);

    const cancel = await app.inject({ method: "POST", url: `/v1/campaigns/${id}/cancel`, headers: alice });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().status, "cancelled");
    assert.ok(cancel.json().cancelRequestedAt);

    const replay = await app.inject({ method: "POST", url: `/v1/campaigns/${id}/replay`, headers: alice, payload: { seed: `0x${"00".repeat(32)}`, runs: 999 } });
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json(), { id: replayId, replayOf: id, status: "queued" });
    const replayRecord = await app.inject({ method: "GET", url: `/v1/campaigns/${replayId}`, headers: alice });
    assert.deepEqual(replayRecord.json().config, own.json().config);
  } finally { await app.close(); }
});

test("campaign creation validates fixture pairing and bounded input before persistence", async () => {
  let createCalls = 0;
  const base = campaignStore();
  const store: CampaignStore = { ...base, async create(...args) { createCalls++; return base.create(...args); } };
  const app = buildApp({ logger: false, campaignStore: store, authenticate: testAuth });
  try {
    const invalids = [
      { ...campaignInput, runs: 0 },
      { ...campaignInput, timeoutSeconds: 301 },
      { ...campaignInput, seed: "0x12" },
      { ...campaignInput, fixtureId: "vault-accounting-v1", invariants: ["invariant_replayValueRemainsZero"] },
      { ...campaignInput, fixtureId: "../../arbitrary-source", invariants: ["invariant_replayValueRemainsZero"] },
    ];
    for (const payload of invalids) {
      const response = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { ...{ "x-test-owner": "alice" }, "idempotency-key": "campaign-key-002" }, payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(createCalls, 0);
    const missingKey = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "alice" }, payload: campaignInput });
    assert.equal(missingKey.statusCode, 400);
    assert.equal(createCalls, 0);
  } finally { await app.close(); }
});

test("campaign idempotency is owner-scoped and rejects changed canonical input", async () => {
  const app = buildApp({ logger: false, campaignStore: campaignStore(), authenticate: testAuth });
  try {
    const first = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "alice", "idempotency-key": "campaign-key-003" }, payload: campaignInput });
    const same = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "alice", "idempotency-key": "campaign-key-003" }, payload: campaignInput });
    assert.equal(first.json().id, same.json().id);
    const conflict = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "alice", "idempotency-key": "campaign-key-003" }, payload: { ...campaignInput, runs: 65 } });
    assert.equal(conflict.statusCode, 409);
    const otherOwner = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "bob", "idempotency-key": "campaign-key-003" }, payload: campaignInput });
    assert.equal(otherOwner.statusCode, 202);
    assert.notEqual(otherOwner.json().id, first.json().id);
  } finally { await app.close(); }
});

test("missing persistence or queue reports infrastructure unavailable, not a campaign result", async () => {
  const app = buildApp({ logger: false, authenticate: testAuth });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-owner": "alice", "idempotency-key": "campaign-key-004" }, payload: campaignInput });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "CAMPAIGN_SERVICE_UNAVAILABLE");
    assert.equal(response.json().outcome, undefined);
  } finally { await app.close(); }
});
