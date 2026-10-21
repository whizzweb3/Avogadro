import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type ArtifactInput = { name: string; content: string; sha256: string; bytes: number };
export type StoredArtifact = { name: string; objectKey: string; mediaType: "text/plain; charset=utf-8"; digest: string; byteCount: number; retainUntil: Date };
export type ArtifactStorage = {
  put(campaignId: string, attemptNumber: number, artifact: ArtifactInput): Promise<StoredArtifact>;
  get(objectKey: string, expectedBytes: number, expectedDigest: string): Promise<Buffer>;
  delete(objectKey: string): Promise<void>;
};
export type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; retentionDays?: number };

function validateConfig(config: S3Config): void {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("Artifact endpoint must be a valid URL"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Artifact endpoint cannot contain credentials, query parameters, or fragments");
  if (!((endpoint.protocol === "https:") || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "minio"].includes(endpoint.hostname)))) throw new Error("Artifact endpoint must use HTTPS except for local development hosts");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes("..")) throw new Error("Invalid artifact bucket");
  if (!config.region || !config.accessKeyId || !config.secretAccessKey) throw new Error("Artifact region and dedicated storage credentials are required");
  const days = config.retentionDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Artifact retention must be between 1 and 3650 days");
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function createArtifactStorage(config: S3Config, client?: S3Client): ArtifactStorage {
  validateConfig(config);
  const s3 = client ?? new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  const retentionDays = config.retentionDays ?? 30;
  return {
    async put(campaignId, attemptNumber, artifact) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId) || !Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error("Invalid artifact campaign identity");
      if (!namePattern.test(artifact.name)) throw new Error("Invalid artifact name");
      const body = Buffer.from(artifact.content, "utf8");
      const sha256 = digest(body);
      if (body.length > MAX_ARTIFACT_BYTES || body.length !== artifact.bytes || sha256 !== artifact.sha256) throw new Error("Artifact size or SHA-256 does not match its manifest");
      const objectKey = `campaigns/${campaignId}/attempt-${attemptNumber}/${sha256}/${artifact.name}`;
      const retainUntil = new Date(Date.now() + retentionDays * 86_400_000);
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        Body: body,
        ContentLength: body.length,
        ContentType: "text/plain; charset=utf-8",
        Metadata: { sha256, campaignid: campaignId, attempt: String(attemptNumber) },
      }));
      return { name: artifact.name, objectKey, mediaType: "text/plain; charset=utf-8", digest: `0x${sha256}`, byteCount: body.length, retainUntil };
    },
    async get(objectKey, expectedBytes, expectedDigest) {
      if (!objectKey.startsWith("campaigns/") || objectKey.includes("..") || !Number.isInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_ARTIFACT_BYTES || !/^0x[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Invalid artifact metadata");
      const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
      if (!response.Body || (response.ContentLength !== undefined && response.ContentLength !== expectedBytes)) throw new Error("Artifact length does not match its metadata");
      const chunks: Buffer[] = [];
      let readBytes = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        readBytes += chunk.byteLength;
        if (readBytes > expectedBytes || readBytes > MAX_ARTIFACT_BYTES) {
          const stream = response.Body as { destroy?: () => void };
          stream.destroy?.();
          throw new Error("Artifact response exceeds its metadata size");
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks, readBytes);
      if (body.length !== expectedBytes || `0x${digest(body)}` !== expectedDigest) throw new Error("Artifact SHA-256 does not match its metadata");
      return body;
    },
    async delete(objectKey) {
      if (!objectKey.startsWith("campaigns/") || objectKey.includes("..")) throw new Error("Invalid artifact object key");
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    },
  };
}

export function artifactStorageFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStorage {
  const endpoint = env.ARTIFACT_ENDPOINT;
  const bucket = env.ARTIFACT_BUCKET;
  const region = env.ARTIFACT_REGION;
  const accessKeyId = env.ARTIFACT_ACCESS_KEY_ID;
  const secretAccessKey = env.ARTIFACT_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !region || !accessKeyId || !secretAccessKey) throw new Error("Artifact storage configuration is incomplete");
  return createArtifactStorage({ endpoint, bucket, region, accessKeyId, secretAccessKey, retentionDays: env.ARTIFACT_RETENTION_DAYS ? Number(env.ARTIFACT_RETENTION_DAYS) : 30 });
}
