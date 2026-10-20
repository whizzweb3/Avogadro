import type { Job, Queue, Worker } from "bullmq";
import type IORedis from "ioredis";

export const CAMPAIGN_QUEUE: string;
export const CAMPAIGN_JOB: string;
export function validateCampaignJob(data: unknown): string;
export function createRedisConnection(options?: { host?: string; port?: number; db?: number }): IORedis;
export function createCampaignQueue(connection: IORedis): Queue;
export function createCampaignWorker(options: {
  connection: IORedis;
  processor: (campaignId: string, job: Job) => Promise<unknown>;
  concurrency?: number;
}): Worker;
