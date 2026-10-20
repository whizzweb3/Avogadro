import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runFixtureCampaign } from './index.js';

test('replays the trusted invariant counterexample with stable evidence under the same seed', { skip: process.env.AVOGADRO_RUNNER_INTEGRATION !== '1' }, async () => {
  const seed = `0x${'d'.repeat(64)}`;
  const config = {
    fixtureId: 'replay-counterexample-v1' as const,
    runs: 8,
    depth: 16,
    seed,
    timeoutMs: 30_000,
  };
  const first = await runFixtureCampaign(config);
  const replay = await runFixtureCampaign(config);

  for (const result of [first, replay]) {
    assert.equal(result.status, 'failed');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureKind, 'invariant_violation');
    assert.equal(result.exitCode, 1);
    assert.ok(result.counterexample, 'Forge must emit an actual counterexample sequence');
    assert.match(result.counterexample.content, /increment\(uint8\)/);
    assert.match(result.counterexample.content, /args=\[/);
    assert.equal(result.counterexample.sha256, createHash('sha256').update(result.counterexample.content).digest('hex'));
    assert.equal(result.replayMetadata.seed, seed);
    assert.equal(result.replayMetadata.fixtureId, 'replay-counterexample-v1');
  }
  assert.equal(first.executionDigest, replay.executionDigest);
  assert.equal(first.sourceDigest, replay.sourceDigest);
  assert.equal(first.counterexample?.content, replay.counterexample?.content);
  assert.equal(first.counterexample?.sha256, replay.counterexample?.sha256);
});
