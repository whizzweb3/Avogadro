import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { CHAIN_ID } from "@avogadro/shared";

const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const invariantSchema = z.object({ name: z.string().trim().min(1).max(120), template: z.string().trim().min(1).max(100), config: z.record(z.unknown()) });
export const createCampaignSchema = z.object({
  contractId: z.string().uuid(),
  snapshot: z.object({ blockNumber: z.number().int().nonnegative(), blockHash: hashSchema }),
  harnessDigest: hashSchema,
  buildDigest: hashSchema,
  seed: z.string().min(1).max(128),
  runs: z.number().int().min(1).max(1_000_000),
  depth: z.number().int().min(1).max(100_000),
  timeoutSeconds: z.number().int().min(1).max(86_400),
  invariants: z.array(invariantSchema).min(1).max(100),
});

export type AppOptions = { logger?: boolean; campaignStore?: CampaignStore; authenticate?: (request: import("fastify").FastifyRequest) => Promise<string | null> };
export interface CampaignStore {
  create(ownerId: string, input: z.infer<typeof createCampaignSchema>): Promise<{ id: string; status: "queued" }>;
  list(ownerId: string): Promise<unknown[]>;
  get(ownerId: string, id: string): Promise<unknown | null>;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, genReqId: () => crypto.randomUUID() });
  app.setErrorHandler((error, request, reply) => {
    const isZodError = error instanceof z.ZodError;
    const err = error instanceof Error ? error : new Error("Unknown error");
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
    const status = isZodError ? 400 : statusCode && statusCode < 500 ? statusCode : 500;
    if (status >= 500) request.log.error({ err }, "request failed");
    return reply.status(status).send({ error: { code: isZodError ? "VALIDATION_ERROR" : status === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR", message: isZodError ? "Request validation failed" : status < 500 ? err.message : "An internal error occurred", requestId: request.id } });
  });

  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/v1/contracts", async (request, reply) => {
    return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage and verified-source provider are not configured", requestId: request.id } });
  });
  app.post("/v1/contracts", async (request, reply) => {
    const input = z.object({ chainId: z.literal(CHAIN_ID), address: addressSchema }).parse(request.body);
    // Import resolution is deliberately not simulated. This endpoint reports that no
    // verified metadata provider is configured instead of creating fabricated records.
    return reply.status(503).send({ error: { code: "IMPORT_PROVIDER_UNAVAILABLE", message: "Verified contract import is not configured", requestId: request.id }, requested: input });
  });

  app.post("/v1/campaigns", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const input = createCampaignSchema.parse(request.body);
    const result = await options.campaignStore.create(ownerId, input);
    return reply.status(202).send(result);
  });
  app.get("/v1/campaigns", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    return options.campaignStore.list(ownerId);
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const campaign = await options.campaignStore.get(ownerId, id);
    return campaign ? campaign : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  return app;
}
