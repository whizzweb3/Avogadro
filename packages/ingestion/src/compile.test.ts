import assert from "node:assert/strict";
import test from "node:test";
import type { ImportedContract } from "./index.js";
import { CompilationError, compileImportedContract } from "./compile.js";

const contract: ImportedContract = {
  chainId: 4663,
  address: "0x1111111111111111111111111111111111111111",
  verified: true,
  name: "Vault",
  language: "Solidity",
  compilerVersion: "v0.8.26+commit.8a97fa7a",
  compilerSettings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  abi: [],
  sourceFiles: [
    { path: "src/Vault.sol", content: 'import "../lib/Math.sol"; contract Vault {}', sha256: "0x" },
    { path: "lib/Math.sol", content: "library Math {}", sha256: "0x" },
  ],
  runtimeBytecode: "0x6001600055",
  runtimeBytecodeHash: "0x00",
  verification: { provider: "blockscout-v2", url: "https://example.invalid", fetchedAt: "", responseSha256: "0x00", explorerVerifiedAt: null, isFullyVerified: true, explorerBytecodeChanged: false },
  proxy: null,
};

test("reconstructs exact multi-file Standard JSON input and recognizes exact deployed runtime", async () => {
  let receivedVersion = "";
  let receivedInput: Parameters<Parameters<typeof compileImportedContract>[1]>[1] | undefined;
  const result = await compileImportedContract(contract, async (version, input) => {
    receivedVersion = version;
    receivedInput = input;
    return { contracts: { "src/Vault.sol": { Vault: { evm: { deployedBytecode: { object: "6001600055" } } } } } };
  });
  assert.equal(receivedVersion, "0.8.26+commit.8a97fa7a");
  assert.deepEqual(Object.keys(receivedInput!.sources), ["src/Vault.sol", "lib/Math.sol"]);
  assert.equal((receivedInput!.settings.optimizer as { runs: number }).runs, 200);
  assert.deepEqual(result.equivalence, "exact");
  assert.equal(result.deployedBytecodeMatches, true);
});

test("fails closed on unresolved third-party imports without downloading dependencies", async () => {
  await assert.rejects(compileImportedContract({ ...contract, sourceFiles: [contract.sourceFiles[0]!] }, async () => ({})), (error: unknown) => error instanceof CompilationError && error.code === "DEPENDENCY_UNAVAILABLE" && error.message.includes("../lib/Math.sol"));
  await assert.rejects(compileImportedContract({ ...contract, sourceFiles: [{ ...contract.sourceFiles[0]!, content: 'import "@openzeppelin/contracts/token/ERC20/ERC20.sol";' }] }, async () => ({})), (error: unknown) => error instanceof CompilationError && error.code === "DEPENDENCY_UNAVAILABLE" && error.message.includes("@openzeppelin"));
});

test("resolves dependencies only through explicit compiler remappings and bundled files", async () => {
  const mapped = { ...contract, compilerSettings: { remappings: ["@lib/=vendor/lib/"] }, sourceFiles: [
    { ...contract.sourceFiles[0]!, content: 'import "@lib/Math.sol";' },
    { ...contract.sourceFiles[1]!, path: "vendor/lib/Math.sol" },
  ] };
  const result = await compileImportedContract(mapped, async () => ({
    contracts: { "src/Vault.sol": { Vault: { evm: { deployedBytecode: { object: "6001600055" } } } } },
  }));
  assert.equal(result.equivalence, "exact");
});

test("does not claim bytecode equivalence for linked or immutable deployments", async () => {
  const result = await compileImportedContract(contract, async () => ({ contracts: { "src/Vault.sol": { Vault: { evm: { deployedBytecode: { object: "6001600055", linkReferences: { "lib/Math.sol": { Math: [{}] } } } } } } } }));
  assert.equal(result.equivalence, "not_comparable");
  assert.equal(result.deployedBytecodeMatches, false);
});

test("blocks runtime mismatch and compilation errors", async () => {
  const mismatch = await compileImportedContract(contract, async () => ({
    contracts: { "src/Vault.sol": { Vault: { evm: { deployedBytecode: { object: "6002600055" } } } } },
  }));
  assert.equal(mismatch.equivalence, "mismatch");
  await assert.rejects(compileImportedContract(contract, async () => ({ errors: [{ severity: "error", formattedMessage: "compile error" }] })), (error: unknown) => error instanceof CompilationError && error.code === "COMPILATION_FAILED");
});

test("rejects unsupported compiler identifiers and unsafe source paths", async () => {
  await assert.rejects(compileImportedContract({ ...contract, compilerVersion: "latest" }, async () => ({})), (error: unknown) => error instanceof CompilationError && error.code === "UNSUPPORTED_COMPILER_VERSION");
  await assert.rejects(compileImportedContract({ ...contract, sourceFiles: [{ ...contract.sourceFiles[0]!, path: "../escape.sol" }] }, async () => ({})), (error: unknown) => error instanceof CompilationError && error.code === "UNSAFE_SOURCE_PATH");
});
