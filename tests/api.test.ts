import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, createCampaignSchema, type CampaignStore } from "../apps/api/src/app.js";

const hash = `0x${"a".repeat(64)}`;
const validCampaign = {
  contractId: "11111111-1111-4111-8111-111111111111",
  snapshot: { blockNumber: 1, blockHash: hash },
  harnessDigest: hash,
  buildDigest: hash,
  seed: "avogadro-fixture-seed",
  runs: 64,
  depth: 32,
  timeoutSeconds: 120,
  invariants: [{ name: "supply conserved", template: "erc20.total-supply", config: {} }],
};

test("campaign schema accepts bounded reproducible inputs", () => {
  assert.equal(createCampaignSchema.safeParse(validCampaign).success, true);
});

test("campaign schema rejects invalid digests, bounds, and empty invariants", () => {
  assert.equal(createCampaignSchema.safeParse({ ...validCampaign, harnessDigest: "0x123" }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...validCampaign, runs: 0 }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...validCampaign, invariants: [] }).success, false);
});

test("health is a liveness response", async () => {
  const app = buildApp({ logger: false });
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok", service: "api" });
  } finally {
    await app.close();
  }
});

test("contract import authenticates, validates chain, and reports unavailable storage honestly", async () => {
  const app = buildApp({ logger: false, authenticate: async () => "alice" });
  try {
    const wrongChain = await app.inject({ method: "POST", url: "/v1/contracts", payload: { chainId: 1, address: `0x${"1".repeat(40)}` } });
    assert.equal(wrongChain.statusCode, 400);
    assert.equal(wrongChain.json().error.code, "VALIDATION_ERROR");

    const valid = await app.inject({ method: "POST", url: "/v1/contracts", headers: { "idempotency-key": "qa-import-0001" }, payload: { chainId: 4663, address: `0x${"1".repeat(40)}` } });
    assert.equal(valid.statusCode, 503);
    assert.equal(valid.json().error.code, "CONTRACT_STORAGE_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("campaign routes enforce authentication and scope the explicit in-memory mock by owner", async () => {
  const records = new Map<string, { id: string; ownerId: string; status: string }>();
  // This store is an in-memory API contract test double, not a production persistence or scan result.
  const mockStore: CampaignStore = {
    async create(ownerId) {
      const result = { id: "22222222-2222-4222-8222-222222222222", status: "queued" as const };
      records.set(result.id, { ...result, ownerId });
      return result;
    },
    async list(ownerId) {
      return [...records.values()].filter((record) => record.ownerId === ownerId);
    },
    async get(ownerId, id) {
      const record = records.get(id);
      return record?.ownerId === ownerId ? { id: record.id, status: record.status } : null;
    },
  };
  const app = buildApp({
    logger: false,
    campaignStore: mockStore,
    authenticate: async (request) => {
      const userId = request.headers["x-test-user"];
      return typeof userId === "string" ? userId : null;
    },
  });
  try {
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/campaigns", payload: validCampaign });
    assert.equal(unauthenticated.statusCode, 401);

    const invalid = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-user": "alice" }, payload: { ...validCampaign, depth: 0 } });
    assert.equal(invalid.statusCode, 400);

    const created = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-test-user": "alice" }, payload: validCampaign });
    assert.equal(created.statusCode, 202);
    const id = created.json().id as string;

    const own = await app.inject({ method: "GET", url: `/v1/campaigns/${id}`, headers: { "x-test-user": "alice" } });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().status, "queued");
    const other = await app.inject({ method: "GET", url: `/v1/campaigns/${id}`, headers: { "x-test-user": "bob" } });
    assert.equal(other.statusCode, 404);
  } finally {
    await app.close();
  }
});
