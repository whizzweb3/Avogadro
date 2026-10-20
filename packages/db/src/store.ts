import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
