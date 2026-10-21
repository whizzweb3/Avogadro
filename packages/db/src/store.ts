import { createHash } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ImportedContract } from "@avogadro/ingestion";
import * as schema from "./schema.js";

export type AvogadroDatabase = PostgresJsDatabase<typeof schema>;

export function createDatabase(url: string = process.env.DATABASE_URL ?? "postgres://avogadro:avogadro@localhost:5432/avogadro") {
  const client = postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const importOperation = "contract-import-v1";

function requestDigest(input: { chainId: number; address: string }): string {
  return sha256(JSON.stringify({ chainId: input.chainId, address: input.address.toLowerCase() }));
}

function idempotencyConflict(): Error & { statusCode: number } {
  return Object.assign(new Error("Idempotency key was already used for a different contract request"), { statusCode: 409 });
}

async function getOwnedContract(db: AvogadroDatabase, ownerId: string, id: string) {
  const [contract] = await db.select().from(schema.contracts).where(and(eq(schema.contracts.id, id), eq(schema.contracts.ownerId, ownerId))).limit(1);
  if (!contract) return null;
  const sources = await db.select().from(schema.contractSources).where(eq(schema.contractSources.contractId, id));
  return { ...contract, sources };
}

export function createContractStore(db: AvogadroDatabase) {
  return {
    async getImportByIdempotency(ownerId: string, idempotencyKey: string, request: { chainId: number; address: string }) {
      const [prior] = await db.select().from(schema.idempotencyRecords).where(and(
        eq(schema.idempotencyRecords.ownerId, ownerId), eq(schema.idempotencyRecords.operation, importOperation), eq(schema.idempotencyRecords.keyHash, sha256(idempotencyKey)),
      )).limit(1);
      if (!prior) return null;
      if (prior.requestDigest !== requestDigest(request)) throw idempotencyConflict();
      return getOwnedContract(db, ownerId, prior.resourceId);
    },
    async importVerified(ownerId: string, idempotencyKey: string, imported: ImportedContract) {
      const keyHash = sha256(idempotencyKey);
      const digest = requestDigest(imported);
      const [priorKey] = await db.select().from(schema.idempotencyRecords).where(and(
        eq(schema.idempotencyRecords.ownerId, ownerId), eq(schema.idempotencyRecords.operation, importOperation), eq(schema.idempotencyRecords.keyHash, keyHash),
      )).limit(1);
      if (priorKey) {
        if (priorKey.requestDigest !== digest) throw idempotencyConflict();
        const existing = await getOwnedContract(db, ownerId, priorKey.resourceId);
        if (!existing) throw new Error("Idempotency record references a missing contract");
        return existing;
      }

      try {
        return await db.transaction(async (tx) => {
          const [existingAddress] = await tx.select().from(schema.contracts).where(and(
            eq(schema.contracts.ownerId, ownerId), eq(schema.contracts.chainId, imported.chainId), eq(schema.contracts.address, imported.address.toLowerCase()),
          )).limit(1);
          let contractId = existingAddress?.id;
          if (!existingAddress) {
            const [created] = await tx.insert(schema.contracts).values({
              ownerId, chainId: imported.chainId, address: imported.address.toLowerCase(), importStatus: "verified", verified: true,
              name: imported.name, compilerVersion: imported.compilerVersion, abi: imported.abi,
              metadata: { language: imported.language, compilerSettings: imported.compilerSettings, runtimeBytecode: imported.runtimeBytecode, runtimeBytecodeHash: imported.runtimeBytecodeHash, verification: imported.verification, proxy: imported.proxy },
              provenanceUrl: imported.verification.url, provenanceFetchedAt: new Date(imported.verification.fetchedAt),
            }).returning({ id: schema.contracts.id });
            contractId = created.id;
            await tx.insert(schema.contractSources).values(imported.sourceFiles.map((source) => ({
              contractId: contractId!, path: source.path, contentDigest: source.sha256, sourceText: source.content,
              provenanceUrl: imported.verification.url, provenanceFetchedAt: new Date(imported.verification.fetchedAt),
            })));
          }
          await tx.insert(schema.idempotencyRecords).values({ ownerId, operation: importOperation, keyHash, requestDigest: digest, resourceId: contractId! });
          return await getOwnedContract(tx as unknown as AvogadroDatabase, ownerId, contractId!) as NonNullable<Awaited<ReturnType<typeof getOwnedContract>>>;
        });
      } catch (error) {
        // Concurrent retries race on the owner/operation/key unique index. Resolve only
        // from the committed idempotency record; never return an unscoped record.
        const [winner] = await db.select().from(schema.idempotencyRecords).where(and(
          eq(schema.idempotencyRecords.ownerId, ownerId), eq(schema.idempotencyRecords.operation, importOperation), eq(schema.idempotencyRecords.keyHash, keyHash),
        )).limit(1);
        if (winner) {
          if (winner.requestDigest !== digest) throw idempotencyConflict();
          const resolved = await getOwnedContract(db, ownerId, winner.resourceId);
          if (!resolved) throw new Error("Idempotency record references a missing contract", { cause: error });
          return resolved;
        }
        // A separate idempotency key can race with another import for the same
        // owner/address. Bind it to the winning immutable contract record.
        const [sameAddress] = await db.select().from(schema.contracts).where(and(
          eq(schema.contracts.ownerId, ownerId), eq(schema.contracts.chainId, imported.chainId), eq(schema.contracts.address, imported.address.toLowerCase()),
        )).limit(1);
        if (!sameAddress) throw error;
        const [record] = await db.insert(schema.idempotencyRecords).values({ ownerId, operation: importOperation, keyHash, requestDigest: digest, resourceId: sameAddress.id }).onConflictDoNothing().returning({ id: schema.idempotencyRecords.id });
        if (!record) {
          const [raced] = await db.select().from(schema.idempotencyRecords).where(and(eq(schema.idempotencyRecords.ownerId, ownerId), eq(schema.idempotencyRecords.operation, importOperation), eq(schema.idempotencyRecords.keyHash, keyHash))).limit(1);
          if (!raced || raced.requestDigest !== digest) throw idempotencyConflict();
        }
        const resolved = await getOwnedContract(db, ownerId, sameAddress.id);
        if (!resolved) throw new Error("Contract disappeared while resolving concurrent import", { cause: error });
        return resolved;
      }
    },
    async list(ownerId: string) {
      return db.select({ id: schema.contracts.id, chainId: schema.contracts.chainId, address: schema.contracts.address, name: schema.contracts.name, importStatus: schema.contracts.importStatus, verified: schema.contracts.verified, compilerVersion: schema.contracts.compilerVersion, provenanceUrl: schema.contracts.provenanceUrl, createdAt: schema.contracts.createdAt }).from(schema.contracts).where(eq(schema.contracts.ownerId, ownerId));
    },
    async get(ownerId: string, id: string) { return getOwnedContract(db, ownerId, id); },
  };
}

export type CampaignCreate = { fixtureId: "vault-accounting-v1" | "replay-counterexample-v1"; fixtureVersion: string; executionDigest: string; selectedInvariants: string[]; seed: string; runs: number; depth: number; timeoutSeconds: number; sourceDigest: string };
const campaignOperation = "campaign-create-v1";
const digestCanonical = (value: unknown) => sha256(JSON.stringify(value));
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

export function createCampaignStore(db: AvogadroDatabase) {
  async function owned(ownerId: string, id: string) {
    const [campaign] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.ownerId, ownerId))).limit(1);
    if (!campaign) return null;
    const attempts = await db.select().from(schema.campaignAttempts).where(eq(schema.campaignAttempts.campaignId, id));
    const events = await db.select().from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, id)).orderBy(schema.campaignEvents.sequence);
    return { ...campaign, attempts, events };
  }
  return {
    async create(ownerId: string, input: CampaignCreate, idempotencyKey: string) {
      const keyHash = sha256(idempotencyKey);
      const requestDigest = digestCanonical(input);
      const [prior] = await db.select().from(schema.campaignIdempotency).where(and(eq(schema.campaignIdempotency.ownerId, ownerId), eq(schema.campaignIdempotency.operation, campaignOperation), eq(schema.campaignIdempotency.keyHash, keyHash))).limit(1);
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw conflict("Idempotency key was used with different campaign configuration");
        return { id: prior.campaignId, status: "queued" as const };
      }
      try {
        return await db.transaction(async (tx) => {
          const [campaign] = await tx.insert(schema.campaigns).values({
            ownerId, contractId: null, fixtureId: input.fixtureId, fixtureVersion: input.fixtureVersion, executionDigest: input.executionDigest,
            selectedInvariants: input.selectedInvariants, snapshotBlockNumber: null, snapshotBlockHash: null, sourceDigest: input.sourceDigest,
            harnessDigest: null, buildDigest: null, seed: input.seed, runs: input.runs, depth: input.depth, timeoutSeconds: input.timeoutSeconds,
            status: "queued", engineVersion: "forge-1.8.5/solc-0.8.26",
          }).returning({ id: schema.campaigns.id });
          await tx.insert(schema.campaignAttempts).values({ campaignId: campaign.id, attemptNumber: 1, status: "queued" });
          await tx.insert(schema.campaignEvents).values({ campaignId: campaign.id, sequence: 1, eventType: "queued", payload: { status: "queued" } });
          await tx.insert(schema.outbox).values({ topic: "campaign.execute", aggregateId: campaign.id, payload: { campaignId: campaign.id } });
          await tx.insert(schema.campaignIdempotency).values({ ownerId, operation: campaignOperation, keyHash, requestDigest, campaignId: campaign.id });
          return { id: campaign.id, status: "queued" as const };
        });
      } catch (error) {
        const [winner] = await db.select().from(schema.campaignIdempotency).where(and(eq(schema.campaignIdempotency.ownerId, ownerId), eq(schema.campaignIdempotency.operation, campaignOperation), eq(schema.campaignIdempotency.keyHash, keyHash))).limit(1);
        if (!winner) throw error;
        if (winner.requestDigest !== requestDigest) throw conflict("Idempotency key was used with different campaign configuration");
        return { id: winner.campaignId, status: "queued" as const };
      }
    },
    async list(ownerId: string) { return db.select().from(schema.campaigns).where(eq(schema.campaigns.ownerId, ownerId)).orderBy(schema.campaigns.createdAt); },
    get: owned,
    async cancel(ownerId: string, id: string) {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.ownerId, ownerId))).for("update").limit(1);
        if (!current) return null;
        if (["completed", "passed", "failed", "cancelled", "timed_out", "error", "infrastructure_blocked"].includes(current.status)) return { id, status: current.status, cancelRequestedAt: current.cancelRequestedAt };
        const requestedAt = current.cancelRequestedAt ?? new Date();
        const queued = current.status === "queued";
        const [updated] = await tx.update(schema.campaigns).set({
          cancelRequestedAt: requestedAt,
          ...(queued ? { status: "cancelled" as const, outcome: null, failureKind: "cancelled", failureCode: "cancelled_before_start", finishedAt: requestedAt } : {}),
        }).where(eq(schema.campaigns.id, id)).returning();
        if (queued) {
          await tx.update(schema.campaignAttempts).set({ status: "cancelled", finishedAt: requestedAt, leaseExpiresAt: null, errorCode: "cancelled_before_start" }).where(and(eq(schema.campaignAttempts.campaignId, id), eq(schema.campaignAttempts.status, "queued")));
        }
        const next = Number((await tx.select({ max: sql`coalesce(max(${schema.campaignEvents.sequence}), 0)` }).from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, id)))[0]?.max ?? 0) + 1;
        await tx.insert(schema.campaignEvents).values({ campaignId: id, sequence: next, eventType: queued ? "cancelled" : "cancel_requested", payload: { at: updated.cancelRequestedAt?.toISOString(), beforeStart: queued } });
        return { id, status: updated.status, cancelRequestedAt: updated.cancelRequestedAt };
      });
    },
    async replay(ownerId: string, id: string) {
      const source = await owned(ownerId, id);
      if (!source || !source.fixtureId || !source.fixtureVersion || !source.executionDigest || !source.sourceDigest || !Array.isArray(source.selectedInvariants)) return null;
      return db.transaction(async (tx) => {
        const [replay] = await tx.insert(schema.campaigns).values({
          ownerId, contractId: null, parentCampaignId: id, fixtureId: source.fixtureId, fixtureVersion: source.fixtureVersion, executionDigest: source.executionDigest,
          selectedInvariants: source.selectedInvariants, status: "queued", snapshotBlockNumber: source.snapshotBlockNumber, snapshotBlockHash: source.snapshotBlockHash, sourceDigest: source.sourceDigest,
          harnessDigest: source.harnessDigest, buildDigest: source.buildDigest, seed: source.seed, runs: source.runs, depth: source.depth, timeoutSeconds: source.timeoutSeconds, engineVersion: source.engineVersion,
        }).returning({ id: schema.campaigns.id });
        await tx.insert(schema.campaignAttempts).values({ campaignId: replay.id, attemptNumber: 1, status: "queued" });
        await tx.insert(schema.campaignEvents).values({ campaignId: replay.id, sequence: 1, eventType: "replay_queued", payload: { replayOf: id } });
        await tx.insert(schema.outbox).values({ topic: "campaign.execute", aggregateId: replay.id, payload: { campaignId: replay.id } });
        return { id: replay.id, replayOf: id, status: "queued" as const };
      });
    },
    async lease(campaignId: string, workerId: string) {
      return db.transaction(async (tx) => {
        const [campaign] = await tx.select({ id: schema.campaigns.id, fixtureId: schema.campaigns.fixtureId, fixtureVersion: schema.campaigns.fixtureVersion, executionDigest: schema.campaigns.executionDigest, selectedInvariants: schema.campaigns.selectedInvariants, status: schema.campaigns.status, sourceDigest: schema.campaigns.sourceDigest, cancelRequestedAt: schema.campaigns.cancelRequestedAt, runs: schema.campaigns.runs, depth: schema.campaigns.depth, seed: schema.campaigns.seed, timeoutSeconds: schema.campaigns.timeoutSeconds }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).for("update").limit(1);
        if (!campaign || !campaign.fixtureId || !campaign.executionDigest || !campaign.sourceDigest || campaign.cancelRequestedAt || !["queued", "running", "error", "infrastructure_blocked"].includes(campaign.status)) return null;
        const [attempt] = await tx.select({ id: schema.campaignAttempts.id, status: schema.campaignAttempts.status, attemptNumber: schema.campaignAttempts.attemptNumber }).from(schema.campaignAttempts).where(and(eq(schema.campaignAttempts.campaignId, campaignId), or(eq(schema.campaignAttempts.status, "queued"), and(eq(schema.campaignAttempts.status, "running"), sql`${schema.campaignAttempts.leaseExpiresAt} < now()`)))).orderBy(schema.campaignAttempts.attemptNumber).for("update").limit(1);
        if (!attempt || ["completed", "passed", "failed", "cancelled", "timed_out"].includes(attempt.status)) return null;
        const now = new Date();
        await tx.update(schema.campaigns).set({ status: "running", startedAt: now }).where(eq(schema.campaigns.id, campaignId));
        await tx.update(schema.campaignAttempts).set({ status: "running", workerId, startedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000) }).where(eq(schema.campaignAttempts.id, attempt.id));
        const [max] = await tx.select({ value: sql<number>`coalesce(max(${schema.campaignEvents.sequence}), 0)` }).from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, campaignId));
        await tx.insert(schema.campaignEvents).values({ campaignId, sequence: Number(max?.value ?? 0) + 1, eventType: "running", payload: { attemptNumber: attempt.attemptNumber, workerId } });
        return { ...campaign, attemptNumber: attempt.attemptNumber, workerId };
      });
    },
    async persistResult(campaignId: string, attemptNumber: number, workerId: string, result: Record<string, unknown>) {
      const allowed = result.status === "completed" || result.status === "failed" || result.status === "cancelled" || result.status === "infrastructure_blocked";
      if (!allowed) throw new Error("Invalid terminal campaign status");
      return db.transaction(async (tx) => {
        const [campaign] = await tx.select({ id: schema.campaigns.id, sourceDigest: schema.campaigns.sourceDigest, buildDigest: schema.campaigns.buildDigest }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).for("update").limit(1);
        if (!campaign) return false;
        const [attempt] = await tx.select({ id: schema.campaignAttempts.id, finishedAt: schema.campaignAttempts.finishedAt }).from(schema.campaignAttempts).where(and(
          eq(schema.campaignAttempts.campaignId, campaignId), eq(schema.campaignAttempts.attemptNumber, attemptNumber),
          eq(schema.campaignAttempts.workerId, workerId), eq(schema.campaignAttempts.status, "running"),
          sql`${schema.campaignAttempts.leaseExpiresAt} > now()`, sql`${schema.campaignAttempts.finishedAt} is null`,
        )).for("update").limit(1);
        // A worker whose lease expired or was reclaimed must never publish a stale result.
        if (!attempt || attempt.finishedAt) return false;
        const now = new Date();
        await tx.update(schema.campaigns).set({ status: result.status as typeof schema.campaigns.$inferInsert.status, outcome: typeof result.outcome === "string" ? result.outcome : null, failureKind: typeof result.failureKind === "string" ? result.failureKind : null, failureCode: typeof result.failureCode === "string" ? result.failureCode : null, sourceDigest: typeof result.sourceDigest === "string" ? result.sourceDigest : campaign.sourceDigest, buildDigest: typeof result.buildDigest === "string" ? result.buildDigest : campaign.buildDigest, result: result as unknown as Record<string, unknown>, finishedAt: now }).where(eq(schema.campaigns.id, campaignId));
        await tx.update(schema.campaignAttempts).set({ status: result.status as typeof schema.campaignAttempts.$inferInsert.status, finishedAt: now, leaseExpiresAt: null, errorCode: typeof result.failureCode === "string" ? result.failureCode : null, result }).where(eq(schema.campaignAttempts.id, attempt.id));
        const [max] = await tx.select({ value: sql<number>`coalesce(max(${schema.campaignEvents.sequence}), 0)` }).from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, campaignId));
        await tx.insert(schema.campaignEvents).values({ campaignId, sequence: Number(max?.value ?? 0) + 1, eventType: String(result.status), payload: result });
        return true;
      });
    },
    async isCancelRequested(campaignId: string) {
      const [row] = await db.select({ requested: schema.campaigns.cancelRequestedAt }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1);
      return Boolean(row?.requested);
    },
    async renewLease(campaignId: string, attemptNumber: number, workerId: string, leaseSeconds = 60) {
      const expiry = new Date(Date.now() + Math.max(10, Math.min(120, leaseSeconds)) * 1000);
      const [updated] = await db.update(schema.campaignAttempts).set({ leaseExpiresAt: expiry }).where(and(eq(schema.campaignAttempts.campaignId, campaignId), eq(schema.campaignAttempts.attemptNumber, attemptNumber), eq(schema.campaignAttempts.workerId, workerId), eq(schema.campaignAttempts.status, "running"), sql`${schema.campaignAttempts.leaseExpiresAt} > now()`, sql`${schema.campaignAttempts.finishedAt} is null`)).returning({ id: schema.campaignAttempts.id });
      return Boolean(updated);
    },
    async retryInfrastructure(campaignId: string, attemptNumber: number, workerId: string, result: Record<string, unknown>, backoffMs: number) {
      return db.transaction(async (tx) => {
        const [campaign] = await tx.select({ id: schema.campaigns.id, sourceDigest: schema.campaigns.sourceDigest, buildDigest: schema.campaigns.buildDigest }).from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).for("update").limit(1);
        const [attempt] = await tx.select({ id: schema.campaignAttempts.id, status: schema.campaignAttempts.status, finishedAt: schema.campaignAttempts.finishedAt }).from(schema.campaignAttempts).where(and(eq(schema.campaignAttempts.campaignId, campaignId), eq(schema.campaignAttempts.attemptNumber, attemptNumber), eq(schema.campaignAttempts.workerId, workerId), sql`${schema.campaignAttempts.leaseExpiresAt} > now()`)).for("update").limit(1);
        if (!campaign || !attempt || attempt.finishedAt || attempt.status !== "running") return null;
        const errorCode = typeof result.failureCode === "string" ? result.failureCode : "infrastructure_error";
        const [max] = await tx.select({ value: sql<number>`coalesce(max(${schema.campaignAttempts.attemptNumber}), 0)` }).from(schema.campaignAttempts).where(eq(schema.campaignAttempts.campaignId, campaignId));
        const currentAttempt = Number(max?.value ?? 0);
        const now = new Date();
        await tx.update(schema.campaignAttempts).set({ status: "infrastructure_blocked", errorCode, finishedAt: now, leaseExpiresAt: null, result }).where(eq(schema.campaignAttempts.id, attempt.id));
        if (currentAttempt >= 3) {
          await tx.update(schema.campaigns).set({ status: "infrastructure_blocked", outcome: null, failureKind: "infrastructure", failureCode: errorCode, result, sourceDigest: typeof result.sourceDigest === "string" ? result.sourceDigest : campaign.sourceDigest, buildDigest: typeof result.buildDigest === "string" ? result.buildDigest : campaign.buildDigest, finishedAt: now }).where(eq(schema.campaigns.id, campaignId));
          const [eventMax] = await tx.select({ value: sql<number>`coalesce(max(${schema.campaignEvents.sequence}), 0)` }).from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, campaignId));
          await tx.insert(schema.campaignEvents).values({ campaignId, sequence: Number(eventMax?.value ?? 0) + 1, eventType: "infrastructure_blocked", payload: result });
          return { campaignId, attemptNumber: currentAttempt, retryScheduled: false, status: "infrastructure_blocked" as const };
        }
        const nextAttempt = currentAttempt + 1;
        await tx.insert(schema.campaignAttempts).values({ campaignId, attemptNumber: nextAttempt, status: "queued" });
        await tx.update(schema.campaigns).set({ status: "queued", startedAt: null, finishedAt: null }).where(eq(schema.campaigns.id, campaignId));
        const [eventMax] = await tx.select({ value: sql<number>`coalesce(max(${schema.campaignEvents.sequence}), 0)` }).from(schema.campaignEvents).where(eq(schema.campaignEvents.campaignId, campaignId));
        await tx.insert(schema.campaignEvents).values({ campaignId, sequence: Number(eventMax?.value ?? 0) + 1, eventType: "retry_queued", payload: { attemptNumber: nextAttempt, errorCode } });
        await tx.insert(schema.outbox).values({ topic: "campaign.execute", aggregateId: campaignId, payload: { campaignId }, availableAt: new Date(now.getTime() + Math.max(0, Math.min(300_000, backoffMs))) });
        return { campaignId, attemptNumber: nextAttempt, retryScheduled: true, status: "queued" as const };
      });
    },
    async claimOutbox(dispatcherId: string, limit = 25) {
      return db.transaction(async (tx) => {
        const rows = await tx.select({ id: schema.outbox.id, topic: schema.outbox.topic, aggregateId: schema.outbox.aggregateId, payload: schema.outbox.payload, status: schema.outbox.status, attempts: schema.outbox.attempts, availableAt: schema.outbox.availableAt, lockedUntil: schema.outbox.lockedUntil, dispatcherId: schema.outbox.dispatcherId, deliveredAt: schema.outbox.deliveredAt, createdAt: schema.outbox.createdAt }).from(schema.outbox).where(and(eq(schema.outbox.status, "pending"), sql`${schema.outbox.availableAt} <= now()`, sql`(${schema.outbox.lockedUntil} is null or ${schema.outbox.lockedUntil} < now())`)).orderBy(schema.outbox.createdAt).limit(limit).for("update", { skipLocked: true });
        const now = new Date();
        for (const row of rows) await tx.update(schema.outbox).set({ attempts: row.attempts + 1, dispatcherId, lockedUntil: new Date(now.getTime() + 30_000) }).where(eq(schema.outbox.id, row.id));
        return rows.map((row) => ({ ...row, dispatcherId, lockedUntil: new Date(now.getTime() + 30_000) }));
      });
    },
    async markOutboxDelivered(id: string, dispatcherId: string) { await db.update(schema.outbox).set({ status: "delivered", deliveredAt: new Date(), lockedUntil: null, dispatcherId: null }).where(and(eq(schema.outbox.id, id), eq(schema.outbox.dispatcherId, dispatcherId))); },
  };
}

export function createSiweStore(db: AvogadroDatabase) {
  return {
    async issueNonce(nonce: string, domain: string, chainId: number, expiresAt: Date) {
      await db.delete(schema.siweNonces).where(lt(schema.siweNonces.expiresAt, new Date()));
      await db.insert(schema.siweNonces).values({ nonce, domain, chainId, expiresAt });
    },
    async consumeNonce(nonce: string, domain: string, chainId: number) {
      const [used] = await db.update(schema.siweNonces).set({ consumedAt: new Date() }).where(and(eq(schema.siweNonces.nonce, nonce), eq(schema.siweNonces.domain, domain), eq(schema.siweNonces.chainId, chainId), sql`${schema.siweNonces.consumedAt} is null`, sql`${schema.siweNonces.expiresAt} > now()`)).returning({ nonce: schema.siweNonces.nonce });
      return Boolean(used);
    },
    async createSession(walletAddress: string, tokenHash: string, csrfHash: string, expiresAt: Date) {
      const normalized = walletAddress.toLowerCase();
      const [user] = await db.insert(schema.users).values({ walletAddress: normalized }).onConflictDoUpdate({ target: schema.users.walletAddress, set: { updatedAt: new Date() } }).returning({ id: schema.users.id });
      await db.insert(schema.sessions).values({ userId: user.id, tokenHash, csrfHash, expiresAt });
      return user.id;
    },
    async getSession(tokenHash: string) {
      const [row] = await db.select({ userId: schema.sessions.userId, csrfHash: schema.sessions.csrfHash, expiresAt: schema.sessions.expiresAt, revokedAt: schema.sessions.revokedAt }).from(schema.sessions).where(and(eq(schema.sessions.tokenHash, tokenHash), sql`${schema.sessions.revokedAt} is null`, sql`${schema.sessions.expiresAt} > now()`)).limit(1);
      return row ?? null;
    },
    async revokeSession(tokenHash: string) {
      await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.tokenHash, tokenHash), sql`${schema.sessions.revokedAt} is null`));
    },
  };
}
