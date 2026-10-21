import { createCampaignStore, createDatabase } from "@avogadro/db";
import { artifactStorageFromEnv } from "@avogadro/artifacts";
import { CAMPAIGN_JOB, createCampaignQueue, createCampaignWorker, createRedisConnection, validateCampaignJob } from "./queue.mjs";
import { createCampaignProcessor } from "./processor.js";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "1");
if (concurrency !== 1) throw new Error("WORKER_CONCURRENCY must be 1");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for authoritative campaign loading");
const port = Number(process.env.REDIS_PORT ?? 6379);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid REDIS_PORT");

const database = createDatabase(process.env.DATABASE_URL);
const store = createCampaignStore(database.db);
const artifactStorage = artifactStorageFromEnv();
const connection = createRedisConnection({ host: process.env.REDIS_HOST ?? "127.0.0.1", port });
const queue = createCampaignQueue(connection);
const shutdownController = new AbortController();
const processor = createCampaignProcessor({ store, artifactStorage, shutdownSignal: shutdownController.signal });
const worker = createCampaignWorker({ connection, processor });
const dispatcherId = `dispatcher-${process.pid}`;
let dispatching = false;
let shuttingDown = false;

async function dispatchOutbox() {
  if (dispatching || shuttingDown) return;
  dispatching = true;
  try {
    const rows = await store.claimOutbox(dispatcherId, 25);
    for (const row of rows) {
      if (row.topic !== "campaign.execute") continue;
      try {
        const payload = row.payload as { campaignId?: unknown };
        const campaignId = validateCampaignJob({ campaignId: payload?.campaignId });
        await queue.add(CAMPAIGN_JOB, { campaignId }, {
          // Outbox identity makes a crash between Redis handoff and DB acknowledgement idempotent.
          jobId: row.id,
          attempts: 4,
          backoff: { type: "exponential", delay: 65_000 },
        });
        await store.markOutboxDelivered(row.id, dispatcherId);
      } catch {
        // Leave the leased outbox row to expire and be retried; never log source or credentials.
        console.error("Campaign outbox dispatch failed", { outboxId: row.id });
      }
    }
  } catch {
    console.error("Campaign outbox polling failed");
  } finally { dispatching = false; }
}

const outboxTimer = setInterval(() => void dispatchOutbox(), 1_000);
outboxTimer.unref();
void dispatchOutbox();
worker.on("ready", () => console.info("AVOGADRO worker ready", { concurrency: 1 }));
worker.on("completed", (job, result) => console.info("Campaign attempt persisted", { jobId: job.id, status: result?.status ?? "duplicate" }));
worker.on("failed", (job) => console.error("Campaign queue attempt failed", { jobId: job?.id }));
worker.on("error", () => console.error("Campaign worker infrastructure error"));

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(outboxTimer);
  shutdownController.abort(); // runner terminates the Forge process group and persists cancellation.
  await worker.close();
  await queue.close();
  await connection.quit();
  await database.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
