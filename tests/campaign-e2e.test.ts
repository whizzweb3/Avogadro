import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import { buildApp } from "../apps/api/src/app.js";
import { createCampaignStore, createDatabase, createSiweStore } from "@avogadro/db";

const databaseUrl = process.env.E2E_DATABASE_URL;
const workerDatabaseUrl = process.env.E2E_WORKER_DATABASE_URL;
const redisHost = process.env.E2E_REDIS_HOST;
const forgeBin = process.env.AVOGADRO_FORGE_BIN;
const solcBin = process.env.AVOGADRO_SOLC_BIN;
const enabled = Boolean(databaseUrl && workerDatabaseUrl && redisHost && forgeBin && solcBin);
const timeoutMs = 150_000;
type CampaignRead = {
  status?: string;
  fixtureId?: string;
  outcome?: string | null;
  failureKind?: string;
  result?: { outcome?: string | null; counterexample?: { sha256?: string; content?: string } };
  attempts?: { status?: string }[];
  events?: { eventType?: string }[];
};

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function signIn(appOrigin: string, wallet: Wallet) {
  const nonceResponse = await fetch(`${appOrigin}/v1/auth/nonce`);
  assert.equal(nonceResponse.status, 200);
  const nonceData = await nonceResponse.json() as { nonce: string; domain: string; uri: string; chainId: number };
  const message = new SiweMessage({
    domain: nonceData.domain,
    address: wallet.address,
    statement: "Sign in to AVOGADRO integration tests.",
    uri: nonceData.uri,
    version: "1",
    chainId: nonceData.chainId,
    nonce: nonceData.nonce,
    issuedAt: new Date().toISOString(),
  });
  const response = await fetch(`${appOrigin}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: message.prepareMessage(), signature: await wallet.signMessage(message.prepareMessage()) }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { csrfToken: string };
  const cookieHeader = response.headers.get("set-cookie");
  assert(cookieHeader, "SIWE response must set session and CSRF cookies");
  const cookie = cookieHeader.split(",").map((part) => part.split(";")[0]).join("; ");
  return { cookie, csrf: body.csrfToken };
}

async function waitForResult(origin: string, auth: { cookie: string; csrf: string }, id: string): Promise<CampaignRead> {
  const deadline = Date.now() + timeoutMs;
  let latest: CampaignRead | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/v1/campaigns/${id}`, { headers: { cookie: auth.cookie } });
    assert.equal(response.status, 200);
    latest = await response.json() as CampaignRead;
    if (["completed", "failed", "cancelled", "infrastructure_blocked"].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail(`Campaign did not reach a terminal state before timeout (last status: ${latest?.status ?? "unknown"})`);
}

test("authenticated campaigns traverse PostgreSQL, BullMQ and trusted Foundry worker", { skip: !enabled, timeout: timeoutMs * 2 }, async () => {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const db = createDatabase(databaseUrl!);
  const app = buildApp({
    logger: false,
    campaignStore: createCampaignStore(db.db),
    authStore: createSiweStore(db.db),
    siweConfig: { domain: `localhost:${port}`, uri: origin, chainId: 4663 },
  });
  let worker: ChildProcess | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port });
    const workerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME,
      NODE_ENV: "production",
      DATABASE_URL: workerDatabaseUrl,
      REDIS_HOST: redisHost,
      REDIS_PORT: process.env.E2E_REDIS_PORT ?? "6379",
      WORKER_CONCURRENCY: "1",
      AVOGADRO_FORGE_BIN: forgeBin,
      AVOGADRO_SOLC_BIN: solcBin,
    };
    worker = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
      cwd: process.cwd(), env: workerEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let workerExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    worker.once("exit", (code, signal) => { workerExit = { code, signal }; });
    // Consume output to prevent pipe backpressure; never echo environment or worker logs into test output.
    worker.stdout?.resume();
    worker.stderr?.resume();

    const ownerWallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const owner = await signIn(origin, ownerWallet);
    const other = await signIn(origin, otherWallet);
    const campaigns = [
      { fixtureId: "vault-accounting-v1", invariants: ["invariant_accountingMatchesSuccessfulActions"], expected: "passed" },
      { fixtureId: "replay-counterexample-v1", invariants: ["invariant_replayValueRemainsZero"], expected: "failed" },
    ] as const;

    for (const [index, spec] of campaigns.entries()) {
      const created = await fetch(`${origin}/v1/campaigns`, {
        method: "POST",
        headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "idempotency-key": `e2e-campaign-${index}-${Date.now()}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureId: spec.fixtureId, invariants: spec.invariants, seed: `0x${String(index + 1).padStart(2, "0").repeat(32)}`, runs: 16, depth: 8, timeoutSeconds: 60 }),
      });
      assert.equal(created.status, 202);
      const accepted = await created.json() as { id: string; status: string };
      assert.equal(accepted.status, "queued");

      const result = await waitForResult(origin, owner, accepted.id);
      assert.equal(result.fixtureId, spec.fixtureId);
      assert.equal(result.status, spec.expected === "passed" ? "completed" : "failed");
      assert.equal(result.outcome, spec.expected);
      assert.equal(result.result?.outcome, spec.expected);
      assert.equal(result.attempts?.length, 1);
      assert.equal(result.attempts?.[0]?.status, result.status);
      assert(result.events?.some((event: { eventType: string }) => event.eventType === "running"), "running transition must be persisted");
      assert(result.events?.some((event: { eventType: string }) => event.eventType === result.status), "terminal transition must be persisted");
      if (spec.expected === "failed") {
        assert.equal(result.failureKind, "invariant_violation");
        assert(result.result?.counterexample?.sha256, "failure must persist counterexample digest");
        assert(result.result?.counterexample?.content, "failure must persist counterexample content");
      }

      const ownerRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: owner.cookie } });
      assert.equal(ownerRead.status, 200);
      const foreignRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: other.cookie } });
      assert.equal(foreignRead.status, 404, "a different authenticated wallet must not retrieve the campaign");
    }
    assert.equal(workerExit, undefined, "worker must remain alive while campaigns complete");
  } finally {
    if (worker) await closeChild(worker);
    await app.close();
    await db.close();
  }
});
