import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

export const CAMPAIGN_QUEUE = "avogadro-campaigns";
export const CAMPAIGN_JOB = "execute-campaign";

/** Queue messages are deliberately opaque identifiers. All execution inputs are loaded from PostgreSQL. */
export function validateCampaignJob(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid campaign job payload");
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "campaignId" || typeof data.campaignId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.campaignId)) {
    throw new Error("Invalid campaign job payload");
  }
  return data.campaignId;
}

export function createRedisConnection({ host = "127.0.0.1", port = 6379, db } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid REDIS_PORT");
  if (db !== undefined && (!Number.isInteger(db) || db < 0 || db > 15)) throw new Error("Invalid Redis database");
  return new IORedis({ host, port, db, maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export function createCampaignQueue(connection) {
  return new Queue(CAMPAIGN_QUEUE, { connection, defaultJobOptions: {
    attempts: 4,
    // DB attempt leases last 60 seconds; retry only after that lease can expire.
    backoff: { type: "exponential", delay: 65_000 },
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: { age: 604800, count: 10000 },
  } });
}

export function createCampaignWorker({ connection, processor, concurrency = 1 }) {
  if (concurrency !== 1) throw new Error("Campaign workers must run with concurrency 1");
  if (typeof processor !== "function") throw new Error("A campaign processor is required");
  return new Worker(CAMPAIGN_QUEUE, async (job) => processor(validateCampaignJob(job.data), job), {
    connection, concurrency: 1, autorun: true, lockDuration: 90_000, stalledInterval: 15_000, maxStalledCount: 1,
  });
}
