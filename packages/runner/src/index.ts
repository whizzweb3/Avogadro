import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_VERSION = '0.1.0';
export const FORGE_VERSION = '1.8.5';
export const SOLC_VERSION = '0.8.26';
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_ROOT = path.resolve(PACKAGE_DIR, '../contracts');

export const fixtures = {
  'vault-accounting-v1': {
    version: '1.0.0',
    profile: 'default',
    testPath: 'test/passing',
    testNames: ['invariant_accountingMatchesSuccessfulActions'],
    kind: 'invariant',
  },
  'replay-counterexample-v1': {
    version: '1.0.0',
    profile: 'expected-failure',
    testPath: 'test/expected-failure',
    testNames: ['invariant_replayValueRemainsZero'],
    kind: 'invariant',
  },
} as const;

export type FixtureId = keyof typeof fixtures;
export type RunInput = {
  fixtureId: FixtureId;
  runs: number;
  depth: number;
  seed: string;
  timeoutMs: number;
  invariants?: string[];
  cancellation?: AbortSignal;
};
export type RunnerOptions = { /** Test-only override. Ignored unless NODE_ENV=test. */ testScratchRoot?: string };
export type ArtifactManifest = { name: string; sha256: string; bytes: number; content: string };
export type RunResult = {
  fixtureId: FixtureId | null;
  executionDigest: string;
  status: 'completed' | 'failed' | 'cancelled' | 'infrastructure_blocked';
  outcome: 'passed' | 'failed' | null;
  failureKind?: 'invariant_violation' | 'assertion_failure' | 'timeout' | 'cancelled' | 'infrastructure';
  failureCode?: string;
  exitCode: number | null;
  seed: string;
  versions: { forge: string; solc: string; runner: string; fixture: string };
  sourceDigest: string;
  buildDigest: string;
  replayMetadata: { fixtureId: FixtureId | null; fixtureVersion: string; runs: number; depth: number; seed: string; invariants: string[]; forgeVersion: string; solcVersion: string; runnerVersion: string; sourceDigest: string; buildDigest: string };
  effectiveLimits: { runs: number; depth: number; timeoutMs: number; outputBytesPerStream: number };
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
  artifacts: ArtifactManifest[];
  counterexample?: { sha256: string; bytes: number; content: string };
};

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createExecutionIdentity(input: Pick<RunInput, 'fixtureId' | 'runs' | 'depth' | 'seed' | 'invariants'>, sourceDigest: string): string {
  const fixture = fixtures[input.fixtureId];
  if (!fixture) throw new Error('Unknown fixture ID');
  const invariants = [...(input.invariants ?? fixture.testNames)].sort();
  return sha256(canonical({
    fixtureId: input.fixtureId,
    fixtureVersion: fixture.version,
    invariants,
    runs: input.runs,
    depth: input.depth,
    seed: input.seed.toLowerCase(),
    forgeVersion: FORGE_VERSION,
    solcVersion: SOLC_VERSION,
    runnerVersion: RUNNER_VERSION,
    sourceDigest,
  }));
}

async function digestDirectory(root: string, includeGenerated = false): Promise<string> {
  const files: string[] = [];
  async function collect(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ((!includeGenerated && (entry.name === 'out' || entry.name === 'cache')) || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Fixture source tree may not contain symlinks');
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await collect(root);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

type Captured = { text: string; truncated: boolean };
function capture(stream: NodeJS.ReadableStream | null, limit: number): Promise<Captured> {
  return new Promise((resolve) => {
    if (!stream) return resolve({ text: '', truncated: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - bytes;
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) truncated = true;
    });
    stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }));
    stream.on('error', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }));
  });
}

async function stopProcess(child: ChildProcess, graceMs = 500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* process exited between check and signal */ }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* process exited between checks */ }
  }
}

async function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, cancellation?: AbortSignal): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Captured; stderr: Captured; timedOut: boolean; cancelled: boolean; spawnError?: Error }> {
  if (cancellation?.aborted) return { code: null, signal: null, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, cancelled: true };
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  } catch (error) {
    return { code: null, signal: null, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, cancelled: false, spawnError: error as Error };
  }
  const stdoutPromise = capture(child.stdout, MAX_OUTPUT_BYTES);
  const stderrPromise = capture(child.stderr, MAX_OUTPUT_BYTES);
  let timedOut = false;
  let cancelled = false;
  let spawnError: Error | undefined;
  let killPromise: Promise<void> | undefined;
  const onAbort = () => { cancelled = true; killPromise ??= stopProcess(child); };
  cancellation?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; killPromise ??= stopProcess(child); }, timeoutMs);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => { spawnError = error; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  cancellation?.removeEventListener('abort', onAbort);
  await killPromise;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { ...result, stdout, stderr, timedOut, cancelled, ...(spawnError ? { spawnError } : {}) };
}

export function parseForgeOutcome(output: string, exitCode: number | null): { outcome: 'passed' | 'failed' | null; failureKind?: 'invariant_violation' | 'assertion_failure'; failureCode?: string; counterexample?: string; recognized: boolean } {
  const failedSummary = /Suite result:\s*FAILED|Ran \d+ test suite in [\s\S]*?:\s*\d+ tests? passed,\s*[1-9]\d* failed/i.test(output)
    || /\[FAIL(?:\s*:\s*[^\]]+)?\]/i.test(output);
  const passedSummary = output.match(/(?:Suite result:\s*ok\.\s*\d+ passed;\s*0 failed|\b\d+ tests? passed,\s*0 failed)/i);
  const counterexample = /(?:Counterexample:|\[Sequence\])[\s\S]*?(?=\n(?:Suite result:|Ran \d+ test suite|╭|$))/i.exec(output)?.[0];
  if (failedSummary) {
    const isInvariant = /\binvariant_[A-Za-z0-9_]+\b/i.test(output) || /\binvariant"\s*:/i.test(output);
    return { outcome: 'failed', failureKind: isInvariant ? 'invariant_violation' : 'assertion_failure', failureCode: isInvariant ? 'invariant_violation' : 'assertion_failure', ...(counterexample ? { counterexample } : {}), recognized: true };
  }
  if (passedSummary && exitCode === 0) return { outcome: 'passed', recognized: true };
  return { outcome: null, recognized: false };
}

function artifact(name: string, content: string): ArtifactManifest {
  const bytes = Buffer.byteLength(content);
  return { name, sha256: sha256(content), bytes, content };
}

function validate(input: RunInput): void {
  if (!input || !(input.fixtureId in fixtures)) throw new Error('Unknown fixture ID');
  if (!Number.isInteger(input.runs) || input.runs < 1 || input.runs > 10_000) throw new Error('runs must be an integer from 1 to 10000');
  if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 512) throw new Error('depth must be an integer from 1 to 512');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > MAX_TIMEOUT_MS) throw new Error('timeoutMs must be from 1000 to 300000');
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.seed)) throw new Error('seed must be a 32-byte hex value');
  const permitted = fixtures[input.fixtureId].testNames as readonly string[];
  const selection = input.invariants ?? permitted;
  if (!Array.isArray(selection) || selection.length === 0 || selection.some((name) => !permitted.includes(name)) || new Set(selection).size !== selection.length) throw new Error('Selected test is not allowed for this fixture');
}

async function toolPath(variable: string, defaultPath: string): Promise<string> {
  const configured = process.env[variable] ?? defaultPath;
  if (!path.isAbsolute(configured)) throw new Error(`${variable} must be an absolute deployment-configured path`);
  const resolved = await realpath(configured);
  if (!(await stat(resolved)).isFile()) throw new Error(`${variable} must point to a file`);
  return resolved;
}

async function isolatedEnv(scratch: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: scratch,
    TMPDIR: scratch,
    FOUNDRY_OFFLINE: 'true',
    FOUNDRY_DISABLE_NIGHTLY_WARNING: 'true',
    FOUNDRY_INVARIANT_FAIL_ON_REVERT: 'true',
    FOUNDRY_INVARIANT_WORKERS: '1',
  };
  if (process.env.AVOGADRO_FORGE_LIBRARY_PATH && path.isAbsolute(process.env.AVOGADRO_FORGE_LIBRARY_PATH)) {
    if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = process.env.AVOGADRO_FORGE_LIBRARY_PATH;
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = process.env.AVOGADRO_FORGE_LIBRARY_PATH;
  }
  return env;
}

async function blocked(input: Partial<RunInput> | null | undefined, code: string, message: string, startedAt: string, digest = ''): Promise<RunResult> {
  const fixtureId = input?.fixtureId && input.fixtureId in fixtures ? input.fixtureId : null;
  const fixture = fixtureId ? fixtures[fixtureId] : undefined;
  const runs = Number.isInteger(input?.runs) ? input?.runs as number : 0;
  const depth = Number.isInteger(input?.depth) ? input?.depth as number : 0;
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input?.timeoutMs as number : 0;
  const seed = typeof input?.seed === 'string' ? input.seed.slice(0, 66) : '';
  const invariants = Array.isArray(input?.invariants) ? input.invariants.filter((name): name is string => typeof name === 'string').slice(0, 16) : [...(fixture?.testNames ?? [])];
  const finishedAt = new Date().toISOString();
  const stdout = '';
  const stderr = message.slice(0, MAX_OUTPUT_BYTES);
  return {
    fixtureId,
    executionDigest: digest,
    status: 'infrastructure_blocked',
    outcome: null,
    failureKind: 'infrastructure',
    failureCode: code,
    exitCode: null,
    seed,
    versions: { forge: FORGE_VERSION, solc: SOLC_VERSION, runner: RUNNER_VERSION, fixture: fixture?.version ?? 'unknown' },
    sourceDigest: '',
    buildDigest: '',
    replayMetadata: { fixtureId, fixtureVersion: fixture?.version ?? 'unknown', runs, depth, seed, invariants, forgeVersion: FORGE_VERSION, solcVersion: SOLC_VERSION, runnerVersion: RUNNER_VERSION, sourceDigest: '', buildDigest: '' },
    effectiveLimits: { runs, depth, timeoutMs, outputBytesPerStream: MAX_OUTPUT_BYTES },
    startedAt,
    finishedAt,
    stdout,
    stderr,
    artifacts: [artifact('stderr.txt', stderr)],
  };
}

/** Runs one compiled-in repository fixture with no request-controlled commands, paths, RPCs, or env. */
export async function runFixtureCampaign(input: RunInput, options: RunnerOptions = {}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  try { validate(input); } catch (error) {
    return blocked(input, 'invalid_campaign_config', (error as Error).message, startedAt);
  }
  if (input.cancellation?.aborted) {
    const result = await blocked(input, 'cancelled_before_start', 'Cancellation was requested before execution.', startedAt);
    return { ...result, status: 'cancelled', outcome: null, failureKind: 'cancelled', failureCode: undefined };
  }

  const fixture = fixtures[input.fixtureId];
  const fixtureRoot = await realpath(CONTRACTS_ROOT);
  const selectedPath = await realpath(path.join(fixtureRoot, fixture.testPath));
  if (!selectedPath.startsWith(`${fixtureRoot}${path.sep}`)) return blocked(input, 'fixture_path_invalid', 'Fixture path escaped trusted root.', startedAt);
  const sourceDigest = await digestDirectory(fixtureRoot);
  const executionDigest = createExecutionIdentity(input, sourceDigest);
  let scratch = '';
  try {
    if (options.testScratchRoot && process.env.NODE_ENV !== 'test') throw new Error('testScratchRoot is available only in NODE_ENV=test');
    const configuredScratch = options.testScratchRoot ?? process.env.AVOGADRO_RUNNER_SCRATCH_ROOT;
    if (configuredScratch && !path.isAbsolute(configuredScratch)) throw new Error('Runner scratch path must be absolute');
    const scratchBase = configuredScratch ? await realpath(configuredScratch) : tmpdir();
    if (!(await stat(scratchBase)).isDirectory()) throw new Error('scratchRoot must be a directory');
    scratch = await mkdtemp(path.join(scratchBase, 'avogadro-run-'));
    await mkdir(path.join(scratch, 'home'), { recursive: true });
    const isolatedContracts = path.join(scratch, 'contracts');
    await cp(fixtureRoot, isolatedContracts, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(fixtureRoot, source);
        if (!relative) return true;
        return !relative.split(path.sep).some((part) => part === 'out' || part === 'cache' || part === 'node_modules' || part.startsWith('.'));
      },
      dereference: false,
    });
    const forge = await toolPath('AVOGADRO_FORGE_BIN', '/usr/local/bin/forge');
    const solc = await toolPath('AVOGADRO_SOLC_BIN', '/usr/local/bin/solc');
    const env = await isolatedEnv(path.join(scratch, 'home'));
    const versionEnv = { ...env, HOME: path.join(scratch, 'home') };
    const forgeVersion = await runCommand(forge, ['--version'], isolatedContracts, versionEnv, 5000, input.cancellation);
    if (forgeVersion.cancelled || input.cancellation?.aborted) return { ...(await blocked(input, 'cancelled_before_execution', 'Cancellation was requested during version validation.', startedAt, executionDigest)), status: 'cancelled', failureKind: 'cancelled', failureCode: 'cancelled' };
    if (forgeVersion.code !== 0 || !forgeVersion.stdout.text.includes(`Version: ${FORGE_VERSION}`)) return blocked(input, 'forge_version_mismatch', `Expected Forge ${FORGE_VERSION}.`, startedAt, executionDigest);
    const solcVersion = await runCommand(solc, ['--version'], isolatedContracts, versionEnv, 5000, input.cancellation);
    if (solcVersion.cancelled || input.cancellation?.aborted) return { ...(await blocked(input, 'cancelled_before_execution', 'Cancellation was requested during version validation.', startedAt, executionDigest)), status: 'cancelled', failureKind: 'cancelled', failureCode: 'cancelled' };
    if (solcVersion.code !== 0 || !solcVersion.stdout.text.includes(`Version: ${SOLC_VERSION}`)) return blocked(input, 'solc_version_mismatch', `Expected solc ${SOLC_VERSION}.`, startedAt, executionDigest);

    const selectedTests = [...(input.invariants ?? fixture.testNames)];
    const args = [
      'test', '--root', isolatedContracts, '--use', solc, '--profile', fixture.profile,
      '--match-path', `${fixture.testPath}/**`, '--match-test', selectedTests.join('|'),
      '--fuzz-runs', String(input.runs), '--fuzz-seed', input.seed.toLowerCase(), '--invariant-depth', String(input.depth),
      '--jobs', '1', '--no-auto-detect', '--no-rpc-rate-limit', '--color', 'never',
      '--out', path.join(scratch, 'out'), '--cache-path', path.join(scratch, 'cache'),
    ];
    const runEnv = {
      ...env,
      FOUNDRY_INVARIANT_RUNS: String(input.runs),
      FOUNDRY_INVARIANT_DEPTH: String(input.depth),
    };
    const execution = await runCommand(forge, args, isolatedContracts, runEnv, input.timeoutMs, input.cancellation);
    const buildDigest = await digestDirectory(path.join(scratch, 'out'), true).catch(() => sha256(''));
    const stdout = execution.stdout.text;
    const stderr = execution.stderr.text;
    const fullOutput = `${stdout}\n${stderr}`;
    const parsed = parseForgeOutcome(fullOutput, execution.code);
    const outputWarnings = execution.stdout.truncated || execution.stderr.truncated;
    let status: RunResult['status'];
    let outcome: RunResult['outcome'];
    let failureKind: RunResult['failureKind'];
    let failureCode: string | undefined;
    if (execution.cancelled) { status = 'cancelled'; outcome = null; failureKind = 'cancelled'; failureCode = 'cancelled'; }
    else if (execution.timedOut) { status = 'failed'; outcome = 'failed'; failureKind = 'timeout'; failureCode = 'timeout'; }
    else if (execution.spawnError) { status = 'infrastructure_blocked'; outcome = null; failureKind = 'infrastructure'; failureCode = 'process_start_failed'; }
    else if (!parsed.recognized || outputWarnings) { status = 'infrastructure_blocked'; outcome = null; failureKind = 'infrastructure'; failureCode = outputWarnings ? 'output_truncated' : 'unrecognized_forge_output'; }
    else if (parsed.outcome === 'passed') { status = 'completed'; outcome = 'passed'; }
    else if (parsed.outcome === 'failed') { status = 'failed'; outcome = 'failed'; failureKind = parsed.failureKind; failureCode = parsed.failureCode; }
    else { status = 'infrastructure_blocked'; outcome = null; failureKind = 'infrastructure'; failureCode = 'unrecognized_forge_output'; }
    const finishedAt = new Date().toISOString();
    const boundedStdout = execution.stdout.truncated ? `${stdout}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : stdout;
    const boundedStderr = execution.stderr.truncated ? `${stderr}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : stderr;
    const artifacts = [artifact('stdout.txt', boundedStdout), artifact('stderr.txt', boundedStderr)];
    if (parsed.counterexample) artifacts.push(artifact('counterexample.txt', parsed.counterexample));
    return {
      fixtureId: input.fixtureId,
      executionDigest,
      status,
      outcome,
      ...(failureKind ? { failureKind } : {}),
      ...(failureCode ? { failureCode } : {}),
      exitCode: execution.code,
      seed: input.seed.toLowerCase(),
      versions: { forge: FORGE_VERSION, solc: SOLC_VERSION, runner: RUNNER_VERSION, fixture: fixture.version },
      sourceDigest,
      buildDigest,
      replayMetadata: { fixtureId: input.fixtureId, fixtureVersion: fixture.version, runs: input.runs, depth: input.depth, seed: input.seed.toLowerCase(), invariants: selectedTests, forgeVersion: FORGE_VERSION, solcVersion: SOLC_VERSION, runnerVersion: RUNNER_VERSION, sourceDigest, buildDigest },
      effectiveLimits: { runs: input.runs, depth: input.depth, timeoutMs: input.timeoutMs, outputBytesPerStream: MAX_OUTPUT_BYTES },
      startedAt,
      finishedAt,
      stdout: boundedStdout,
      stderr: boundedStderr,
      artifacts,
      ...(parsed.counterexample ? { counterexample: { sha256: sha256(parsed.counterexample), bytes: Buffer.byteLength(parsed.counterexample), content: parsed.counterexample } } : {}),
    };
  } catch (error) {
    return blocked(input, 'runner_setup_failed', (error as Error).message, startedAt, '');
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const runnerLimits = { maxRuns: 10_000, maxDepth: 512, maxTimeoutMs: MAX_TIMEOUT_MS, maxOutputBytesPerStream: MAX_OUTPUT_BYTES } as const;
