import assert from "node:assert/strict";
import test from "node:test";
import type { RunInput } from "@avogadro/runner";
import { createCampaignProcessor } from "../src/processor.js";

const campaign = {
  fixtureId: "vault-accounting-v1",
  runs: 40,
  depth: 12,
  seed: `0x${"a".repeat(64)}`,
  timeoutSeconds: 25,
  selectedInvariants: ["invariant_accountingMatchesSuccessfulActions"],
  attemptNumber: 2,
};
const passingResult = { status: "completed", outcome: "passed", fixtureId: campaign.fixtureId } as const;

function fakeStore(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const store = {
    lease: async (...args: unknown[]) => { calls.push(["lease", ...args]); return { ...campaign }; },
    isCancelRequested: async () => false,
    renewLease: async () => true,
    persistResult: async (...args: unknown[]) => { calls.push(["persistResult", ...args]); return true; },
    retryInfrastructure: async (...args: unknown[]) => { calls.push(["retryInfrastructure", ...args]); return { retryScheduled: true }; },
    ...overrides,
  };
  return { store: store as never, calls };
}

test("worker ignores queue configuration and derives execution only from the leased campaign", async () => {
  const { store, calls } = fakeStore();
  let input: RunInput | undefined;
  const processor = createCampaignProcessor({ store, workerId: "test-worker", execute: async (value: RunInput) => { input = value; return passingResult as never; } });
  await processor("f1c0f0f0-1111-4111-8111-111111111111");
  assert.equal(input?.fixtureId, campaign.fixtureId);
  assert.equal(input?.runs, campaign.runs);
  assert.equal(input?.depth, campaign.depth);
  assert.equal(input?.seed, campaign.seed);
  assert.equal(input?.timeoutMs, 25_000);
  assert.deepEqual(input?.invariants, campaign.selectedInvariants);
  assert.ok(input?.cancellation instanceof AbortSignal);
  assert.equal(calls[0]?.[0], "lease");
  assert.equal(calls[0]?.[2], "test-worker");
  assert.equal(calls[1]?.[0], "persistResult");
});

test("infrastructure failures create a bounded retry through the database lifecycle", async () => {
  const { store, calls } = fakeStore();
  const blocked = { ...passingResult, status: "infrastructure_blocked", outcome: null, failureCode: "forge_version_mismatch" };
  const processor = createCampaignProcessor({ store, execute: async () => blocked as never });
  await processor("f1c0f0f0-1111-4111-8111-111111111111");
  assert.equal(calls.some(([name]) => name === "retryInfrastructure"), true);
  assert.equal(calls.some(([name]) => name === "persistResult"), false);
});

test("infrastructure retry fails the queue attempt when the database lease is no longer owned", async () => {
  const { store } = fakeStore({ retryInfrastructure: async () => null });
  const blocked = { ...passingResult, status: "infrastructure_blocked", outcome: null, failureCode: "forge_version_mismatch" };
  const processor = createCampaignProcessor({ store, execute: async () => blocked as never });
  await assert.rejects(() => processor("f1c0f0f0-1111-4111-8111-111111111111"), /lease expired/);
});

test("state-store failure aborts execution and never records it as a user cancellation", async () => {
  const { store, calls } = fakeStore({ isCancelRequested: async () => { throw new Error("db unavailable"); } });
  const processor = createCampaignProcessor({ store, cancelPollMs: 1, execute: async ({ cancellation }: RunInput) => {
    await new Promise((resolve) => cancellation?.addEventListener("abort", resolve, { once: true }));
    return { ...passingResult, status: "cancelled", outcome: null } as never;
  } });
  await assert.rejects(() => processor("f1c0f0f0-1111-4111-8111-111111111111"), /state store became unavailable/);
  assert.equal(calls.some(([name]) => name === "persistResult"), false);
});

test("graceful worker shutdown records an interruption and schedules a fresh attempt", async () => {
  const { store, calls } = fakeStore();
  const shutdown = new AbortController();
  const processor = createCampaignProcessor({ store, shutdownSignal: shutdown.signal, cancelPollMs: 60_000, execute: async ({ cancellation }: RunInput) => {
    setTimeout(() => shutdown.abort(), 1);
    await new Promise((resolve) => cancellation?.addEventListener("abort", resolve, { once: true }));
    return { ...passingResult, status: "cancelled", outcome: null } as never;
  } });
  await processor("f1c0f0f0-1111-4111-8111-111111111111");
  const retry = calls.find(([name]) => name === "retryInfrastructure");
  assert.ok(retry);
  assert.equal((retry?.[4] as Record<string, unknown>).failureCode, "worker_shutdown_interrupted");
  assert.equal(calls.some(([name]) => name === "persistResult"), false);
});
