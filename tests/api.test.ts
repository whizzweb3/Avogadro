import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, type CampaignStore } from "../apps/api/src/app.js";

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

test("campaign route requires authentication before campaign access", async () => {
  const records = new Map<string, { id: string; ownerId: string; status: string }>();
  // This store is an in-memory API contract test double, not a production persistence or scan result.
  const mockStore: CampaignStore = {
    async create(ownerId) { void ownerId; throw new Error("unauthenticated request must not create"); },
    async list(ownerId) {
      return [...records.values()].filter((record) => record.ownerId === ownerId);
    },
    async get(ownerId, id) {
      const record = records.get(id);
      return record?.ownerId === ownerId ? { id: record.id, status: record.status } : null;
    },
    async cancel() { return null; },
    async replay() { return null; },
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
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/campaigns", payload: {} });
    assert.equal(unauthenticated.statusCode, 401);

    for (const [method, url] of [["POST", "/v1/campaigns"], ["GET", "/v1/campaigns"]] as const) {
      const result = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      assert.equal(result.statusCode, 401);
    }
  } finally {
    await app.close();
  }
});
