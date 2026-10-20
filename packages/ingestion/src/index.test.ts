import assert from "node:assert/strict";
import test from "node:test";
import { importVerifiedContract, IngestionError, ingestionConfig } from "./index.js";

const address = "0x1111111111111111111111111111111111111111";
const code = "0x6001600055";
const explorerContract = {
  address_hash: address,
  is_verified: true,
  is_partially_verified: false,
  is_fully_verified: true,
  is_changed_bytecode: false,
  name: "Vault",
  language: "Solidity",
  compiler_version: "v0.8.26+commit.8a97fa7a",
  compiler_settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  abi: JSON.stringify([{ type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }] }]),
  source_code: "pragma solidity ^0.8.0; contract Vault { function totalSupply() external pure returns(uint) { return 1; } }",
  file_path: "src/Vault.sol",
  additional_sources: [{ file_path: "lib/Math.sol", source_code: "library Math {}" }],
  implementations: [],
};

function mockFetch(explorerOverride: Record<string, unknown> = explorerContract, chainId = "0x1237"): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ingestionConfig.explorerBaseUrl)) return new Response(JSON.stringify(explorerOverride), { status: 200, headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init?.body)) as { method: string };
    const result = body.method === "eth_chainId" ? chainId : body.method === "eth_getCode" ? code : `0x${"a".repeat(64)}`;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("imports verified source, ABI, settings and pinned read-only runtime code", async () => {
  const contract = await importVerifiedContract({ chainId: 4663, address, fetchImpl: mockFetch() });
  assert.equal(contract.verified, true);
  assert.equal(contract.chainId, 4663);
  assert.equal(contract.address, address);
  assert.equal(contract.abi[0] && (contract.abi[0] as { name: string }).name, "totalSupply");
  assert.equal(contract.sourceFiles.length, 2);
  assert.equal(contract.runtimeBytecode, code);
  assert.equal(contract.runtimeBytecodeHash, `0x${"a".repeat(64)}`);
  assert.equal(contract.verification.provider, "blockscout-v2");
});

test("rejects unsupported chain and wrong RPC chain before explorer import", async () => {
  await assert.rejects(importVerifiedContract({ chainId: 46630, address, fetchImpl: mockFetch() }), (error: unknown) => error instanceof IngestionError && error.code === "UNSUPPORTED_CHAIN");
  await assert.rejects(importVerifiedContract({ chainId: 4663, address, fetchImpl: mockFetch(explorerContract, "0xb636") }), (error: unknown) => error instanceof IngestionError && error.code === "RPC_CHAIN_MISMATCH");
});

test("rejects unverified and ambiguous proxy metadata", async () => {
  await assert.rejects(importVerifiedContract({ chainId: 4663, address, fetchImpl: mockFetch({ ...explorerContract, is_verified: false }) }), (error: unknown) => error instanceof IngestionError && error.code === "NOT_VERIFIED");
  await assert.rejects(importVerifiedContract({ chainId: 4663, address, fetchImpl: mockFetch({ ...explorerContract, proxy_type: "eip1967", implementations: [] }) }), (error: unknown) => error instanceof IngestionError && error.code === "PROXY_AMBIGUOUS");
});

test("rejects request-controlled RPC hosts and malformed addresses", async () => {
  await assert.rejects(importVerifiedContract({ chainId: 4663, address, rpcUrl: "http://127.0.0.1:8545", fetchImpl: mockFetch() }), (error: unknown) => error instanceof IngestionError && error.code === "INVALID_RPC_CONFIG");
  await assert.rejects(importVerifiedContract({ chainId: 4663, address: "not-an-address", fetchImpl: mockFetch() }), (error: unknown) => error instanceof IngestionError && error.code === "INVALID_ADDRESS");
});

test("RPC requests deny redirects and do not follow them", async () => {
  let calls = 0;
  const redirectingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.redirect, "error");
    return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/rpc" } });
  }) as typeof fetch;
  await assert.rejects(importVerifiedContract({ chainId: 4663, address, fetchImpl: redirectingFetch }), (error: unknown) => error instanceof IngestionError && error.code === "EXPLORER_UNAVAILABLE");
  assert.equal(calls, 1);
});
