import { randomUUID } from "node:crypto";
import type { createCampaignStore } from "@avogadro/db";
import { runFixtureCampaign, type RunResult } from "@avogadro/runner";

type Store = ReturnType<typeof createCampaignStore>;
type CampaignLease = NonNullable<Awaited<ReturnType<Store["lease"]>>>;

export type CampaignProcessorOptions = {
  store: Pick<Store, "lease" | "persistResult" | "retryInfrastructure" | "isCancelRequested" | "renewLease">;
  execute?: typeof runFixtureCampaign;
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
        invariants: lease.selectedInvariants as string[],
        cancellation: controller.signal,
      });
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
      const persisted = await options.store.persistResult(campaignId, lease.attemptNumber, workerId, result as unknown as Record<string, unknown>);
      if (!persisted) throw new Error("Campaign result was not persisted");
      return result;
    } finally {
      if (poll) clearInterval(poll);
      options.shutdownSignal?.removeEventListener("abort", abortOnShutdown);
    }
  };
}
