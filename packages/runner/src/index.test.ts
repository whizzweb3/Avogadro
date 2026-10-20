import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionIdentity, parseForgeOutcome, runFixtureCampaign } from './index.js';

const passing = 'Ran 1 test for test/passing/VaultInvariant.t.sol:VaultInvariantTest\n[PASS] invariant_accountingMatchesSuccessfulActions() (runs: 3, calls: 24, reverts: 0)\nSuite result: ok. 1 passed; 0 failed; 0 skipped; finished in 1ms';

test('execution identity is stable and sorts selected invariant names', () => {
  const first = createExecutionIdentity({ fixtureId: 'vault-accounting-v1', runs: 128, depth: 32, seed: `0x${'a'.repeat(64)}`, invariants: ['b', 'a'] }, 'source-hash');
  const second = createExecutionIdentity({ fixtureId: 'vault-accounting-v1', runs: 128, depth: 32, seed: `0x${'A'.repeat(64)}`, invariants: ['a', 'b'] }, 'source-hash');
  assert.equal(first, second);
  assert.notEqual(first, createExecutionIdentity({ fixtureId: 'vault-accounting-v1', runs: 128, depth: 33, seed: `0x${'a'.repeat(64)}`, invariants: ['a', 'b'] }, 'source-hash'));
});

test('Forge parser only reports passing when a passing suite summary is present', () => {
  assert.equal(parseForgeOutcome(passing, 0).outcome, 'passed');
  assert.equal(parseForgeOutcome('[PASS] test()\nforge unexpectedly exited', 0).recognized, false);
});

test('Forge parser identifies failing invariant and preserves emitted replay evidence only', () => {
  const output = 'Ran 1 test for test/passing/VaultInvariant.t.sol:VaultInvariantTest\n[FAIL: assertion failed] invariant_accountingMatchesSuccessfulActions() (runs: 1, calls: 3)\nCounterexample:\n  calldata: 0x1234\nSuite result: FAILED. 0 passed; 1 failed; 0 skipped';
  const result = parseForgeOutcome(output, 1);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failureKind, 'invariant_violation');
  assert.match(result.counterexample ?? '', /0x1234/);
  assert.equal(parseForgeOutcome('Suite result: ok. 1 passed; 0 failed; 0 skipped', 0).counterexample, undefined);
});

test('expected failure fixture is categorized as an invariant violation, without invented replay data', () => {
  const result = parseForgeOutcome('Suite result: FAILED. 0 passed; 1 failed; 0 skipped\n[FAIL: panic: assertion failed] invariant_replayValueRemainsZero() (runs: 1, calls: 1)', 1);
  assert.equal(result.failureKind, 'invariant_violation');
  assert.equal(result.counterexample, undefined);
});

test('unsupported scratch root fails closed without spawning Foundry', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'avogadro-runner-test-'));
  const file = path.join(base, 'not-a-directory');
  await writeFile(file, '');
  try {
    const result = await runFixtureCampaign({
      fixtureId: 'vault-accounting-v1',
      runs: 1,
      depth: 1,
      seed: `0x${'0'.repeat(64)}`,
      timeoutMs: 1000,
    }, { testScratchRoot: file });
    assert.equal(result.status, 'infrastructure_blocked');
    assert.equal(result.failureCode, 'runner_setup_failed');
    assert.match(result.stderr, /scratchRoot must be a directory/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('malformed and unknown fixture input returns a bounded blocked result', async () => {
  const malformed = await runFixtureCampaign(undefined as never);
  assert.equal(malformed.status, 'infrastructure_blocked');
  assert.equal(malformed.failureCode, 'invalid_campaign_config');
  assert.equal(malformed.fixtureId, null);

  const unknown = await runFixtureCampaign({ fixtureId: 'untrusted' as never, runs: 1, depth: 1, seed: '0x' + '0'.repeat(64), timeoutMs: 1000 });
  assert.equal(unknown.status, 'infrastructure_blocked');
  assert.equal(unknown.failureCode, 'invalid_campaign_config');
  assert.equal(unknown.fixtureId, null);
});
