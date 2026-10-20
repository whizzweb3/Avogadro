import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const campaignStatus = pgEnum("campaign_status", ["draft", "queued", "preparing", "running", "passed", "failed", "cancelled", "timed_out", "error"]);
export const importStatus = pgEnum("import_status", ["pending", "verified", "unverified", "failed"]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "delivered", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(), walletAddress: varchar("wallet_address", { length: 42 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(), userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), revokedAt: timestamp("revoked_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("sessions_user_expiry_idx").on(t.userId, t.expiresAt)]);
export const contracts = pgTable("contracts", {
  id: uuid("id").defaultRandom().primaryKey(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }), chainId: integer("chain_id").notNull(), address: varchar("address", { length: 42 }).notNull(),
  importStatus: importStatus("import_status").default("pending").notNull(), verified: boolean("verified").default(false).notNull(), name: text("name"), compilerVersion: text("compiler_version"), metadata: jsonb("metadata"), abi: jsonb("abi"),
  provenanceUrl: text("provenance_url"), provenanceFetchedAt: timestamp("provenance_fetched_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("contracts_owner_chain_address_uq").on(t.ownerId, t.chainId, t.address), index("contracts_owner_created_idx").on(t.ownerId, t.createdAt), check("contracts_robinhood_chain_check", sql`${t.chainId} = 4663`)]);
export const contractSources = pgTable("contract_sources", {
  id: uuid("id").defaultRandom().primaryKey(), contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "restrict" }), path: text("path").notNull(), contentDigest: varchar("content_digest", { length: 66 }).notNull(), sourceText: text("source_text").notNull(), provenanceUrl: text("provenance_url").notNull(), provenanceFetchedAt: timestamp("provenance_fetched_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("contract_sources_path_uq").on(t.contractId, t.path), index("contract_sources_contract_idx").on(t.contractId)]);
export const campaigns = pgTable("campaigns", {
  id: uuid("id").defaultRandom().primaryKey(), ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }), contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "restrict" }), status: campaignStatus("status").default("queued").notNull(),
  snapshotBlockNumber: bigint("snapshot_block_number", { mode: "number" }).notNull(), snapshotBlockHash: varchar("snapshot_block_hash", { length: 66 }).notNull(), harnessDigest: varchar("harness_digest", { length: 66 }).notNull(), buildDigest: varchar("build_digest", { length: 66 }).notNull(), seed: text("seed").notNull(), runs: integer("runs").notNull(), depth: integer("depth").notNull(), timeoutSeconds: integer("timeout_seconds").notNull(), engineVersion: text("engine_version"), cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }), queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(), startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("campaigns_owner_status_created_idx").on(t.ownerId, t.status, t.createdAt), index("campaigns_contract_idx").on(t.contractId), check("campaigns_positive_bounds_check", sql`${t.snapshotBlockNumber} >= 0 AND ${t.runs} > 0 AND ${t.depth} > 0 AND ${t.timeoutSeconds} > 0`)]);
export const invariants = pgTable("invariants", {
  id: uuid("id").defaultRandom().primaryKey(), campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }), name: text("name").notNull(), description: text("description"), template: text("template"), sourceDigest: varchar("source_digest", { length: 66 }), configuration: jsonb("configuration").notNull(), enabled: boolean("enabled").default(true).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("invariants_campaign_idx").on(t.campaignId)]);
export const campaignEvents = pgTable("campaign_events", {
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }), sequence: bigint("sequence", { mode: "number" }).notNull(), eventType: varchar("event_type", { length: 40 }).notNull(), payload: jsonb("payload").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.campaignId, t.sequence] }), index("campaign_events_replay_idx").on(t.campaignId, t.sequence)]);
export const counterexamples = pgTable("counterexamples", {
  id: uuid("id").defaultRandom().primaryKey(), campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }), invariantId: uuid("invariant_id").references(() => invariants.id, { onDelete: "restrict" }), callSequence: jsonb("call_sequence").notNull(), traceArtifactKey: text("trace_artifact_key"), traceDigest: varchar("trace_digest", { length: 66 }), replayManifest: jsonb("replay_manifest").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("counterexamples_campaign_idx").on(t.campaignId)]);
export const artifacts = pgTable("artifacts", {
  id: uuid("id").defaultRandom().primaryKey(), campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }), objectKey: text("object_key").notNull().unique(), mediaType: text("media_type").notNull(), digest: varchar("digest", { length: 66 }).notNull(), byteCount: bigint("byte_count", { mode: "number" }).notNull(), retainUntil: timestamp("retain_until", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("artifacts_campaign_idx").on(t.campaignId)]);
export const campaignAttempts = pgTable("campaign_attempts", {
  id: uuid("id").defaultRandom().primaryKey(), campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }), attemptNumber: integer("attempt_number").notNull(), status: campaignStatus("status").notNull(), workerId: text("worker_id"), startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }), errorCode: text("error_code"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("campaign_attempt_number_uq").on(t.campaignId, t.attemptNumber), index("campaign_attempt_campaign_idx").on(t.campaignId)]);
export const outbox = pgTable("outbox", {
  id: uuid("id").defaultRandom().primaryKey(), topic: text("topic").notNull(), aggregateId: uuid("aggregate_id").notNull(), payload: jsonb("payload").notNull(), status: outboxStatus("status").default("pending").notNull(), attempts: integer("attempts").default(0).notNull(), availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(), deliveredAt: timestamp("delivered_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("outbox_dispatch_idx").on(t.status, t.availableAt, t.createdAt)]);
