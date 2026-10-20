import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, createCampaignSchema, type CampaignStore } from "./app.js";

const goodInput = {
  fixtureId: "vault-accounting-v1" as const,
  invariants: ["invariant_accountingMatchesSuccessfulActions" as const],
  seed: `0x${"a".repeat(64)}`,
  runs: 64,
  depth: 32,
  timeoutSeconds: 120,
};

test("campaign input is fixture-bound, deterministic, and bounded to runner limits", () => {
  assert.equal(createCampaignSchema.safeParse(goodInput).success, true);
  assert.equal(createCampaignSchema.safeParse({ ...goodInput, runs: 10001 }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...goodInput, depth: 513 }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...goodInput, seed: "seed" }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...goodInput, contractId: "00000000-0000-4000-8000-000000000000" }).success, false);
  assert.equal(createCampaignSchema.safeParse({ ...goodInput, fixtureId: "replay-counterexample-v1", invariants: ["invariant_replayValueRemainsZero"] }).success, true);
});

test("campaign API requires an owner and idempotency key and scopes reads, cancel, and replay", async () => {
  const records = new Map<string, { id: string; owner: string; status: "queued" | "running" | "cancelled" }>();
  let next = 0;
  const store: CampaignStore = {
    async create(ownerId) { const id = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`; records.set(id, { id, owner: ownerId, status: "queued" }); return { id, status: "queued" }; },
    async list(ownerId) { return [...records.values()].filter((item) => item.owner === ownerId); },
    async get(ownerId, id) { const item = records.get(id); return item?.owner === ownerId ? { id, status: item.status, attempts: [], events: [] } : null; },
    async cancel(ownerId, id) {
      const item = records.get(id);
      if (!item || item.owner !== ownerId) return null;
      if (item.status === "queued") item.status = "cancelled";
      return { id, status: item.status, cancelRequestedAt: new Date().toISOString() };
    },
    async replay(ownerId, id) { if (records.get(id)?.owner !== ownerId) return null; const replayId = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`; records.set(replayId, { id: replayId, owner: ownerId, status: "queued" }); return { id: replayId, replayOf: id, status: "queued" }; },
  };
  const app = buildApp({ logger: false, campaignStore: store, authenticate: async (request) => typeof request.headers["x-owner"] === "string" ? request.headers["x-owner"] : null });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/v1/campaigns", payload: goodInput })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-owner": "alice" }, payload: goodInput })).statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "x-owner": "alice", "idempotency-key": "campaign-0001" }, payload: goodInput });
    assert.equal(created.statusCode, 202);
    const id = created.json<{ id: string }>().id;
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}`, headers: { "x-owner": "bob" } })).statusCode, 404);
    const queuedCancel = await app.inject({ method: "POST", url: `/v1/campaigns/${id}/cancel`, headers: { "x-owner": "alice" } });
    assert.equal(queuedCancel.statusCode, 200);
    assert.equal(queuedCancel.json().status, "cancelled");
    const runningId = "00000000-0000-4000-8000-999999999999";
    records.set(runningId, { id: runningId, owner: "alice", status: "running" });
    const runningCancel = await app.inject({ method: "POST", url: `/v1/campaigns/${runningId}/cancel`, headers: { "x-owner": "alice" } });
    assert.equal(runningCancel.statusCode, 200);
    assert.equal(runningCancel.json().status, "running");
    assert.ok(runningCancel.json().cancelRequestedAt);
    const replay = await app.inject({ method: "POST", url: `/v1/campaigns/${id}/replay`, headers: { "x-owner": "alice" } });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().replayOf, id);
    assert.equal((await app.inject({ method: "POST", url: `/v1/campaigns/${id}/replay`, headers: { "x-owner": "bob" } })).statusCode, 404);
  } finally { await app.close(); }
});
