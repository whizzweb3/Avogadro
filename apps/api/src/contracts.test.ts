import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

const id = "20000000-0000-4000-8000-000000000001";

test("contract ABI function projection is bounded and owner-scoped", async () => {
  const app = buildApp({
    logger: false,
    authenticate: async (request) => typeof request.headers["x-owner"] === "string" ? request.headers["x-owner"] : null,
    contractStore: { get: async (ownerId: string) => ownerId === "alice" ? { id, chainId: 4663, address: `0x${"1".repeat(40)}`, abi: [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] }, { type: "event", name: "Withdrawn", inputs: [] }] } : null } as never,
  });
  try {
    const unauthenticated = await app.inject({ method: "GET", url: `/v1/contracts/${id}/functions` });
    assert.equal(unauthenticated.statusCode, 401);
    const foreign = await app.inject({ method: "GET", url: `/v1/contracts/${id}/functions`, headers: { "x-owner": "bob" } });
    assert.equal(foreign.statusCode, 404);
    const owner = await app.inject({ method: "GET", url: `/v1/contracts/${id}/functions`, headers: { "x-owner": "alice" } });
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.json().executionEnabled, false);
    assert.deepEqual(owner.json().functions, [{ name: "withdraw", signature: "withdraw(uint256)", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256", indexed: false }], outputs: [] }]);
  } finally { await app.close(); }
});
