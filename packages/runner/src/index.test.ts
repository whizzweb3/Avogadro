import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('timeout kills POSIX process-group descendants after the Forge leader exits', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'avogadro-runner-process-tree-'));
  const forge = path.join(base, 'forge.mjs');
  const solc = path.join(base, 'solc.mjs');
  const childPidFile = path.join(base, 'descendant.pid');
  const forgePidFile = path.join(base, 'forge.pid');
  const previousForge = process.env.AVOGADRO_FORGE_BIN;
  const previousSolc = process.env.AVOGADRO_SOLC_BIN;
  const node = process.execPath;
  try {
    await writeFile(forge, `#!${node}\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === '--version') { console.log('Version: 1.8.5'); process.exit(0); }\nwriteFileSync(${JSON.stringify(forgePidFile)}, String(process.pid));\nconst child = spawn(process.execPath, ['-e', 'process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nwriteFileSync(${JSON.stringify(childPidFile)}, String(child.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    await writeFile(solc, `#!${node}\nif (process.argv[2] === '--version') console.log('Version: 0.8.26+commit.8a97fa7a');\n`, { mode: 0o755 });
    process.env.AVOGADRO_FORGE_BIN = forge;
    process.env.AVOGADRO_SOLC_BIN = solc;
    const result = await runFixtureCampaign({
      fixtureId: 'vault-accounting-v1',
      runs: 1,
      depth: 1,
      seed: `0x${'1'.repeat(64)}`,
      timeoutMs: 1000,
    });
    assert.equal(result.failureCode, 'timeout');
    const pid = Number(await readFile(childPidFile, 'utf8'));
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 25)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, `descendant process ${pid} survived process-group cleanup`);
  } finally {
    try {
      const forgePid = Number(await readFile(forgePidFile, 'utf8'));
      process.kill(-forgePid, 'SIGKILL');
    } catch { /* the process group was already cleaned up */ }
    if (previousForge === undefined) delete process.env.AVOGADRO_FORGE_BIN;
    else process.env.AVOGADRO_FORGE_BIN = previousForge;
    if (previousSolc === undefined) delete process.env.AVOGADRO_SOLC_BIN;
    else process.env.AVOGADRO_SOLC_BIN = previousSolc;
    await rm(base, { recursive: true, force: true });
  }
});
