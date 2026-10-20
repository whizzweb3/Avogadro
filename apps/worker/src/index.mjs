import { Worker } from "bullmq";
import IORedis from "ioredis";

const host = process.env.REDIS_HOST ?? "127.0.0.1";
const port = Number(process.env.REDIS_PORT ?? 6379);
const concurrency = Math.min(1, Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1)));

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid REDIS_PORT");
const connection = new IORedis({ host, port, maxRetriesPerRequest: null, enableReadyCheck: true });
const worker = new Worker("avogadro-campaigns", async (job) => {
  // Queue messages are identifiers only. The worker currently fails closed until
  // an isolated Foundry sandbox runner is configured; it never trusts job payloads.
  if (!job.data || Object.keys(job.data).some((key) => key !== "campaignId") || typeof job.data.campaignId !== "string") {
    throw new Error("Invalid campaign job payload");
  }
  throw new Error("Foundry sandbox runner is not configured");
}, { connection, concurrency, autorun: true });

worker.on("ready", () => console.info("AVOGADRO worker connected; awaiting campaign jobs"));
worker.on("failed", (job, error) => console.error("Campaign job failed closed", { jobId: job?.id, message: error.message }));
worker.on("error", (error) => console.error("Worker infrastructure error", { message: error.message }));

async function shutdown() {
  await worker.close();
  await connection.quit();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
