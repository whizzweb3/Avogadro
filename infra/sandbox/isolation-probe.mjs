import fs from 'node:fs/promises';
import net from 'node:net';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  else process.stdout.write(`PASS ${message}\n`);
};

// Give the host verifier time to inspect effective container settings.
await new Promise((resolve) => setTimeout(resolve, 1000));

try {
  await fs.writeFile('/readonly-probe', 'should fail');
  check(false, 'container root filesystem is read-only');
} catch {
  check(true, 'container root filesystem is read-only');
}

try {
  await fs.writeFile('/input/avogadro-probe', 'should fail');
  check(false, 'imported source mount is read-only');
} catch {
  check(true, 'imported source mount is read-only');
}

await fs.writeFile('/work/ephemeral-probe', 'writable only in job tmpfs');
check(true, 'job has isolated writable scratch space');

const procStatus = await fs.readFile('/proc/self/status', 'utf8');
check(/^Seccomp:\s+2$/m.test(procStatus), 'default seccomp filter is active');
check(/^NoNewPrivs:\s+1$/m.test(procStatus), 'no-new-privileges is active');

const forbiddenEnv = Object.keys(process.env).filter((key) =>
  /^(DATABASE_URL|REDIS_|ARTIFACT_|AWS_|RPC_|PRIVATE_KEY|WALLET_)/i.test(key),
);
check(forbiddenEnv.length === 0, 'no application, artifact, RPC, or wallet credentials are present');

const canConnect = (host, port) => new Promise((resolve) => {
  const socket = net.createConnection({ host, port });
  const finish = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(1500, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

check(!await fs.access('/var/run/docker.sock').then(() => true, () => false), 'Docker daemon socket is unavailable');
check(!(await canConnect('1.1.1.1', 443)), 'outbound network egress is denied');
check(!(await canConnect('postgres', 5432)), 'internal service DNS and database access are unavailable');

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exitCode = 1;
}
