export const CHAIN_ID = 4663 as const;

export const campaignStatuses = ["queued", "running", "completed", "failed", "cancelled", "infrastructure_blocked"] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];
export type HealthResponse = { status: "ok"; service: "api" };
export type CampaignProgressEvent = { id: number; campaignId: string; type: "status" | "progress" | "invariant" | "counterexample" | "log"; createdAt: string; data: Record<string, unknown> };
export type CreateCampaignInput = {
  fixtureId: "vault-accounting-v1" | "replay-counterexample-v1";
  invariants: string[];
  seed: string;
  runs: number;
  depth: number;
  timeoutSeconds: number;
};
