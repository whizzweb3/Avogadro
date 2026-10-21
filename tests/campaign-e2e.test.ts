import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { buildApp } from "../apps/api/src/app.js";
import { createCampaignStore, createDatabase, createSiweStore, artifacts as artifactRows } from "@avogadro/db";
import { eq } from "drizzle-orm";
import { createArtifactStorage } from "@avogadro/artifacts";

const databaseUrl = process.env.E2E_DATABASE_URL;
const workerDatabaseUrl = process.env.E2E_WORKER_DATABASE_URL;
const redisHost = process.env.E2E_REDIS_HOST;
const forgeBin = process.env.AVOGADRO_FORGE_BIN;
const solcBin = process.env.AVOGADRO_SOLC_BIN;
const artifactEndpoint = process.env.E2E_ARTIFACT_ENDPOINT;
const artifactBucket = process.env.E2E_ARTIFACT_BUCKET;
const artifactRegion = process.env.E2E_ARTIFACT_REGION;
const apiArtifactAccessKey = process.env.E2E_ARTIFACT_API_ACCESS_KEY_ID;
const apiArtifactSecret = process.env.E2E_ARTIFACT_API_SECRET_ACCESS_KEY;
const workerArtifactAccessKey = process.env.E2E_ARTIFACT_WORKER_ACCESS_KEY_ID;
const workerArtifactSecret = process.env.E2E_ARTIFACT_WORKER_SECRET_ACCESS_KEY;
const enabled = Boolean(databaseUrl && workerDatabaseUrl && redisHost && forgeBin && solcBin && artifactEndpoint && artifactBucket && artifactRegion && apiArtifactAccessKey && apiArtifactSecret && workerArtifactAccessKey && workerArtifactSecret);
const timeoutMs = 150_000;
type CampaignRead = {
  status?: string;
  fixtureId?: string;
  outcome?: string | null;
  failureKind?: string;
  result?: { outcome?: string | null; counterexample?: { sha256?: string; content?: string } };
  artifacts?: { id: string; name: string; digest: string; byteCount: number }[];
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
  const apiArtifacts = createArtifactStorage({ endpoint: artifactEndpoint!, bucket: artifactBucket!, region: artifactRegion!, accessKeyId: apiArtifactAccessKey!, secretAccessKey: apiArtifactSecret! });
  const workerObjectStore = new S3Client({ endpoint: artifactEndpoint!, region: artifactRegion!, forcePathStyle: true, credentials: { accessKeyId: workerArtifactAccessKey!, secretAccessKey: workerArtifactSecret! } });
  const app = buildApp({
    logger: false,
    campaignStore: createCampaignStore(db.db),
    authStore: createSiweStore(db.db),
    artifactStorage: apiArtifacts,
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
      ARTIFACT_ENDPOINT: artifactEndpoint,
      ARTIFACT_BUCKET: artifactBucket,
      ARTIFACT_REGION: artifactRegion,
      ARTIFACT_ACCESS_KEY_ID: workerArtifactAccessKey,
      ARTIFACT_SECRET_ACCESS_KEY: workerArtifactSecret,
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
      const selectedEvidence = result.artifacts?.find((artifact) => spec.expected === "failed" ? artifact.name === "counterexample.txt" : artifact.name === "stdout.txt");
      assert(selectedEvidence, `campaign must persist expected ${spec.expected === "failed" ? "counterexample" : "passing"} evidence metadata`);
      const evidenceResponse = await fetch(`${origin}/v1/campaigns/${accepted.id}/artifacts/${selectedEvidence.id}`, { headers: { cookie: owner.cookie } });
      assert.equal(evidenceResponse.status, 200);
      assert.equal(evidenceResponse.headers.get("cache-control"), "private, no-store");
      const evidence = Buffer.from(await evidenceResponse.arrayBuffer());
      assert.equal(evidence.length, selectedEvidence.byteCount);
      assert.equal(`0x${createHash("sha256").update(evidence).digest("hex")}`, selectedEvidence.digest);
      const anonymousArtifact = await fetch(`${origin}/v1/campaigns/${accepted.id}/artifacts/${selectedEvidence.id}`);
      assert.equal(anonymousArtifact.status, 401);
      const foreignArtifact = await fetch(`${origin}/v1/campaigns/${accepted.id}/artifacts/${selectedEvidence.id}`, { headers: { cookie: other.cookie } });
      assert.equal(foreignArtifact.status, 404, "a different authenticated wallet must not retrieve evidence");
      if (spec.expected === "failed") {
        assert.equal(result.failureKind, "invariant_violation");
        assert(result.result?.counterexample?.sha256, "failure must persist counterexample digest");
        assert.equal(result.result?.counterexample?.content, undefined, "raw counterexample bytes must remain in artifact storage");
        assert(evidence.toString().includes("Counterexample:") || evidence.toString().includes("[Sequence]"), "counterexample artifact must contain the deterministic failing trace");
        // A worker identity with write permission can still not replace evidence undetected.
        const [evidenceMetadata] = await db.db.select({ objectKey: artifactRows.objectKey }).from(artifactRows).where(eq(artifactRows.id, selectedEvidence.id));
        assert(evidenceMetadata);
        await workerObjectStore.send(new PutObjectCommand({ Bucket: artifactBucket!, Key: evidenceMetadata.objectKey, Body: "tampered evidence" }));
        const tampered = await fetch(`${origin}/v1/campaigns/${accepted.id}/artifacts/${selectedEvidence.id}`, { headers: { cookie: owner.cookie } });
        assert.equal(tampered.status, 502, "tampered object must fail closed on digest verification");
      } else {
        // Force expiry in the disposable database to verify API denial and best-effort deletion.
        const [metadata] = await db.db.select({ objectKey: artifactRows.objectKey }).from(artifactRows).where(eq(artifactRows.id, selectedEvidence.id));
        assert(metadata);
        await db.db.update(artifactRows).set({ retainUntil: new Date(Date.now() - 1000) }).where(eq(artifactRows.id, selectedEvidence.id));
        const expired = await fetch(`${origin}/v1/campaigns/${accepted.id}/artifacts/${selectedEvidence.id}`, { headers: { cookie: owner.cookie } });
        assert.equal(expired.status, 410);
        await assert.rejects(() => apiArtifacts.get(metadata.objectKey, selectedEvidence.byteCount, selectedEvidence.digest));
      }

      const ownerRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: owner.cookie } });
      assert.equal(ownerRead.status, 200);
      const foreignRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: other.cookie } });
      assert.equal(foreignRead.status, 404, "a different authenticated wallet must not retrieve the campaign");
    }
    assert.equal(workerExit, undefined, "worker must remain alive while campaigns complete");
  } finally {
    if (worker) await closeChild(worker);
    workerObjectStore.destroy();
    await app.close();
    await db.close();
  }
});
