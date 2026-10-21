import { createHash } from "node:crypto";
import type { ImportedContract } from "./index.js";

export type StandardJsonInput = {
  language: "Solidity";
  sources: Record<string, { content: string }>;
  settings: Record<string, unknown>;
};

export type SolcOutput = {
  errors?: Array<{ severity?: string; formattedMessage?: string; message?: string }>;
  contracts?: Record<string, Record<string, {
    evm?: { deployedBytecode?: { object?: string; linkReferences?: Record<string, Record<string, unknown>>; immutableReferences?: Record<string, unknown> } };
  }>>;
};

export type SolcAdapter = (version: string, input: StandardJsonInput) => Promise<SolcOutput>;

export type CompilationResult = {
  compilerVersion: string;
  sourceCount: number;
  contractName: string;
  runtimeBytecodeHash: `0x${string}`;
  deployedBytecodeMatches: boolean;
  equivalence: "exact" | "mismatch" | "not_comparable";
  limitations: string[];
};

export class CompilationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CompilationError";
  }
}

const sha256 = (value: string): `0x${string}` => `0x${createHash("sha256").update(value).digest("hex")}`;

function compilerVersion(value: string): string {
  // Blockscout may include a release commit suffix. The adapter must resolve
  // that exact release; silently choosing a nearby solc version is unsafe.
  const match = /^v?(\d+\.\d+\.\d+)(?:\+commit\.([0-9a-fA-F]+))?(?:\.Emscripten\.clang)?$/.exec(value);
  if (!match) throw new CompilationError("UNSUPPORTED_COMPILER_VERSION", "Explorer compiler version is not a supported Solidity release identifier.");
  return `${match[1]}${match[2] ? `+commit.${match[2]}` : ""}`;
}

function findMissingImports(sources: Record<string, { content: string }>, settings: Record<string, unknown>): string[] {
  const paths = new Set(Object.keys(sources));
  const missing = new Set<string>();
  const remappings = Array.isArray(settings.remappings)
    ? settings.remappings.filter((item): item is string => typeof item === "string").map((value) => {
      const equals = value.indexOf("=");
      if (equals < 0) return null;
      const left = value.slice(0, equals);
      const colon = left.lastIndexOf(":");
      return { context: colon < 0 ? "" : left.slice(0, colon), prefix: left.slice(colon + 1), target: value.slice(equals + 1) };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => b.prefix.length - a.prefix.length)
    : [];
  for (const [file, source] of Object.entries(sources)) {
    const imports = source.content.matchAll(/\bimport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;/g);
    for (const [, importPath] of imports) {
      if (!importPath || importPath.startsWith(".") || importPath.startsWith("/")) {
        const resolved = importPath?.startsWith(".") ? normalizeRelative(file, importPath) : importPath;
        if (resolved && paths.has(resolved)) continue;
      } else if (importPath && (paths.has(importPath) || remappings.some(({ context, prefix, target }) => {
        if (!importPath.startsWith(prefix) || (context && !file.startsWith(context))) return false;
        return paths.has(`${target}${importPath.slice(prefix.length)}`);
      }))) continue;
      missing.add(importPath ?? "<unparseable import>");
    }
  }
  return [...missing].sort();
}

function normalizeRelative(from: string, requested: string): string | null {
  const parts = from.split("/");
  parts.pop();
  for (const part of requested.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Build the compiler input from the exact Blockscout source bundle/settings,
 * then invoke an explicitly supplied compiler adapter. No shell, package
 * manager, remote dependency resolver, or source-code execution is used here.
 *
 * Runtime equivalence is intentionally strict byte-for-byte. If compiler
 * output contains unresolved links or immutables, equivalence is not asserted.
 */
export async function compileImportedContract(contract: ImportedContract, compile: SolcAdapter): Promise<CompilationResult> {
  const version = compilerVersion(contract.compilerVersion);
  if (!contract.sourceFiles.length) throw new CompilationError("SOURCE_UNAVAILABLE", "Verified source bundle is empty; compilation cannot proceed.");
  const sources: StandardJsonInput["sources"] = {};
  for (const source of contract.sourceFiles) {
    if (!source.path || source.path.startsWith("/") || source.path.split("/").includes("..") || source.path.includes("\\")) {
      throw new CompilationError("UNSAFE_SOURCE_PATH", "A source path is unsafe for project reconstruction.");
    }
    if (sources[source.path]) throw new CompilationError("DUPLICATE_SOURCE_PATH", "Verified source bundle contains duplicate paths.");
    sources[source.path] = { content: source.content };
  }
  const missing = findMissingImports(sources, contract.compilerSettings);
  if (missing.length) {
    throw new CompilationError("DEPENDENCY_UNAVAILABLE", `Verified source bundle has unresolved imports: ${missing.join(", ")}. Import the complete verified dependency sources; external dependency downloads are disabled.`);
  }

  const settings = structuredClone(contract.compilerSettings);
  const outputSelection = (settings.outputSelection && typeof settings.outputSelection === "object")
    ? settings.outputSelection as Record<string, unknown>
    : {};
  settings.outputSelection = { ...outputSelection, "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"] } };
  let output: SolcOutput;
  try {
    output = await compile(version, { language: "Solidity", sources, settings });
  } catch {
    throw new CompilationError("COMPILER_UNAVAILABLE", `Exact Solidity compiler ${version} is unavailable. Install/provision this pinned compiler in the isolated compile service.`);
  }
  const fatal = (output.errors ?? []).filter((entry) => entry.severity === "error");
  if (fatal.length) throw new CompilationError("COMPILATION_FAILED", fatal.map((entry) => entry.formattedMessage ?? entry.message ?? "Solidity compilation failed.").join("\n").slice(0, 6000));

  const contracts = Object.entries(output.contracts ?? {}).flatMap(([file, entries]) => Object.entries(entries).map(([name, value]) => ({ file, name, value })));
  const candidates = contracts.filter(({ name }) => name === contract.name);
  if (candidates.length !== 1) throw new CompilationError("CONTRACT_ARTIFACT_AMBIGUOUS", `Expected one compiled artifact named ${contract.name}, found ${candidates.length}.`);
  const artifact = candidates[0]!.value.evm?.deployedBytecode;
  const object = artifact?.object?.replace(/^0x/, "");
  if (!object || !/^[\da-fA-F]+$/.test(object) || object.length % 2) throw new CompilationError("BYTECODE_UNAVAILABLE", "Compiler did not return valid deployed runtime bytecode.");
  const runtime = `0x${object.toLowerCase()}`;
  const hasLinks = artifact?.linkReferences && Object.keys(artifact.linkReferences).length > 0;
  const hasImmutables = artifact?.immutableReferences && Object.keys(artifact.immutableReferences).length > 0;
  const limitations: string[] = [];
  if (hasLinks) limitations.push("Runtime bytecode has library link references; linked deployed addresses are not resolved.");
  if (hasImmutables) limitations.push("Runtime bytecode has immutable references; constructor-derived values cannot be reconstructed from explorer metadata.");
  const comparable = !hasLinks && !hasImmutables;
  const matches = comparable && runtime === contract.runtimeBytecode.toLowerCase();
  if (!comparable) limitations.push("Bytecode equivalence is not asserted until deployment link/immutable values are independently established.");
  else if (!matches) limitations.push("Compiled runtime bytecode differs from the deployed runtime bytecode, including metadata; execution is blocked.");

  return {
    compilerVersion: version,
    sourceCount: Object.keys(sources).length,
    contractName: candidates[0]!.name,
    runtimeBytecodeHash: sha256(runtime),
    deployedBytecodeMatches: matches,
    equivalence: !comparable ? "not_comparable" : matches ? "exact" : "mismatch",
    limitations,
  };
}
