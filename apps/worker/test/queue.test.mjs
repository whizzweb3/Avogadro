import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { CAMPAIGN_QUEUE, createCampaignQueue, createCampaignWorker, createRedisConnection, validateCampaignJob } from "../src/queue.mjs";

test("campaign queue rejects any payload beyond a UUID campaign identifier", () => {
  const id = randomUUID();
  assert.equal(validateCampaignJob({ campaignId: id }), id);
  for (const payload of [null, [], { campaignId: id, forgeArgs: ["--broadcast"] }, { campaignId: "../../etc/passwd" }]) {
    assert.throws(() => validateCampaignJob(payload), /Invalid campaign job payload/);
  }
});

test("BullMQ delivers an identifier-only job and retries infrastructure failures on real Redis", async (t) => {
  const url = new URL(process.env.AVOGADRO_TEST_REDIS_URL ?? "redis://127.0.0.1:6379/15");
  const connection = createRedisConnection({ host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0) });
  const queue = createCampaignQueue(connection);
  const campaignId = randomUUID();
  const calls = [];
  let worker;
  t.after(async () => {
    await worker?.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await connection.quit();
  });

  await queue.waitUntilReady();
  worker = createCampaignWorker({ connection, processor: async (id) => {
    calls.push(id);
    if (calls.length === 1) throw new Error("temporary infrastructure failure");
    return { persisted: true };
  } });
  const completed = once(worker, "completed");
  const job = await queue.add("execute-campaign", { campaignId }, { jobId: campaignId, attempts: 2, backoff: { type: "fixed", delay: 10 } });
  const [finished] = await completed;
  assert.equal(finished.id, job.id);
  assert.deepEqual(calls, [campaignId, campaignId]);
  assert.deepEqual(await finished.returnvalue, { persisted: true });
  assert.equal(CAMPAIGN_QUEUE, "avogadro-campaigns");
});
