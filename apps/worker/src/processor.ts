import { randomUUID } from "node:crypto";
import type { ArtifactStorage, StoredArtifact } from "@avogadro/artifacts";
import type { createCampaignStore } from "@avogadro/db";
import { runFixtureCampaign, type RunResult } from "@avogadro/runner";

type Store = ReturnType<typeof createCampaignStore>;
type CampaignLease = NonNullable<Awaited<ReturnType<Store["lease"]>>>;

export type CampaignProcessorOptions = {
  store: Pick<Store, "lease" | "persistResult" | "retryInfrastructure" | "isCancelRequested" | "renewLease">;
  execute?: typeof runFixtureCampaign;
  artifactStorage?: ArtifactStorage;
  workerId?: string;
  shutdownSignal?: AbortSignal;
  cancelPollMs?: number;
};

/** Executes only the fixture/config reloaded from the authoritative campaign row. */
export function createCampaignProcessor(options: CampaignProcessorOptions) {
  const execute = options.execute ?? runFixtureCampaign;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  return async (campaignId: string): Promise<RunResult | undefined> => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId)) throw new Error("Invalid campaign ID");
    if (options.shutdownSignal?.aborted) throw new Error("Worker is shutting down");
    const lease = await options.store.lease(campaignId, workerId) as CampaignLease | null;
    if (!lease) return undefined; // terminal or duplicate delivery; DB is authoritative

    const controller = new AbortController();
    let shutdownRequested = false;
    const abortOnShutdown = () => { shutdownRequested = true; controller.abort("worker_shutdown"); };
    options.shutdownSignal?.addEventListener("abort", abortOnShutdown, { once: true });
    let polling = false;
    let stateCheckFailed = false;
    const pollMs = options.cancelPollMs ?? 500;
    const poll = setInterval(async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const [cancelled, renewed] = await Promise.all([
          options.store.isCancelRequested(campaignId),
          options.store.renewLease(campaignId, lease.attemptNumber, workerId),
        ]);
        if (!renewed) { stateCheckFailed = true; controller.abort("campaign_lease_lost"); }
        if (cancelled) controller.abort("campaign_cancelled");
      } catch {
        // Store loss must not silently continue an active fuzz run.
        stateCheckFailed = true;
        controller.abort("campaign_state_unavailable");
      } finally { polling = false; }
    }, pollMs);
    poll?.unref();

    try {
      const result = await execute({
        fixtureId: lease.fixtureId as "vault-accounting-v1" | "replay-counterexample-v1",
        runs: lease.runs,
        depth: lease.depth,
        seed: lease.seed,
        timeoutMs: lease.timeoutSeconds * 1000,
        ...(Array.isArray(lease.templateIds) && lease.templateIds.length ? { templateIds: lease.templateIds as string[] } : { invariants: lease.selectedInvariants as string[] }),
        cancellation: controller.signal,
      });
      if (Array.isArray(lease.templateIds) && lease.templateIds.length > 0 && result.executionDigest !== lease.executionDigest) throw new Error("Runner execution identity does not match the leased campaign configuration");
      if (stateCheckFailed) throw new Error("Campaign state store became unavailable during execution");
      if (shutdownRequested) {
        const retried = await options.store.retryInfrastructure(campaignId, lease.attemptNumber, workerId, {
          ...result,
          status: "infrastructure_blocked",
          outcome: null,
          failureKind: "infrastructure",
          failureCode: "worker_shutdown_interrupted",
          interruptedStatus: result.status,
        } as unknown as Record<string, unknown>, 5_000);
        if (!retried) throw new Error("Campaign lease expired before shutdown interruption could be persisted");
        return result;
      }
      if (result.status === "infrastructure_blocked") {
        const retried = await options.store.retryInfrastructure(campaignId, lease.attemptNumber, workerId, result as unknown as Record<string, unknown>, 5_000);
        if (!retried) throw new Error("Campaign lease expired before infrastructure retry could be persisted");
        return result;
      }
      const uploaded: StoredArtifact[] = [];
      const manifests = result.artifacts ?? [];
      if (manifests.length && !options.artifactStorage) throw new Error("Artifact storage is required for campaign evidence");
      try {
        for (const manifest of manifests) uploaded.push(await options.artifactStorage!.put(campaignId, lease.attemptNumber, manifest));
      } catch {
        await Promise.all(uploaded.map((artifact) => options.artifactStorage!.delete(artifact.objectKey).catch(() => undefined)));
        const retried = await options.store.retryInfrastructure(campaignId, lease.attemptNumber, workerId, {
          status: "infrastructure_blocked", outcome: null, failureKind: "infrastructure", failureCode: "artifact_upload_failed",
        }, 5_000);
        if (!retried) throw new Error("Campaign lease expired before artifact failure could be persisted");
        return { ...result, status: "infrastructure_blocked", outcome: null, failureKind: "infrastructure", failureCode: "artifact_upload_failed" };
      }
      const safeResult = {
        ...result,
        artifacts: uploaded.map(({ name, digest, byteCount }) => ({ name, sha256: digest, bytes: byteCount })),
        ...(result.counterexample ? { counterexample: { sha256: result.counterexample.sha256, bytes: result.counterexample.bytes, steps: result.counterexample.steps?.slice(0, 256) ?? [], stepsSha256: result.counterexample.stepsSha256 } } : {}),
      };
      const persisted = await options.store.persistResult(campaignId, lease.attemptNumber, workerId, safeResult as unknown as Record<string, unknown>, uploaded);
      if (!persisted) {
        // This is a definitive stale lease result, so no metadata was committed.
        await Promise.all(uploaded.map((artifact) => options.artifactStorage!.delete(artifact.objectKey).catch(() => undefined)));
        throw new Error("Campaign result was not persisted");
      }
      // On DB transport errors leave objects intact: commit acknowledgement can
      // be lost, and a committed metadata row must never point at deleted bytes.
      // Bucket lifecycle expiry cleans true orphans after crashes.
      // Avoid persisting raw evidence a second time in BullMQ's job return value.
      return safeResult as unknown as RunResult;
    } finally {
      if (poll) clearInterval(poll);
      options.shutdownSignal?.removeEventListener("abort", abortOnShutdown);
    }
  };
}
