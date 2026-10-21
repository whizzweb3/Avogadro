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
  id?: string;
  parentCampaignId?: string | null;
  status?: string;
  fixtureId?: string;
  outcome?: string | null;
  seed?: string;
  executionDigest?: string;
  failureKind?: string;
  result?: { outcome?: string | null; executionDigest?: string; templates?: { id: string; invariantName: string; fixtureId: string }[]; replayMetadata?: { templateIds?: string[] }; counterexample?: { sha256?: string; content?: string; steps?: { order: number; raw: string }[] }; templateIds?: string[] };
  artifacts?: { id: string; name: string; digest: string; byteCount: number }[];
  attempts?: { status?: string }[];
  events?: { eventType?: string }[];
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

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
  let workerOutput = "";
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
    for (const stream of [worker.stdout, worker.stderr]) stream?.on("data", (chunk: Buffer) => {
      workerOutput = `${workerOutput}${chunk.toString("utf8")}`.slice(-16_000);
    });

    const ownerWallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const owner = await signIn(origin, ownerWallet);
    const other = await signIn(origin, otherWallet);
    const catalogResponse = await fetch(`${origin}/v1/invariants/templates?fixtureId=vault-accounting-v1`, { headers: { cookie: owner.cookie } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { fixtureId: string; executionMode: string; templates: { id: string; fixtureId: string; invariantName: string; supported: boolean; parameters: unknown[] }[] };
    assert.equal(catalog.executionMode, "trusted_fixture");
    assert.equal(catalog.fixtureId, "vault-accounting-v1");
    assert(catalog.templates.length > 0, "campaign acceptance requires at least one runner-backed template");
    assert(catalog.templates.every((template) => template.supported && template.fixtureId === "vault-accounting-v1" && template.parameters.length === 0));
    const replayCatalogResponse = await fetch(`${origin}/v1/invariants/templates?fixtureId=replay-counterexample-v1`, { headers: { cookie: owner.cookie } });
    assert.equal(replayCatalogResponse.status, 200);
    const replayCatalog = await replayCatalogResponse.json() as { templates: { id: string; category: string; description: string; supported: boolean }[] };
    assert(replayCatalog.templates.every((template) => template.supported && template.category === "demonstrator" && /not a security finding/i.test(template.description)), "intentional expected-failure fixture must only be offered with explicit demonstrator labeling");
    assert.equal((await fetch(`${origin}/v1/invariants/templates`)).status, 401, "template catalog must require authentication");
    const unsupportedTemplate = await fetch(`${origin}/v1/campaigns`, {
      method: "POST",
      headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "idempotency-key": "unsupported-template-e2e", "content-type": "application/json" },
      body: JSON.stringify({ fixtureId: "vault-accounting-v1", templateIds: ["future-unimplemented-template"], seed: `0x${"00".repeat(32)}`, runs: 1, depth: 1, timeoutSeconds: 15 }),
    });
    assert.equal(unsupportedTemplate.status, 400, "campaign creation must reject templates with no real runner implementation");
    const campaigns = [
      { fixtureId: "vault-accounting-v1", templateIds: [catalog.templates[0]!.id], invariants: [catalog.templates[0]!.invariantName], expected: "passed" },
      { fixtureId: "replay-counterexample-v1", invariants: ["invariant_replayValueRemainsZero"], expected: "failed" },
    ] as const;

    for (const [index, spec] of campaigns.entries()) {
      const created = await fetch(`${origin}/v1/campaigns`, {
        method: "POST",
        headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf, "idempotency-key": `e2e-campaign-${index}-${Date.now()}`, "content-type": "application/json" },
        body: JSON.stringify({ fixtureId: spec.fixtureId, ...( "templateIds" in spec ? { templateIds: spec.templateIds } : { invariants: spec.invariants }), seed: `0x${String(index + 1).padStart(2, "0").repeat(32)}`, runs: 16, depth: 8, timeoutSeconds: 60 }),
      });
      assert.equal(created.status, 202);
      const accepted = await created.json() as { id: string; status: string };
      assert.equal(accepted.status, "queued");

      let result: CampaignRead;
      try { result = await waitForResult(origin, owner, accepted.id); }
      catch (error) {
        const diagnostic = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: owner.cookie } }).then((response) => response.json()).catch(() => null);
        assert.fail(`${error instanceof Error ? error.message : String(error)}; persisted state: ${JSON.stringify(diagnostic)}; worker log tail: ${workerOutput}`);
      }
      assert.equal(result.fixtureId, spec.fixtureId);
      assert.equal(result.status, spec.expected === "passed" ? "completed" : "failed");
      assert.equal(result.outcome, spec.expected);
      assert.equal(result.result?.outcome, spec.expected);
      if (spec.expected === "passed") {
        assert.deepEqual(result.result?.templates?.map((template) => template.id), [catalog.templates[0]!.id]);
        assert.deepEqual(result.result?.replayMetadata?.templateIds, [catalog.templates[0]!.id]);
      }
      assert.equal(result.attempts?.length, 1);
      assert.equal(result.attempts?.[0]?.status, result.status);
      assert(result.events?.some((event: { eventType: string }) => event.eventType === "running"), "running transition must be persisted");
      assert(result.events?.some((event: { eventType: string }) => event.eventType === result.status), "terminal transition must be persisted");
      const eventPage = await fetch(`${origin}/v1/campaigns/${accepted.id}/events?after=0&limit=2`, { headers: { cookie: owner.cookie } });
      assert.equal(eventPage.status, 200);
      const firstEvents = await eventPage.json() as { events: { sequence: number; eventType: string; createdAt: string }[]; nextCursor: string | null };
      assert(firstEvents.events.length > 0 && firstEvents.events.length <= 2);
      assert.deepEqual(firstEvents.events.map((event) => event.sequence), [...firstEvents.events.map((event) => event.sequence)].sort((a, b) => a - b));
      assert(firstEvents.events.every((event) => Number.isFinite(Date.parse(event.createdAt))));
      assert.equal((await fetch(`${origin}/v1/campaigns/${accepted.id}/events?limit=2`, { headers: { cookie: other.cookie } })).status, 404, "event history must remain owner-scoped");
      if (firstEvents.nextCursor) {
        const nextEvents = await fetch(`${origin}/v1/campaigns/${accepted.id}/events?after=${firstEvents.nextCursor}&limit=100`, { headers: { cookie: owner.cookie } });
        assert.equal(nextEvents.status, 200);
        const secondPage = await nextEvents.json() as { events: { sequence: number }[] };
        assert(secondPage.events.every((event) => event.sequence > Number(firstEvents.nextCursor)), "event cursor must not repeat an event");
      }
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
        const findingsResponse = await fetch(`${origin}/v1/campaigns/${accepted.id}/findings`, { headers: { cookie: owner.cookie } });
        assert.equal(findingsResponse.status, 200);
        const findings = await findingsResponse.json() as { findings: { kind: string; invariantNames: string[]; counterexample: { sha256: string; bytes: number } | null }[] };
        assert.equal(findings.findings.length, 1, "only the actual invariant failure should produce a finding");
        assert.equal(findings.findings[0]?.kind, "invariant_violation");
        assert.deepEqual(findings.findings[0]?.invariantNames, spec.invariants);
        assert.equal(findings.findings[0]?.counterexample?.sha256, result.result.counterexample.sha256);
        const counterexampleResponse = await fetch(`${origin}/v1/campaigns/${accepted.id}/counterexample`, { headers: { cookie: owner.cookie } });
        assert.equal(counterexampleResponse.status, 200);
        const counterexample = await counterexampleResponse.json() as { counterexample: { steps: { order: number; raw: string }[]; stepsSha256: string; sha256: string } | null };
        assert.equal(counterexample.counterexample?.sha256, result.result.counterexample.sha256);
        assert(counterexample.counterexample && counterexample.counterexample.steps.length > 0, "real Foundry counterexample calls must be retained in ordered structured form");
        assert.deepEqual(counterexample.counterexample.steps.map((step) => step.order), counterexample.counterexample.steps.map((_, index) => index));
        assert.equal(counterexample.counterexample.stepsSha256, createHash("sha256").update(canonicalJson(counterexample.counterexample.steps)).digest("hex"), "ordered parsed calls must retain their own integrity digest");
        assert.equal((await fetch(`${origin}/v1/campaigns/${accepted.id}/findings`, { headers: { cookie: other.cookie } })).status, 404);
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

      const reportResponse = await fetch(`${origin}/v1/campaigns/${accepted.id}/report`, { headers: { cookie: owner.cookie } });
      assert.equal(reportResponse.status, 200);
      const report = await reportResponse.json() as { reportVersion: string; campaign: { id: string; fixtureId: string; status: string; executionDigest: string; selectedInvariants: string[]; snapshotBlockNumber?: number | null }; artifacts: { id: string; digest: string; byteCount: number }[]; evidenceDigest: string };
      assert.equal(report.reportVersion, "1");
      assert.equal(report.campaign.id, accepted.id);
      assert.equal(report.campaign.fixtureId, spec.fixtureId);
      assert.equal(report.campaign.status, result.status);
      assert.equal(report.campaign.executionDigest, result.result?.executionDigest);
      assert(report.artifacts.some((artifact) => artifact.id === selectedEvidence.id && artifact.digest === selectedEvidence.digest && artifact.byteCount === selectedEvidence.byteCount));
      const { evidenceDigest, ...reportBody } = report;
      assert.equal(evidenceDigest, createHash("sha256").update(canonicalJson(reportBody)).digest("hex"), "report digest must bind its actual content");
      assert.equal((await fetch(`${origin}/v1/campaigns/${accepted.id}/report`, { headers: { cookie: other.cookie } })).status, 404, "report must be owner-scoped");

      const ownerRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: owner.cookie } });
      assert.equal(ownerRead.status, 200);
      const foreignRead = await fetch(`${origin}/v1/campaigns/${accepted.id}`, { headers: { cookie: other.cookie } });
      assert.equal(foreignRead.status, 404, "a different authenticated wallet must not retrieve the campaign");
      if (spec.expected === "failed") {
        const forbiddenReplay = await fetch(`${origin}/v1/campaigns/${accepted.id}/replay`, { method: "POST", headers: { cookie: other.cookie, "x-csrf-token": other.csrf } });
        assert.equal(forbiddenReplay.status, 404, "a different wallet must not replay another owner's failing campaign");
        const replayResponse = await fetch(`${origin}/v1/campaigns/${accepted.id}/replay`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf } });
        assert.equal(replayResponse.status, 202);
        const replayAccepted = await replayResponse.json() as { id: string; replayOf: string; status: string };
        assert.equal(replayAccepted.replayOf, accepted.id);
        assert.equal(replayAccepted.status, "queued");
        const replayResult = await waitForResult(origin, owner, replayAccepted.id);
        assert.equal(replayResult.fixtureId, result.fixtureId);
        assert.equal(replayResult.parentCampaignId, accepted.id);
        assert.equal(replayResult.status, result.status);
        assert.equal(replayResult.outcome, result.outcome);
        assert.equal(replayResult.seed, result.seed);
        assert.equal(replayResult.executionDigest, result.executionDigest);
        assert.equal(replayResult.result?.counterexample?.sha256, result.result?.counterexample?.sha256, "same-seed campaign replay must reproduce the counterexample evidence hash");
      }
    }
    const filteredList = await fetch(`${origin}/v1/campaigns?fixtureId=vault-accounting-v1&limit=1`, { headers: { cookie: owner.cookie } });
    assert.equal(filteredList.status, 200);
    const listPage = await filteredList.json() as { items: CampaignRead[]; nextCursor: string | null };
    assert.equal(listPage.items.length, 1);
    assert.equal(listPage.items[0]?.fixtureId, "vault-accounting-v1");
    if (listPage.nextCursor) {
      const nextPage = await fetch(`${origin}/v1/campaigns?fixtureId=vault-accounting-v1&limit=1&cursor=${listPage.nextCursor}`, { headers: { cookie: owner.cookie } });
      assert.equal(nextPage.status, 200);
      const nextList = await nextPage.json() as { items: CampaignRead[] };
      assert(nextList.items.every((campaign) => campaign.fixtureId === "vault-accounting-v1"));
    }
    assert.equal(workerExit, undefined, "worker must remain alive while campaigns complete");
  } finally {
    if (worker) await closeChild(worker);
    workerObjectStore.destroy();
    await app.close();
    await db.close();
  }
});
