export const CHAIN_ID = 4663 as const;

export const campaignStatuses = ["draft", "queued", "preparing", "running", "passed", "failed", "cancelled", "timed_out", "error"] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];
export type HealthResponse = { status: "ok"; service: "api" };
export type CampaignProgressEvent = { id: number; campaignId: string; type: "status" | "progress" | "invariant" | "counterexample" | "log"; createdAt: string; data: Record<string, unknown> };
export type CreateCampaignInput = {
  contractId: string;
  snapshot: { blockNumber: number; blockHash: string };
  harnessDigest: string;
  buildDigest: string;
  seed: string;
  runs: number;
  depth: number;
  timeoutSeconds: number;
  invariants: Array<{ name: string; template: string; config: Record<string, unknown> }>;
};
