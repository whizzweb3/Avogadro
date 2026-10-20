import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CHAIN_ID } from "@avogadro/shared";
import { importVerifiedContract, IngestionError, type ImportedContract } from "@avogadro/ingestion";

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

export type AppOptions = { logger?: boolean; campaignStore?: CampaignStore; contractStore?: ContractStore; contractImporter?: ContractImporter; authenticate?: (request: import("fastify").FastifyRequest) => Promise<string | null> };
export interface CampaignStore {
  create(ownerId: string, input: z.infer<typeof createCampaignSchema>): Promise<{ id: string; status: "queued" }>;
  list(ownerId: string): Promise<unknown[]>;
  get(ownerId: string, id: string): Promise<unknown | null>;
}
export interface ContractStore {
  importVerified(ownerId: string, idempotencyKey: string, importData: ImportedContract): Promise<unknown>;
  getImportByIdempotency(ownerId: string, idempotencyKey: string, request: { chainId: number; address: string }): Promise<unknown | null>;
  list(ownerId: string): Promise<unknown[]>;
  get(ownerId: string, id: string): Promise<unknown | null>;
}
export interface ContractImporter { importVerified(input: { chainId: 4663; address: string }): Promise<ImportedContract> }

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, genReqId: () => crypto.randomUUID() });
  app.setErrorHandler((error, request, reply) => {
    const isZodError = error instanceof z.ZodError;
    const err = error instanceof Error ? error : new Error("Unknown error");
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
    const status = isZodError ? 400 : statusCode && statusCode < 500 ? statusCode : 500;
    if (status >= 500) request.log.error({ err }, "request failed");
    const code = isZodError ? "VALIDATION_ERROR" : status === 409 ? "CONFLICT" : status === 400 ? "BAD_REQUEST" : status === 401 ? "UNAUTHENTICATED" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
    return reply.status(status).send({ error: { code, message: isZodError ? "Request validation failed" : status < 500 ? err.message : "An internal error occurred", requestId: request.id } });
  });

  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/v1/contracts", async (request, reply) => {
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    return options.contractStore.list(ownerId);
  });
  app.post("/v1/contracts", async (request, reply) => {
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const input = z.object({ chainId: z.literal(CHAIN_ID), address: addressSchema }).parse(request.body);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return reply.status(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key header is required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_STORAGE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    const prior = await options.contractStore.getImportByIdempotency(ownerId, key, input);
    if (prior) return reply.status(200).send(prior);
    let imported: ImportedContract;
    try { imported = await (options.contractImporter ?? { importVerified: importVerifiedContract }).importVerified(input); }
    catch (error) {
      if (error instanceof IngestionError) return reply.status(error.code === "EXPLORER_UNAVAILABLE" || error.code === "RPC_ERROR" ? 503 : 422).send({ error: { code: error.code, message: error.message, requestId: request.id } });
      throw error;
    }
    const data = z.object({
      chainId: z.literal(CHAIN_ID), address: addressSchema, verified: z.literal(true), name: z.string().min(1), language: z.string().min(1), compilerVersion: z.string().min(1), compilerSettings: z.record(z.unknown()), abi: z.array(z.unknown()),
      sourceFiles: z.array(z.object({ path: z.string().min(1), content: z.string(), sha256: hashSchema })).min(1),
      runtimeBytecode: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/), runtimeBytecodeHash: hashSchema,
      verification: z.object({ provider: z.literal("blockscout-v2"), url: z.string().url(), fetchedAt: z.string().datetime(), responseSha256: hashSchema, explorerVerifiedAt: z.string().nullable(), isFullyVerified: z.boolean(), explorerBytecodeChanged: z.boolean() }),
      proxy: z.union([z.null(), z.object({ type: z.string().nullable(), implementationAddress: addressSchema, implementation: z.unknown() })]),
    }).parse(imported);
    if (data.chainId !== input.chainId || data.address.toLowerCase() !== input.address.toLowerCase()) return reply.status(502).send({ error: { code: "IMPORT_PROVIDER_INVALID_RESPONSE", message: "Verified import provider returned mismatched contract identity", requestId: request.id } });
    if (!data.verification.isFullyVerified || data.verification.explorerBytecodeChanged || data.sourceFiles.some((source) => source.path.startsWith("/") || source.path.split(/[\\/]/).includes("..") || source.sha256 !== `0x${createHash("sha256").update(source.content).digest("hex")}`) || new Set(data.sourceFiles.map((source) => source.path)).size !== data.sourceFiles.length) {
      return reply.status(422).send({ error: { code: "IMPORT_PROVIDER_INVALID_RESPONSE", message: "Verified import provider returned inconsistent verification or source data", requestId: request.id } });
    }
    return reply.status(201).send(await options.contractStore.importVerified(ownerId, key, data as ImportedContract));
  });
  app.get<{ Params: { id: string } }>("/v1/contracts/:id", async (request, reply) => {
    const ownerId = options.authenticate ? await options.authenticate(request) : null;
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const contract = await options.contractStore.get(ownerId, id);
    return contract ? contract : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Contract not found", requestId: request.id } });
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
