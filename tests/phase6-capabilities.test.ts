import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionIdentity, fixtures, invariantTemplates, listInvariantTemplates, parseCounterexampleSteps, resolveInvariantTemplates, runFixtureCampaign } from "../packages/runner/src/index.js";

test("every supported invariant template maps to an actual allowlisted fixture test", () => {
  assert.ok(invariantTemplates.length > 0);
  for (const capability of invariantTemplates) {
    assert.equal(capability.fixtureId in fixtures, true, `${capability.id} must reference a trusted fixture`);
    assert.equal(fixtures[capability.fixtureId as keyof typeof fixtures].testNames.includes(capability.invariantName as never), true, `${capability.id} must reference a real Foundry test`);
    assert.equal(capability.parameters.length, 0, "templates without runner-supported parameters must not advertise any");
  }
  assert.equal(new Set(invariantTemplates.map(({ id }) => id)).size, invariantTemplates.length, "template IDs must be unique");
  const demonstrators = listInvariantTemplates("replay-counterexample-v1");
  assert(demonstrators.every((template) => template.category === "demonstrator" && /not a security finding/i.test(template.description)), "expected-failure templates must be clearly labeled as demonstrators");
  assert.equal(resolveInvariantTemplates([invariantTemplates[0]!.id], "vault-accounting-v1")[0]!.invariantName, invariantTemplates[0]!.invariantName);
});

test("selected invariant set is part of the deterministic execution identity", () => {
  const sourceDigest = "a".repeat(64);
  const base = { fixtureId: "vault-accounting-v1" as const, runs: 32, depth: 16, seed: `0x${"19".repeat(32)}` };
  const templateId = invariantTemplates[0]!.id;
  const selected = createExecutionIdentity({ ...base, templateIds: [templateId] }, sourceDigest);
  const selectedAgain = createExecutionIdentity({ ...base, templateIds: [templateId] }, sourceDigest);
  const legacy = createExecutionIdentity({ ...base, invariants: ["invariant_accountingMatchesSuccessfulActions"] }, sourceDigest);
  assert.equal(selected, selectedAgain, "same normalized template selection must produce a stable identity");
  assert.notEqual(selected, legacy, "template identity must be bound into the execution identity");
  assert.match(selected, /^[a-f0-9]{64}$/);
  assert.throws(() => createExecutionIdentity({ ...base, templateIds: [`${templateId}-unknown`] }, sourceDigest), /not supported/);
});

test("runner rejects a supported invariant attached to the wrong trusted fixture before execution", async () => {
  const result = await runFixtureCampaign({
    fixtureId: "vault-accounting-v1",
    invariants: ["invariant_replayValueRemainsZero"],
    runs: 1,
    depth: 1,
    seed: `0x${"19".repeat(32)}`,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "infrastructure_blocked");
  assert.equal(result.outcome, null);
  assert.equal(result.failureCode, "invalid_campaign_config");
  assert.match(result.stderr, /Selected test is not allowed/);
});

test("counterexample call parser preserves order and does not invent undecoded fields", () => {
  const parsed = parseCounterexampleSteps([
    "Counterexample:",
    "  [Sequence] sender=0x1111111111111111111111111111111111111111 addr=0x2222222222222222222222222222222222222222 sig=deposit(uint256) args=[5]",
    "  sender=0x3333333333333333333333333333333333333333 calldata=0x1234",
    "Suite result: FAILED",
  ].join("\n"));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    order: 0,
    sender: "0x1111111111111111111111111111111111111111",
    target: "0x2222222222222222222222222222222222222222",
    function: "deposit(uint256)",
    args: "[5]",
    raw: "[Sequence] sender=0x1111111111111111111111111111111111111111 addr=0x2222222222222222222222222222222222222222 sig=deposit(uint256) args=[5]",
  });
  assert.deepEqual(parsed[1], {
    order: 1,
    sender: "0x3333333333333333333333333333333333333333",
    raw: "sender=0x3333333333333333333333333333333333333333 calldata=0x1234",
  });
});
