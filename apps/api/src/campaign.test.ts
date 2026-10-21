import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, createCampaignSchema, type CampaignStore } from "./app.js";
import { createExecutionIdentity } from "@avogadro/runner";

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

test("studio, event, finding, report, and filtered history APIs are owner-scoped and bounded", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const records = new Map([[id, { id, status: "failed", outcome: "failed", fixtureId: "replay-counterexample-v1", selectedInvariants: ["invariant_replayValueRemainsZero"], seed: goodInput.seed, runs: 8, depth: 4, timeoutSeconds: 30, failureKind: "invariant_violation", failureCode: "invariant_violation", sourceDigest: "a".repeat(64), executionDigest: "b".repeat(64), buildDigest: "c".repeat(64), engineVersion: "forge-1.8.5/solc-0.8.26", createdAt: new Date("2026-01-01T00:00:00Z"), startedAt: new Date("2026-01-01T00:00:01Z"), finishedAt: new Date("2026-01-01T00:00:02Z"), attempts: [], artifacts: [] }]]);
  const store: CampaignStore = {
    async create() { return { id, status: "queued" }; },
    async list(ownerId, filter) { return ownerId === "alice" ? { items: [{ id, filter }], nextCursor: null } : { items: [], nextCursor: null }; },
    async get(ownerId, campaignId) { return ownerId === "alice" && campaignId === id ? records.get(id) ?? null : null; },
    async events(ownerId, campaignId, after, limit) { return ownerId === "alice" && campaignId === id ? { events: [{ campaignId, sequence: after + 1, eventType: "failed", payload: { status: "failed" }, createdAt: new Date().toISOString() }].slice(0, limit), nextCursor: null } : null; },
    async findings(ownerId, campaignId) { return ownerId === "alice" && campaignId === id ? { findings: [{ id: campaignId, kind: "invariant_violation", invariantNames: ["invariant_replayValueRemainsZero"], summary: "Trusted demonstrator invariant failed", counterexample: { sha256: "d".repeat(64), bytes: 80 } }] } : null; },
    async cancel() { return null; }, async replay() { return null; },
  };
  const app = buildApp({ logger: false, campaignStore: store, authenticate: async (request) => typeof request.headers["x-owner"] === "string" ? request.headers["x-owner"] : null });
  try {
    const headers = { "x-owner": "alice" };
    const templates = await app.inject({ method: "GET", url: "/v1/invariants/templates?fixtureId=vault-accounting-v1", headers });
    assert.equal(templates.statusCode, 200);
    assert.equal(templates.json().executionMode, "trusted_fixture");
    assert.equal(templates.json().templates[0].invariantName, "invariant_accountingMatchesSuccessfulActions");
    const demonstrator = await app.inject({ method: "GET", url: "/v1/invariants/templates?fixtureId=replay-counterexample-v1", headers });
    assert.equal(demonstrator.json().templates[0].category, "demonstrator");
    assert.match(demonstrator.json().templates[0].description, /deliberately fails/i);
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}/events?after=0&limit=1`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}/findings`, headers })).json().findings.length, 1);
    const report = await app.inject({ method: "GET", url: `/v1/campaigns/${id}/report`, headers });
    assert.equal(report.statusCode, 200);
    assert.match(report.json().evidenceDigest, /^[a-f0-9]{64}$/);
    const page = await app.inject({ method: "GET", url: "/v1/campaigns?fixtureId=replay-counterexample-v1&limit=1", headers });
    assert.equal(page.json().items.length, 1);
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}/report`, headers: { "x-owner": "bob" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/campaigns/${id}/events`, headers: { "x-owner": "bob" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/v1/campaigns?limit=101", headers })).statusCode, 400);
  } finally { await app.close(); }
});

test("campaign creation resolves only runner-backed template IDs", async () => {
  const createdInputs: import("@avogadro/db").CampaignCreate[] = [];
  const app = buildApp({ logger: false, campaignStore: { create: async (_owner, input) => { createdInputs.push(input); return { id: input.selectedInvariants[0]!, status: "queued" }; }, list: async () => ({ items: [], nextCursor: null }), get: async () => null, cancel: async () => null, replay: async () => null }, authenticate: async () => "alice" });
  try {
    const valid = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "idempotency-key": "template-campaign-1" }, payload: { ...goodInput, invariants: undefined, templateIds: ["vault-accounting-conservation-v1"] } });
    assert.equal(valid.statusCode, 202);
    assert.equal(valid.json().id, "invariant_accountingMatchesSuccessfulActions");
    const createdInput = createdInputs[0];
    assert.ok(createdInput);
    assert.deepEqual(createdInput.templateIds, ["vault-accounting-conservation-v1"]);
    assert.equal(createdInput.executionDigest, createExecutionIdentity({ fixtureId: createdInput.fixtureId, runs: goodInput.runs, depth: goodInput.depth, seed: goodInput.seed, templateIds: createdInput.templateIds }, createdInput.sourceDigest), "API and runner must share the exact canonical execution identity");
    const unsupported = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "idempotency-key": "template-campaign-2" }, payload: { ...goodInput, invariants: undefined, templateIds: ["balance-conservation-future"] } });
    assert.equal(unsupported.statusCode, 400);
    const demonstrator = await app.inject({ method: "POST", url: "/v1/campaigns", headers: { "idempotency-key": "template-campaign-3" }, payload: { ...goodInput, fixtureId: "replay-counterexample-v1", invariants: undefined, templateIds: ["replay-counterexample-demonstrator-v1"] } });
    assert.equal(demonstrator.statusCode, 202);
    assert.equal(demonstrator.json().id, "invariant_replayValueRemainsZero");
  } finally { await app.close(); }
});
