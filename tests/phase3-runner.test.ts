import assert from "node:assert/strict";
import test from "node:test";
import { runFixtureCampaign } from "../packages/runner/src/index.js";

const forge = process.env.AVOGADRO_FORGE_BIN;
const solc = process.env.AVOGADRO_SOLC_BIN;
const seed = `0x${"19".repeat(32)}`;

test("pinned Forge executes only repository-owned passing and replay fixtures", { skip: !(forge && solc) && "Set AVOGADRO_FORGE_BIN and AVOGADRO_SOLC_BIN to verified pinned tools to run fixture integration." }, async () => {
  const common = { runs: 32, depth: 16, seed, timeoutMs: 120_000 };
  const passing = await runFixtureCampaign({ ...common, fixtureId: "vault-accounting-v1" });
  assert.equal(passing.fixtureId, "vault-accounting-v1");
  assert.equal(passing.status, "completed", passing.stderr || passing.stdout);
  assert.equal(passing.outcome, "passed");
  assert.equal(passing.versions.forge, "1.8.5");
  assert.equal(passing.versions.solc, "0.8.26");
  assert.ok(passing.executionDigest);
  assert.ok(passing.buildDigest);

  const replay = await runFixtureCampaign({ ...common, fixtureId: "replay-counterexample-v1" });
  const replayAgain = await runFixtureCampaign({ ...common, fixtureId: "replay-counterexample-v1" });
  assert.equal(replay.fixtureId, "replay-counterexample-v1");
  assert.equal(replay.status, "failed");
  assert.equal(replay.outcome, "failed");
  assert.equal(replay.failureKind, "invariant_violation");
  assert.ok(replay.counterexample, "Forge should emit a counterexample sequence");
  assert.equal(replay.counterexample.bytes, Buffer.byteLength(replay.counterexample.content));
  assert.match(replay.counterexample.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(replayAgain.counterexample, replay.counterexample);
  assert.equal(replayAgain.executionDigest, replay.executionDigest);
});

test("pre-start cancellation is not reported as an invariant failure", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const result = await runFixtureCampaign({ fixtureId: "vault-accounting-v1", runs: 1, depth: 1, seed, timeoutMs: 1000, cancellation: cancellation.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.outcome, null);
  assert.notEqual(result.failureKind, "invariant_violation");
});
