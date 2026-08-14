import { describe, expect, it } from "vitest";
import type { ResourceContract } from "../src/resource/core/contracts.js";
import type { ResourceClient } from "../src/resource/core/client.js";
import {
  ResourceEngine,
  createResourceAdapterRegistry,
  createResourcePhaseHooksRegistry,
  type ResourcePhaseHooks
} from "../src/resource/core/engine.js";

const contract: ResourceContract = {
  id: "demo",
  title: "Demo",
  description: "phase-hooks demo",
  service: "sei-basic",
  query: { path: "demo/query", method: "GET" },
  read: "findAll",
  identityFields: ["code"],
  compareFields: ["code", "name"],
  writableFields: ["code", "name"],
  tenant: { policy: "any" },
  capabilities: ["compare", "sync"],
  help: "demo"
};

function makeEngine(hooks: ResourcePhaseHooks): ResourceEngine {
  return new ResourceEngine(
    createResourceAdapterRegistry(),
    createResourcePhaseHooksRegistry([["demo", hooks]])
  );
}

describe("resource phase hooks", () => {
  it("uses the load and plan hooks instead of the default engine read/mapping", async () => {
    const client = {
      queryContract: async () => [{ code: "IGNORED", name: "default read" }]
    } as unknown as ResourceClient;
    const engine = makeEngine({
      load: async () => [{ code: "A", name: "A" }],
      plan: async (source, target) => source.map((record) => ({
        key: String(record.code),
        action: "create" as const,
        changedFields: ["code", "name"],
        before: target[0] ?? null,
        desired: record
      }))
    });

    const plan = await engine.compare(
      contract,
      client,
      client,
      { source: "source", target: "target" }
    );

    expect(plan.changeSetKind).toBe("eadp.resource.change-set.v1");
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ key: "A", action: "create", desired: { code: "A", name: "A" } });
  });

  it("never invokes the apply hook in preview mode", async () => {
    let applyCalls = 0;
    const client = {
      queryContract: async () => []
    } as unknown as ResourceClient;
    const engine = makeEngine({
      load: async () => [{ code: "A", name: "A" }],
      plan: async (source) => source.map((record) => ({
        key: String(record.code),
        action: "create" as const,
        changedFields: ["code", "name"],
        before: null,
        desired: record
      })),
      apply: async (writable) => { applyCalls += writable.length; },
      verify: async () => true
    });

    const result = await engine.sync(
      contract,
      client,
      client,
      { source: "source", target: "target" },
      { apply: false }
    );

    expect(result.applied).toBe(false);
    expect(applyCalls).toBe(0);
  });

  it("invokes apply and verify hooks in apply mode and reports verified", async () => {
    let applyCalls = 0;
    let verifyCalls = 0;
    const client = {
      queryContract: async () => []
    } as unknown as ResourceClient;
    const engine = makeEngine({
      load: async () => [{ code: "A", name: "A" }],
      plan: async (source) => source.map((record) => ({
        key: String(record.code),
        action: "create" as const,
        changedFields: ["code", "name"],
        before: null,
        desired: record
      })),
      apply: async (writable) => { applyCalls += writable.length; },
      verify: async () => { verifyCalls += 1; return true; }
    });

    const result = await engine.sync(
      contract,
      client,
      client,
      { source: "source", target: "target" },
      { apply: true }
    );

    expect(applyCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(result).toMatchObject({ applied: true, verified: true, summary: { create: 1 } });
  });

  it("keeps the engine verify gate when the verify hook returns false", async () => {
    const client = {
      queryContract: async () => []
    } as unknown as ResourceClient;
    const engine = makeEngine({
      load: async () => [{ code: "A", name: "A" }],
      plan: async (source) => source.map((record) => ({
        key: String(record.code),
        action: "create" as const,
        changedFields: ["code", "name"],
        before: null,
        desired: record
      })),
      apply: async () => {},
      verify: async () => false
    });

    await expect(engine.sync(
      contract,
      client,
      client,
      { source: "source", target: "target" },
      { apply: true }
    )).rejects.toThrow("写入后回查失败");
  });
});
