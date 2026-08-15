/**
 * 资源契约声明与通用引擎单元测试：注册校验、分页语义、阶段钩子、change-set 信封。
 */
import { describe, expect, it } from "vitest";
import { createResourceRegistry, type ResourceContract } from "../src/resource/core/contracts.js";
import {
  getResourceContract,
  listResourceContracts,
  specialResourceHandlerRegistry
} from "../src/resource/catalog.js";
import {
  ResourceEngine,
  createResourceAdapterRegistry,
  createResourcePhaseHooksRegistry,
  type ResourcePhaseHooks
} from "../src/resource/core/engine.js";
import {
  shouldFinishContractPagination,
  type ResourceClient
} from "../src/resource/core/client.js";
import { createSpecialResourceHandlerRegistry } from "../src/resource/handlers/registry.js";
import { createResourceModuleCatalog } from "../src/resource/modules/contracts.js";

const base = (overrides: Partial<ResourceContract> = {}): ResourceContract => ({
  id: "demo",
  title: "Demo",
  description: "Demo resource",
  service: "sei-basic",
  query: { path: "demo/findAll", method: "GET" },
  save: { path: "demo/save", method: "POST" },
  read: "findAll",
  identityFields: ["code"],
  compareFields: ["code", "name"],
  writableFields: ["code", "name"],
  tenant: { policy: "any" },
  capabilities: ["query", "write", "compare", "sync"],
  rollback: {
    service: "sei-basic",
    resource: "demo",
    remove: { path: "demo/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
    lookup: { path: "demo/findOne", method: "GET", idField: "id", idPlacement: "query" }
  },
  help: "Demo help",
  ...overrides
});

describe("声明式资源契约：注册校验", () => {
  it("拒绝重复 ID、缺保存接口与缺回滚契约", () => {
    expect(() => createResourceRegistry([base(), base()])).toThrow("资源契约 ID 重复");
    expect(() => createResourceRegistry([base({ save: undefined })])).toThrow("缺少保存接口");
    const syncOnly = { capabilities: ["compare", "sync"] as ResourceContract["capabilities"] };
    expect(() => createResourceRegistry([base({ ...syncOnly, save: undefined })])).toThrow("缺少保存接口");
    expect(() => createResourceRegistry([base({ ...syncOnly, rollback: undefined })])).toThrow("缺少安全回滚契约");
  });

  it("拒绝不一致的注册组合", () => {
    expect(() => createResourceRegistry([base({ capabilities: ["sync"] })]))
      .toThrow("必须同时声明 compare");
    expect(() => createResourceRegistry([base({ adapter: "demo", handler: "demo" })]))
      .toThrow("不能同时声明适配器和特殊处理器");
    expect(() => createResourceRegistry([base({
      selectors: [{ name: "code", valuePlaceholder: "code", description: "代码", required: false }]
    })])).toThrow("只有特殊处理器才能声明选择器");
    expect(() => createResourceRegistry([base({ id: "../demo" })])).toThrow("资源契约 ID 无效");
    expect(() => createResourceRegistry([base({
      selectors: [
        { name: "code", valuePlaceholder: "code", description: "代码", required: false },
        { name: "code", valuePlaceholder: "code", description: "重复", required: false }
      ]
    })])).toThrow("选择器名称重复");
    expect(() => createResourceRegistry([base({ read: "paged" })])).toThrow("缺少分页契约");
    expect(() => createResourceRegistry([base({
      deletion: {
        service: "other-service",
        resource: "demo",
        remove: { path: "demo/delete/{id}", method: "DELETE", idField: "id", idPlacement: "path" },
        lookup: { path: "demo/findOne", method: "GET", idField: "id", idPlacement: "query" },
        restore: { path: "demo/save", method: "POST" }
      }
    })])).toThrow("删除服务必须与资源服务一致");
  });

  it("内置契约能力与默认值可被 AI 自主发现", () => {
    const names = listResourceContracts().map((contract) => contract.id);
    expect(names).toEqual(expect.arrayContaining(["feature", "feature-group", "serial-number", "menu", "bpm"]));
    expect(getResourceContract("menu").handler).toBe("menu");
    expect(getResourceContract("bpm").handler).toBe("bpm");
    expect(getResourceContract("bpm").capabilities).toEqual(["compare", "sync"]);
    expect(getResourceContract("app-module").defaults?.create).toEqual({ rank: 1 });
    expect(getResourceContract("feature").dependencies).toEqual(["feature-group", "app-module"]);
    expect(getResourceContract("feature").deletion).toMatchObject({
      service: "sei-basic",
      resource: "feature",
      remove: { path: "feature/delete/{id}", method: "DELETE" },
      lookup: { path: "feature/findOne", method: "GET" },
      restore: { path: "feature/save", method: "POST" }
    });
    expect(getResourceContract("serial-number").defaults?.create).toEqual({
      returnStrategy: "NEW",
      configType: "CODE_TYPE"
    });
    expect(getResourceContract("serial-number").enums?.returnStrategy).toEqual([
      { value: "NEW", meaning: "每次新给号" },
      { value: "REPEAT", meaning: "同一关联对象优先复用已有条码" },
      { value: "PATCH", meaning: "补号策略" }
    ]);
    expect(specialResourceHandlerRegistry.list()).toEqual(["bpm", "menu"]);
  });

  it("给号配置只暴露 serial-number CLI 资源名，后端路径仍由契约承载", () => {
    const serialNumberNames = listResourceContracts()
      .map((contract) => contract.id)
      .filter((name) => name === "serial-number" || name === "serialNumberConfig");
    expect(serialNumberNames).toEqual(["serial-number"]);
    expect(() => getResourceContract("serialNumberConfig")).toThrow("尚未注册");

    const contract = getResourceContract("serial-number");
    expect(contract.query.path).toBe("serialNumberConfig/findByPage");
    expect(contract.save?.path).toBe("serialNumberConfig/save");
  });

  it("目标独有记录没有完整删除契约时保持 blocked", async () => {
    const contract = base();
    const sourceClient = { queryContract: async () => [] } as unknown as ResourceClient;
    const targetClient = { queryContract: async () => [{ code: "ORPHAN", name: "目标独有" }] } as unknown as ResourceClient;
    const plan = await new ResourceEngine().compare(
      contract,
      sourceClient,
      targetClient,
      { source: "source", target: "target" }
    );
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 0, blocked: 1 });
    expect(plan.changes[0]).toMatchObject({
      action: "blocked",
      targetOnly: true,
      blockingIssues: [{ reason: "undeclared-delete" }]
    });
  });
});

describe("分页契约语义", () => {
  it("按 EADP total 页数和 records 总记录数聚合", () => {
    const pagination = {
      pageField: "pageInfo",
      pageNumberField: "page",
      pageSizeField: "rows",
      startPage: 1,
      rowsField: "rows",
      pageSize: 500,
      totalSemantics: "pages" as const
    };
    expect(shouldFinishContractPagination(
      pagination,
      { page: 1, records: 501, total: 2, summaryInfo: null, rows: Array.from({ length: 500 }, () => ({ id: "x" })) },
      500,
      500,
      1
    )).toBe(false);
    expect(shouldFinishContractPagination(
      pagination,
      { page: 2, records: 501, total: 2, summaryInfo: null, rows: [{ id: "y" }] },
      1,
      501,
      2
    )).toBe(true);
  });
});

describe("资源阶段钩子", () => {
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

  it("使用 load 与 plan 钩子替代默认引擎读取/映射", async () => {
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
    const plan = await engine.compare(contract, client, client, { source: "source", target: "target" });
    expect(plan.changeSetKind).toBe("eadp.resource.change-set.v1");
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ key: "A", action: "create", desired: { code: "A", name: "A" } });
  });

  it("预览模式绝不调用 apply 钩子；正式模式调用 apply 与 verify", async () => {
    let applyCalls = 0;
    let verifyCalls = 0;
    const client = { queryContract: async () => [] } as unknown as ResourceClient;
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

    const preview = await engine.sync(contract, client, client, { source: "source", target: "target" }, { apply: false });
    expect(preview.applied).toBe(false);
    expect(applyCalls).toBe(0);

    const applied = await engine.sync(contract, client, client, { source: "source", target: "target" }, { apply: true });
    expect(applyCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(applied).toMatchObject({ applied: true, verified: true, summary: { create: 1 } });
  });

  it("verify 钩子返回 false 时引擎保持回查闸门", async () => {
    const client = { queryContract: async () => [] } as unknown as ResourceClient;
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
      contract, client, client, { source: "source", target: "target" }, { apply: true }
    )).rejects.toThrow("写入后回查失败");
  });

  it("未注册适配器在任何资源读取前失败", async () => {
    let queries = 0;
    const client = {
      queryContract: async () => { queries += 1; return []; }
    } as unknown as ResourceClient;
    await expect(new ResourceEngine().planWrite(
      base({ adapter: "missing-adapter" }),
      client,
      { code: "A", name: "A" }
    )).rejects.toThrow("资源适配器未注册：missing-adapter");
    expect(queries).toBe(0);
  });

  it("组合时拒绝不完整适配器与行为扩展", () => {
    expect(() => createResourceModuleCatalog([
      { contract: base({ adapter: "missing-adapter" }) }
    ])).toThrow("但未提供实现");
    const specialWrite = base({
      capabilities: ["write"],
      handler: "demo-special",
      read: "handler",
      save: undefined,
      rollback: undefined,
      identityFields: [],
      compareFields: [],
      writableFields: []
    });
    expect(() => createResourceModuleCatalog([{ contract: specialWrite, handler: {} }]))
      .toThrow("write 能力必须经由通用引擎（提供阶段钩子）");
    expect(() => createResourceModuleCatalog([
      { contract: specialWrite, handler: { hooks: { apply: async () => {} } } }
    ])).not.toThrow();
  });

  it("特殊处理器注册表独立分发", async () => {
    const calls: string[] = [];
    const registry = createSpecialResourceHandlerRegistry([
      ["demo-special", {
        async query({ quick }) {
          calls.push(quick ?? "query");
          return {
            kind: "eadp.resource.query.v1",
            resource: "demo",
            environment: "env",
            items: [],
            total: 0
          };
        },
        hooks: { aggregatePlan: async () => ({ changes: [] }) }
      }]
    ]);
    const result = await registry.get("demo-special").query!({
      environment: {} as never,
      runtime: {} as never,
      filters: [],
      quick: "value"
    });
    expect(result).toMatchObject({ kind: "eadp.resource.query.v1", resource: "demo" });
    expect(calls).toEqual(["value"]);
    expect(registry.find("missing")).toBeUndefined();
    expect(() => createSpecialResourceHandlerRegistry([
      ["demo-special", {}],
      ["demo-special", {}]
    ])).toThrow("特殊处理器 ID 重复或无效");
  });
});
