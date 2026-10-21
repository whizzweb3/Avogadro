import { createHash } from "node:crypto";
import { CHAIN_ID } from "@avogadro/shared";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTECODE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type CompilerSettings = Record<string, unknown>;
export type SourceFile = { path: string; content: string; sha256: `0x${string}` };
export type ImportedContract = {
  chainId: typeof CHAIN_ID;
  address: `0x${string}`;
  verified: true;
  name: string;
  language: string;
  compilerVersion: string;
  compilerSettings: CompilerSettings;
  abi: unknown[];
  sourceFiles: SourceFile[];
  runtimeBytecode: `0x${string}`;
  runtimeBytecodeHash: `0x${string}`;
  verification: {
    provider: "blockscout-v2";
    url: string;
    fetchedAt: string;
    responseSha256: `0x${string}`;
    explorerVerifiedAt: string | null;
    isFullyVerified: boolean;
    explorerBytecodeChanged: boolean;
  };
  proxy: null | { type: string | null; implementationAddress: `0x${string}`; implementation: ImportedContract };
};

export type ImportOptions = {
  chainId: number;
  address: string;
  /** Fixed network endpoint configuration; callers must not pass request-controlled values here. */
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
};

export class IngestionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

function sha256(value: string | Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAddress(value: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) throw new IngestionError("INVALID_ADDRESS", "Address must be a 20-byte hex address.");
  return value.toLowerCase() as `0x${string}`;
}

function parseAbi(value: unknown): unknown[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; }
    catch { throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer ABI is not valid JSON."); }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => !isRecord(item) || typeof item.type !== "string")) {
    throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer ABI is missing or malformed.");
  }
  return parsed;
}

function safeSourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split("/").some((part) => part === "..");
}

function parseStandardJsonSources(raw: unknown): SourceFile[] | null {
  let value = raw;
  if (typeof value === "string") {
    const candidate = value.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
    try {
      value = JSON.parse(candidate);
      // A verified single-file Solidity source can itself begin with an opening
      // contract brace. Treat JSON objects as Standard JSON only when they
      // actually carry the required sources map; otherwise keep it as source.
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "sources")) return null;
    }
    catch {
      // Older Blockscout verification payloads wrap standard JSON in one extra brace pair.
      if (!candidate.startsWith("{{") || !candidate.endsWith("}}")) {
        throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer source project is malformed JSON.");
      }
      try {
        value = JSON.parse(candidate.slice(1, -1));
        if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "sources")) return null;
      }
      catch { throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer source project is malformed JSON."); }
    }
  }
  if (!isRecord(value)) return null;
  if (!isRecord(value.sources)) throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer source project does not include a standard JSON sources map.");
  const sources = value.sources;
  const files: SourceFile[] = [];
  for (const [path, entry] of Object.entries(sources)) {
    if (!isRecord(entry) || typeof entry.content !== "string" || !entry.content) {
      throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Standard JSON source entry is missing source content.");
    }
    files.push({ path, content: entry.content, sha256: sha256(entry.content) });
  }
  return files.length > 0 ? files : null;
}

function parseSources(contract: Record<string, unknown>): SourceFile[] {
  const standardJson = parseStandardJsonSources(contract.source_code);
  if (standardJson) return validateSources(standardJson);
  const files: SourceFile[] = [];
  if (typeof contract.source_code === "string" && contract.source_code.length > 0) {
    files.push({ path: typeof contract.file_path === "string" && contract.file_path ? contract.file_path : "Contract.sol", content: contract.source_code, sha256: sha256(contract.source_code) });
  }
  if (Array.isArray(contract.additional_sources)) {
    for (const item of contract.additional_sources) {
      if (!isRecord(item) || typeof item.file_path !== "string" || typeof item.source_code !== "string" || !item.source_code) {
        throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer returned a malformed additional source file.");
      }
      files.push({ path: item.file_path, content: item.source_code, sha256: sha256(item.source_code) });
    }
  }
  if (files.length === 0) throw new IngestionError("SOURCE_UNAVAILABLE", "Verified source is unavailable from the configured explorer.");
  return validateSources(files);
}

function validateSources(files: SourceFile[]): SourceFile[] {
  if (files.length > 500 || files.some((f) => Buffer.byteLength(f.content, "utf8") > 2_000_000 || !safeSourcePath(f.path))) {
    throw new IngestionError("SOURCE_LIMIT", "Source file count, size, or path exceeds ingestion limits.");
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer returned duplicate source paths.");
    seen.add(file.path);
  }
  return files;
}

function parseCompilerSettings(value: unknown): CompilerSettings | null {
  let settings = value;
  if (typeof value === "string") {
    try { settings = JSON.parse(value) as unknown; }
    catch { return null; }
  }
  return isRecord(settings) ? settings : null;
}

async function boundedJson(response: Response): Promise<{ value: unknown; raw: string }> {
  if (!response.ok) throw new IngestionError(response.status === 404 ? "NOT_VERIFIED" : "EXPLORER_UNAVAILABLE", `Explorer returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new IngestionError("RESPONSE_TOO_LARGE", "Explorer response exceeds the 8 MiB limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer response body is empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new IngestionError("RESPONSE_TOO_LARGE", "Explorer response exceeds the 8 MiB limit.");
    }
    chunks.push(value);
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  try { return { value: JSON.parse(raw) as unknown, raw }; }
  catch { throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer response is not valid JSON."); }
}

function validateRpcUrl(rpcUrl: string): URL {
  let parsed: URL;
  try { parsed = new URL(rpcUrl); }
  catch { throw new IngestionError("INVALID_RPC_CONFIG", "Configured RPC URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "rpc.mainnet.chain.robinhood.com" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new IngestionError("INVALID_RPC_CONFIG", "RPC must use Robinhood Chain's official HTTPS mainnet host.");
  }
  return parsed;
}

async function rpcCall(fetchImpl: typeof fetch, rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const envelope = await boundedJson(response);
  if (!isRecord(envelope.value) || envelope.value.error !== undefined || envelope.value.id !== 1 || typeof envelope.value.result !== "string") {
    throw new IngestionError("RPC_ERROR", `Read-only RPC request ${method} failed or returned an invalid response.`);
  }
  return envelope.value.result;
}

async function rpcCode(fetchImpl: typeof fetch, rpcUrl: string, address: string): Promise<{ code: `0x${string}`; hash: `0x${string}` }> {
  const code = await rpcCall(fetchImpl, rpcUrl, "eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || !BYTECODE_RE.test(code)) throw new IngestionError("NOT_A_CONTRACT", "Read-only RPC returned no deployed contract bytecode.");
  const keccak = await rpcCall(fetchImpl, rpcUrl, "web3_sha3", [code]);
  if (typeof keccak !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(keccak)) throw new IngestionError("RPC_ERROR", "Read-only RPC returned an invalid deployed bytecode hash.");
  return { code: code.toLowerCase() as `0x${string}`, hash: keccak.toLowerCase() as `0x${string}` };
}

async function readExplorerContract(fetchImpl: typeof fetch, address: string): Promise<{ contract: Record<string, unknown>; raw: string; url: string }> {
  const url = `${EXPLORER}/api/v2/smart-contracts/${address}`;
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const { value, raw } = await boundedJson(response);
  if (!isRecord(value)) throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Explorer contract response must be an object.");
  return { contract: value, raw, url };
}

async function resolve(fetchImpl: typeof fetch, rpcUrl: string, address: `0x${string}`, depth: number, seen: Set<string>): Promise<ImportedContract> {
  if (seen.has(address)) throw new IngestionError("PROXY_CYCLE", "Explorer proxy metadata contains an implementation cycle.");
  if (depth > 1) throw new IngestionError("PROXY_DEPTH", "Proxy implementation nesting exceeds the supported depth.");
  seen.add(address);

  const [explorer, deployed] = await Promise.all([
    readExplorerContract(fetchImpl, address),
    rpcCode(fetchImpl, rpcUrl, address),
  ]);
  const c = explorer.contract;
  if (c.is_verified !== true || c.is_fully_verified !== true || c.is_partially_verified === true || c.is_changed_bytecode === true) {
    throw new IngestionError("NOT_VERIFIED", "Contract is not fully verified with unchanged bytecode in Blockscout.");
  }
  if (typeof c.address_hash !== "string" || normalizeAddress(c.address_hash) !== address) throw new IngestionError("ADDRESS_MISMATCH", "Explorer response address does not match the requested address.");
  const compilerSettings = parseCompilerSettings(c.compiler_settings);
  if (typeof c.compiler_version !== "string" || !/^v?\d+\.\d+\.\d+(?:\+commit\.[0-9a-fA-F]+)?(?:\.Emscripten\.clang)?$/.test(c.compiler_version) || typeof c.name !== "string" || !c.name || !compilerSettings) {
    throw new IngestionError("INVALID_EXPLORER_RESPONSE", "Verified compiler version, name, or compiler settings are missing.");
  }
  if (c.language !== undefined && c.language !== "Solidity") throw new IngestionError("UNSUPPORTED_LANGUAGE", "Only verified Solidity contracts can be imported for fuzzing.");
  const abi = parseAbi(c.abi);
  const sourceFiles = parseSources(c);
  let implementation: ImportedContract["proxy"] = null;
  const implementations = Array.isArray(c.implementations) ? c.implementations : [];
  const proxyType = typeof c.proxy_type === "string" ? c.proxy_type : null;
  if (proxyType !== null || implementations.length > 0) {
    if (implementations.length !== 1 || !isRecord(implementations[0]) || typeof implementations[0].address_hash !== "string") {
      throw new IngestionError("PROXY_AMBIGUOUS", "Proxy implementation is missing or ambiguous; contract import is blocked.");
    }
    const implAddress = normalizeAddress(implementations[0].address_hash);
    if (implAddress === address) throw new IngestionError("PROXY_CYCLE", "Proxy implementation points to itself.");
    const impl = await resolve(fetchImpl, rpcUrl, implAddress, depth + 1, seen);
    implementation = { type: proxyType, implementationAddress: implAddress, implementation: impl };
  }
  const fetchedAt = new Date().toISOString();
  return {
    chainId: CHAIN_ID,
    address,
    verified: true,
    name: c.name,
    language: typeof c.language === "string" ? c.language : "Solidity",
    compilerVersion: c.compiler_version,
    compilerSettings,
    abi,
    sourceFiles,
    runtimeBytecode: deployed.code,
    runtimeBytecodeHash: deployed.hash,
    verification: {
      provider: "blockscout-v2",
      url: explorer.url,
      fetchedAt,
      responseSha256: sha256(explorer.raw),
      explorerVerifiedAt: typeof c.verified_at === "string" ? c.verified_at : null,
      isFullyVerified: c.is_fully_verified === true,
      explorerBytecodeChanged: c.is_changed_bytecode === true,
    },
    proxy: implementation,
  };
}

/** Imports verified source from the fixed Robinhood Blockscout instance and reads code/hash from the fixed mainnet RPC. */
export async function importVerifiedContract(options: ImportOptions): Promise<ImportedContract> {
  if (options.chainId !== CHAIN_ID) throw new IngestionError("UNSUPPORTED_CHAIN", "Only Robinhood Chain mainnet (4663) is supported.");
  const address = normalizeAddress(options.address);
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC;
  validateRpcUrl(rpcUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const chainId = await rpcCall(fetchImpl, rpcUrl, "eth_chainId", []);
  if (chainId !== "0x1237") throw new IngestionError("RPC_CHAIN_MISMATCH", "Configured read-only RPC does not report chain ID 4663.");
  return resolve(fetchImpl, rpcUrl, address, 0, new Set());
}

export const ingestionConfig = Object.freeze({ chainId: CHAIN_ID, explorerBaseUrl: EXPLORER, defaultRpcUrl: DEFAULT_RPC, maxResponseBytes: MAX_RESPONSE_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS });
