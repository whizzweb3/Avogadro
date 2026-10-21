import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SiweMessage } from "siwe";
import type { ArtifactStorage } from "@avogadro/artifacts";
import { CHAIN_ID } from "@avogadro/shared";
import { importVerifiedContract, IngestionError, type ImportedContract } from "@avogadro/ingestion";
import { createExecutionIdentity, listInvariantTemplates } from "@avogadro/runner";

const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fixtureIds = ["vault-accounting-v1", "replay-counterexample-v1"] as const;
export const createCampaignSchema = z.object({
  fixtureId: z.enum(fixtureIds),
  invariants: z.array(z.enum(["invariant_accountingMatchesSuccessfulActions", "invariant_replayValueRemainsZero"])).min(1).max(4).optional(),
  templateIds: z.array(z.string().min(1).max(80)).min(1).max(4).optional(),
  seed: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  runs: z.number().int().min(1).max(10_000),
  depth: z.number().int().min(1).max(512),
  timeoutSeconds: z.number().int().min(1).max(300),
}).strict().superRefine((input, ctx) => {
  if (!input.invariants && !input.templateIds) ctx.addIssue({ code: "custom", message: "Select at least one supported invariant template", path: ["templateIds"] });
  if (input.invariants && input.templateIds) ctx.addIssue({ code: "custom", message: "Use templateIds or invariants, not both", path: ["templateIds"] });
  if (input.templateIds && new Set(input.templateIds).size !== input.templateIds.length) ctx.addIssue({ code: "custom", message: "Template selections must be unique", path: ["templateIds"] });
});

export type AuthStore = {
  issueNonce(nonce: string, domain: string, chainId: number, expiresAt: Date): Promise<void>;
  consumeNonce(nonce: string, domain: string, chainId: number): Promise<boolean>;
  createSession(walletAddress: string, tokenHash: string, csrfHash: string, expiresAt: Date): Promise<string>;
  getSession(tokenHash: string): Promise<{ userId: string; csrfHash: string | null; expiresAt: Date; revokedAt: Date | null } | null>;
  revokeSession(tokenHash: string): Promise<void>;
};
export type SiweVerifier = (input: { message: string; signature: string; domain: string; uri: string; chainId: 4663 }) => Promise<{ address: string; nonce: string; verified: boolean }>;
export type AppOptions = { logger?: boolean; campaignStore?: CampaignStore; contractStore?: ContractStore; contractImporter?: ContractImporter; authStore?: AuthStore; artifactStorage?: Pick<ArtifactStorage, "get" | "delete">; siweConfig?: { domain: string; uri: string; chainId: 4663 }; siweVerifier?: SiweVerifier; authenticate?: (request: import("fastify").FastifyRequest) => Promise<string | null> };
export interface CampaignStore {
  create(ownerId: string, input: import("@avogadro/db").CampaignCreate, idempotencyKey: string): Promise<{ id: string; status: "queued" }>;
  list(ownerId: string, filter?: { status?: string; fixtureId?: typeof fixtureIds[number]; offset: number; limit: number }): Promise<unknown>;
  get(ownerId: string, id: string): Promise<unknown | null>;
  events?(ownerId: string, id: string, after: number, limit: number): Promise<unknown | null>;
  findings?(ownerId: string, id: string): Promise<unknown | null>;
  getArtifact?(ownerId: string, campaignId: string, artifactId: string): Promise<{ id: string; campaignId: string; name: string; objectKey: string; mediaType: string; digest: string; byteCount: number; retainUntil: Date | null } | null>;
  cancel(ownerId: string, id: string): Promise<unknown | null>;
  replay(ownerId: string, id: string): Promise<unknown | null>;
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
  const authRate = new Map<string, { count: number; expiresAt: number }>();
  const allowAuthAttempt = (ip: string, action: string, limit: number) => {
    const now = Date.now();
    if (authRate.size > 4096) for (const [key, entry] of authRate) if (entry.expiresAt <= now) authRate.delete(key);
    const key = `${action}:${ip}`;
    const current = authRate.get(key);
    if (!current || current.expiresAt <= now) {
      if (authRate.size >= 8192) return false;
      authRate.set(key, { count: 1, expiresAt: now + 60_000 });
      return true;
    }
    if (current.count >= limit) return false;
    current.count++;
    return true;
  };
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
  const authConfig = options.siweConfig ?? (process.env.SIWE_DOMAIN && process.env.SIWE_URI && process.env.SIWE_CHAIN_ID === "4663" ? { domain: process.env.SIWE_DOMAIN, uri: process.env.SIWE_URI, chainId: 4663 as const } : undefined);
  const cookieValue = (request: import("fastify").FastifyRequest, name: string) => {
    const raw = request.headers.cookie ?? "";
    return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
  const verifySiwe: SiweVerifier = options.siweVerifier ?? (async ({ message: rawMessage, signature, domain, uri, chainId }) => {
    const message = new SiweMessage(rawMessage);
    const now = Date.now();
    const issuedAt = message.issuedAt ? Date.parse(message.issuedAt) : Number.NaN;
    if (message.domain !== domain || message.uri !== uri || message.chainId !== chainId || message.version !== "1" || !Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > 5 * 60_000 || (message.expirationTime && Date.parse(message.expirationTime) <= now)) return { address: message.address, nonce: message.nonce, verified: false };
    const verified = await message.verify({ signature, domain, nonce: message.nonce, time: new Date(now).toISOString() }, { suppressExceptions: true });
    return { address: message.address, nonce: message.nonce, verified: verified.success };
  });
  const sessionOwner = async (request: import("fastify").FastifyRequest) => {
    if (options.authenticate) return options.authenticate(request);
    if (!options.authStore) return null;
    const token = cookieValue(request, "avogadro_session");
    if (!token) return null;
    const session = await options.authStore.getSession(tokenHash(token));
    if (!session) return null;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const csrf = cookieValue(request, "avogadro_csrf");
      const header = request.headers["x-csrf-token"];
      if (!csrf || header !== csrf || !session.csrfHash || tokenHash(csrf) !== session.csrfHash) return null;
    }
    return session.userId;
  };
  app.get("/v1/auth/nonce", async (_request, reply) => {
    if (!options.authStore || !authConfig) return reply.status(503).send({ error: { code: "SIWE_UNCONFIGURED", message: "SIWE domain, URI, chain, and session storage must be configured" } });
    if (!allowAuthAttempt(_request.ip, "nonce", 30)) return reply.status(429).send({ error: { code: "AUTH_RATE_LIMITED", message: "Too many authentication requests; try again shortly" } });
    const nonce = randomBytes(24).toString("hex");
    await options.authStore.issueNonce(nonce, authConfig.domain, authConfig.chainId, new Date(Date.now() + 5 * 60_000));
    return { nonce, domain: authConfig.domain, uri: authConfig.uri, chainId: authConfig.chainId, expiresInSeconds: 300 };
  });
  app.post("/v1/auth/verify", async (request, reply) => {
    if (!options.authStore || !authConfig) return reply.status(503).send({ error: { code: "SIWE_UNCONFIGURED", message: "SIWE domain, URI, chain, and session storage must be configured" } });
    if (!allowAuthAttempt(request.ip, "verify", 15)) return reply.status(429).send({ error: { code: "AUTH_RATE_LIMITED", message: "Too many authentication requests; try again shortly" } });
    const body = z.object({ message: z.string().min(1).max(4096), signature: z.string().regex(/^0x[a-fA-F0-9]+$/) }).parse(request.body);
    try {
      const verified = await verifySiwe({ message: body.message, signature: body.signature, domain: authConfig.domain, uri: authConfig.uri, chainId: authConfig.chainId });
      if (!verified.verified || !/^0x[a-fA-F0-9]{40}$/.test(verified.address) || !(await options.authStore.consumeNonce(verified.nonce, authConfig.domain, authConfig.chainId))) return reply.status(401).send({ error: { code: "SIWE_INVALID", message: "SIWE signature is invalid or its nonce has expired or been used" } });
      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      await options.authStore.createSession(verified.address, tokenHash(sessionToken), tokenHash(csrfToken), new Date(Date.now() + 12 * 60 * 60_000));
      const secure = authConfig.uri.startsWith("https://") ? "; Secure" : "";
      reply.header("set-cookie", [
        `avogadro_session=${sessionToken}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=43200`,
        `avogadro_csrf=${csrfToken}; Path=/;${secure} SameSite=Strict; Max-Age=43200`,
      ]);
      return { authenticated: true, address: verified.address, csrfToken };
    } catch (error) {
      void error;
      return reply.status(401).send({ error: { code: "SIWE_INVALID", message: "SIWE message or signature is invalid" } });
    }
  });
  app.get("/v1/auth/session", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    return ownerId ? { authenticated: true, ownerId } : reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
  });
  app.post("/v1/auth/logout", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authenticated session and valid CSRF token required" } });
    const token = cookieValue(request, "avogadro_session");
    if (token && options.authStore) await options.authStore.revokeSession(tokenHash(token));
    const secure = authConfig?.uri.startsWith("https://") ? "; Secure" : "";
    reply.header("set-cookie", [`avogadro_session=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`, `avogadro_csrf=; Path=/${secure}; SameSite=Strict; Max-Age=0`]);
    return { authenticated: false };
  });
  function resolveCampaignInput(input: z.infer<typeof createCampaignSchema>) {
    const root = resolve(fileURLToPath(new URL("../../../packages/contracts", import.meta.url)));
    const digest = createHash("sha256");
    const fixtureFiles: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "out" || entry.name === "cache" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Trusted fixture tree cannot contain symlinks");
        if (entry.isDirectory()) collect(absolute);
        else if (entry.isFile()) fixtureFiles.push(absolute);
      }
    };
    collect(root);
    fixtureFiles.sort();
    for (const absolute of fixtureFiles) { digest.update(absolute.slice(root.length + 1).replaceAll("\\", "/")); digest.update("\0"); digest.update(readFileSync(absolute)); digest.update("\0"); }
    const sourceDigest = digest.digest("hex");
    const availableTemplates = listInvariantTemplates(input.fixtureId);
    const selectedTemplates = input.templateIds
      ? input.templateIds.map((id) => availableTemplates.find((entry) => entry.id === id))
      : (input.invariants ?? []).map((name) => availableTemplates.find((entry) => entry.invariantName === name));
    if (!selectedTemplates.length || selectedTemplates.some((template) => !template)) throw Object.assign(new Error("Selected invariant template is not supported for this fixture"), { statusCode: 400 });
    const canonicalTemplates = selectedTemplates.filter((template): template is NonNullable<typeof template> => Boolean(template)).sort((a, b) => a.id.localeCompare(b.id));
    const templateIds = canonicalTemplates.map((template) => template.id);
    const selectedInvariants = canonicalTemplates.map((template) => template.invariantName);
    const executionDigest = createExecutionIdentity({ fixtureId: input.fixtureId, runs: input.runs, depth: input.depth, seed: input.seed.toLowerCase(), templateIds }, sourceDigest);
    return { fixtureId: input.fixtureId, fixtureVersion: "1.0.0", selectedInvariants, templateIds, runs: input.runs, depth: input.depth, seed: input.seed.toLowerCase(), timeoutSeconds: input.timeoutSeconds, sourceDigest, executionDigest };
  }
  app.get("/v1/contracts", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    return options.contractStore.list(ownerId);
  });
  app.post("/v1/contracts", async (request, reply) => {
    const ownerId = await sessionOwner(request);
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
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const contract = await options.contractStore.get(ownerId, id);
    return contract ? contract : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Contract not found", requestId: request.id } });
  });
  app.get<{ Params: { id: string } }>("/v1/contracts/:id/functions", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.contractStore) return reply.status(503).send({ error: { code: "CONTRACT_SERVICE_UNAVAILABLE", message: "Contract storage is not configured", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const contract = await options.contractStore.get(ownerId, id) as Record<string, unknown> | null;
    if (!contract) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Contract not found", requestId: request.id } });
    const abi = Array.isArray(contract.abi) ? contract.abi : [];
    const functions = abi.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).type === "function").slice(0, 250).map((entry) => {
      const parameters = (value: unknown) => Array.isArray(value) ? value.slice(0, 32).map((item) => item && typeof item === "object" && !Array.isArray(item) ? { name: typeof (item as Record<string, unknown>).name === "string" ? String((item as Record<string, unknown>).name).slice(0, 128) : "", type: typeof (item as Record<string, unknown>).type === "string" ? String((item as Record<string, unknown>).type).slice(0, 128) : "unknown", indexed: (item as Record<string, unknown>).indexed === true } : { name: "", type: "unknown", indexed: false }) : [];
      const name = typeof entry.name === "string" ? entry.name.slice(0, 128) : "unknown";
      const inputs = parameters(entry.inputs);
      return { name, signature: `${name}(${inputs.map((input) => input.type).join(",")})`, stateMutability: typeof entry.stateMutability === "string" ? entry.stateMutability : "unknown", inputs, outputs: parameters(entry.outputs) };
    });
    return { contractId: id, chainId: contract.chainId, address: contract.address, executionEnabled: false, functions };
  });

  app.post("/v1/campaigns", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const input = createCampaignSchema.parse(request.body);
    if (input.fixtureId === "vault-accounting-v1" && input.invariants?.some((name) => name !== "invariant_accountingMatchesSuccessfulActions")) return reply.status(400).send({ error: { code: "INVARIANT_FIXTURE_MISMATCH", message: "Selected invariant is not part of the fixture", requestId: request.id } });
    if (input.fixtureId === "replay-counterexample-v1" && input.invariants?.some((name) => name !== "invariant_replayValueRemainsZero")) return reply.status(400).send({ error: { code: "INVARIANT_FIXTURE_MISMATCH", message: "Selected invariant is not part of the fixture", requestId: request.id } });
    if (input.templateIds?.some((id) => !listInvariantTemplates(input.fixtureId).some((template) => template.id === id))) return reply.status(400).send({ error: { code: "UNSUPPORTED_INVARIANT_TEMPLATE", message: "Selected invariant template is not supported for this fixture", requestId: request.id } });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return reply.status(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key header is required", requestId: request.id } });
    const result = await options.campaignStore.create(ownerId, resolveCampaignInput(input), key);
    return reply.status(202).send(result);
  });
  app.get("/v1/campaigns", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const query = z.object({
      status: z.enum(["draft", "queued", "preparing", "running", "passed", "failed", "cancelled", "timed_out", "error", "completed", "infrastructure_blocked"]).optional(),
      fixtureId: z.enum(fixtureIds).optional(),
      cursor: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return reply.status(400).send({ error: { code: "INVALID_CURSOR", message: "Campaign cursor is invalid", requestId: request.id } });
    return options.campaignStore.list(ownerId, { status: query.status, fixtureId: query.fixtureId, offset, limit: query.limit });
  });
  app.get("/v1/invariants/templates", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const query = z.object({ fixtureId: z.enum(fixtureIds).optional() }).parse(request.query);
    return { fixtureId: query.fixtureId ?? null, executionMode: "trusted_fixture", templates: listInvariantTemplates(query.fixtureId) };
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const campaign = await options.campaignStore.get(ownerId, id);
    return campaign ? campaign : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/events", async (request, reply) => {
    if (!options.campaignStore?.events) return reply.status(503).send({ error: { code: "CAMPAIGN_EVENTS_UNAVAILABLE", message: "Campaign event retrieval is not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const id = z.string().uuid().parse(request.params.id);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const page = await options.campaignStore.events(ownerId, id, query.after, query.limit);
    return page ?? reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/findings", async (request, reply) => {
    if (!options.campaignStore?.findings) return reply.status(503).send({ error: { code: "CAMPAIGN_FINDINGS_UNAVAILABLE", message: "Campaign findings are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const findings = await options.campaignStore.findings(ownerId, z.string().uuid().parse(request.params.id));
    return findings ?? reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/counterexample", async (request, reply) => {
    if (!options.campaignStore?.findings) return reply.status(503).send({ error: { code: "CAMPAIGN_FINDINGS_UNAVAILABLE", message: "Counterexample retrieval is not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    reply.header("cache-control", "private, no-store");
    const findings = await options.campaignStore.findings(ownerId, z.string().uuid().parse(request.params.id));
    if (!findings) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
    const value = findings as { findings?: Array<Record<string, unknown>> };
    const finding = value.findings?.find((item) => item.counterexample);
    if (!finding) return { counterexample: null };
    const counterexample = finding.counterexample as Record<string, unknown>;
    if (Array.isArray(counterexample.steps) && typeof counterexample.stepsSha256 === "string" && createHash("sha256").update(canonicalJson(counterexample.steps)).digest("hex") !== counterexample.stepsSha256) {
      return reply.status(502).send({ error: { code: "COUNTEREXAMPLE_INTEGRITY_FAILURE", message: "Structured call sequence failed its integrity check", requestId: request.id } });
    }
    const artifact = counterexample.artifact as { id?: string } | null;
    if (artifact?.id && options.campaignStore.getArtifact && options.artifactStorage) {
      const row = await options.campaignStore.getArtifact(ownerId, z.string().uuid().parse(request.params.id), artifact.id);
      if (!row) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Counterexample evidence not found", requestId: request.id } });
      if (row.retainUntil && row.retainUntil.getTime() <= Date.now()) {
        await options.artifactStorage.delete(row.objectKey).catch(() => undefined);
        return reply.status(410).send({ error: { code: "ARTIFACT_EXPIRED", message: "Counterexample evidence retention period has expired", requestId: request.id } });
      }
      try {
        const bytes = await options.artifactStorage.get(row.objectKey, row.byteCount, row.digest);
        return { counterexample: { ...counterexample, content: bytes.toString("utf8") } };
      } catch {
        return reply.status(502).send({ error: { code: "ARTIFACT_INTEGRITY_FAILURE", message: "Counterexample evidence could not be verified", requestId: request.id } });
      }
    }
    return { counterexample };
  });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/report", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence is not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    reply.header("cache-control", "private, no-store");
    const campaign = await options.campaignStore.get(ownerId, z.string().uuid().parse(request.params.id)) as Record<string, unknown> | null;
    if (!campaign) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
    const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    const reportPayload = {
      reportVersion: "1",
      campaign: { id: campaign.id, parentCampaignId: campaign.parentCampaignId, fixtureId: campaign.fixtureId, fixtureVersion: campaign.fixtureVersion, selectedInvariants: campaign.selectedInvariants, templateIds: campaign.templateIds, status: campaign.status, outcome: campaign.outcome, failureKind: campaign.failureKind, failureCode: campaign.failureCode, seed: campaign.seed, runs: campaign.runs, depth: campaign.depth, timeoutSeconds: campaign.timeoutSeconds, engineVersion: campaign.engineVersion, sourceDigest: campaign.sourceDigest, executionDigest: campaign.executionDigest, buildDigest: campaign.buildDigest, snapshotBlockNumber: campaign.snapshotBlockNumber, snapshotBlockHash: campaign.snapshotBlockHash, createdAt: campaign.createdAt, startedAt: campaign.startedAt, finishedAt: campaign.finishedAt },
      attempts: records(campaign.attempts).map((attempt) => ({ attemptNumber: attempt.attemptNumber, status: attempt.status, errorCode: attempt.errorCode, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt })),
      events: records(campaign.events).slice(-100).map((event) => ({ sequence: event.sequence, eventType: event.eventType, createdAt: event.createdAt })),
      findings: options.campaignStore.findings ? (await options.campaignStore.findings(ownerId, String(campaign.id))) : { findings: [] },
      artifacts: records(campaign.artifacts).map((artifact) => ({ id: artifact.id, name: artifact.name, mediaType: artifact.mediaType, digest: artifact.digest, byteCount: artifact.byteCount, retainUntil: artifact.retainUntil })),
    };
    const evidenceDigest = createHash("sha256").update(canonicalJson(reportPayload)).digest("hex");
    return { ...reportPayload, evidenceDigest };
  });
  app.get<{ Params: { id: string; artifactId: string } }>("/v1/campaigns/:id/artifacts/:artifactId", async (request, reply) => {
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    if (!options.campaignStore?.getArtifact || !options.artifactStorage) return reply.status(503).send({ error: { code: "ARTIFACT_STORAGE_UNAVAILABLE", message: "Artifact storage is not configured", requestId: request.id } });
    const campaignId = z.string().uuid().parse(request.params.id);
    const artifactId = z.string().uuid().parse(request.params.artifactId);
    const artifact = await options.campaignStore.getArtifact(ownerId, campaignId, artifactId);
    if (!artifact) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Artifact not found", requestId: request.id } });
    if (artifact.retainUntil && artifact.retainUntil.getTime() <= Date.now()) {
      await options.artifactStorage.delete(artifact.objectKey).catch(() => undefined);
      return reply.status(410).send({ error: { code: "ARTIFACT_EXPIRED", message: "Artifact retention period has expired", requestId: request.id } });
    }
    try {
      const body = await options.artifactStorage.get(artifact.objectKey, artifact.byteCount, artifact.digest);
      reply.header("content-disposition", `attachment; filename="${artifact.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
      reply.header("cache-control", "private, no-store");
      return reply.type(artifact.mediaType).send(body);
    } catch {
      return reply.status(502).send({ error: { code: "ARTIFACT_INTEGRITY_FAILURE", message: "Artifact could not be verified", requestId: request.id } });
    }
  });
  app.post<{ Params: { id: string } }>("/v1/campaigns/:id/cancel", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const result = await options.campaignStore.cancel(ownerId, z.string().uuid().parse(request.params.id));
    return result ?? reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  app.post<{ Params: { id: string } }>("/v1/campaigns/:id/replay", async (request, reply) => {
    if (!options.campaignStore) return reply.status(503).send({ error: { code: "CAMPAIGN_SERVICE_UNAVAILABLE", message: "Campaign persistence and queue are not configured", requestId: request.id } });
    const ownerId = await sessionOwner(request);
    if (!ownerId) return reply.status(401).send({ error: { code: "UNAUTHENTICATED", message: "Authentication required", requestId: request.id } });
    const result = await options.campaignStore.replay(ownerId, z.string().uuid().parse(request.params.id));
    return result ? reply.status(202).send(result) : reply.status(404).send({ error: { code: "NOT_FOUND", message: "Campaign not found", requestId: request.id } });
  });
  return app;
}
