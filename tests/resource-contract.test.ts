import { describe, expect, it } from "vitest";
import { createResourceRegistry, type ResourceContract } from "../src/resource/core/contracts.js";
import {
  getResourceContract,
  listResourceContracts,
  specialResourceHandlerRegistry
} from "../src/resource/catalog.js";
import { ResourceEngine } from "../src/resource/core/engine.js";
import {
  shouldFinishContractPagination,
  type ResourceClient
} from "../src/resource/core/client.js";
import {
  createSpecialResourceHandlerRegistry
} from "../src/resource/handlers/registry.js";
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

describe("declarative resource contracts", () => {
  it("rejects duplicate IDs", () => {
    expect(() => createResourceRegistry([base(), base()])).toThrow("资源契约 ID 重复");
  });

  it("rejects write capability without save endpoint", () => {
    expect(() => createResourceRegistry([base({ save: undefined })])).toThrow("缺少保存接口");
  });

  it("rejects ordinary sync without save and safe rollback contracts at registration", () => {
    const syncOnly = { capabilities: ["compare", "sync"] as ResourceContract["capabilities"] };
    expect(() => createResourceRegistry([base({ ...syncOnly, save: undefined })]))
      .toThrow("缺少保存接口");
    expect(() => createResourceRegistry([base({ ...syncOnly, rollback: undefined })]))
      .toThrow("缺少安全回滚契约");
  });

  it("allows a behavior extension to implement write through the apply phase hook", () => {
    const registry = createResourceRegistry([base({
      capabilities: ["write"],
      handler: "demo",
      read: "handler",
      save: undefined,
      rollback: undefined,
      identityFields: [],
      compareFields: [],
      writableFields: []
    })]);
    expect(registry.get("demo").capabilities).toEqual(["write"]);
    const handlers = createSpecialResourceHandlerRegistry([["demo", {
      hooks: { apply: async () => {} }
    }]]);
    expect(typeof handlers.get("demo").hooks?.apply).toBe("function");
  });

  it("rejects paged contracts without pagination semantics", () => {
    expect(() => createResourceRegistry([base({ read: "paged" })])).toThrow("缺少分页契约");
  });

  it("uses verified total semantics and conservatively handles unknown pagination", () => {
    const pagination = {
      pageField: "pageInfo",
      pageNumberField: "page",
      pageSizeField: "rows",
      startPage: 1,
      rowsField: "rows",
      pageSize: 500,
      totalSemantics: "records" as const
    };
    expect(shouldFinishContractPagination(pagination, { total: 501 }, 500, 500, 1)).toBe(false);
    expect(shouldFinishContractPagination(pagination, { total: 501 }, 1, 501, 2)).toBe(true);
    expect(() => shouldFinishContractPagination(pagination, {}, 1, 1, 1)).toThrow("有效 total");
    expect(shouldFinishContractPagination(
      { ...pagination, totalSemantics: "pages" },
      { total: 2 },
      1,
      501,
      2
    )).toBe(true);
    expect(shouldFinishContractPagination(
      { ...pagination, totalSemantics: "unknown" },
      {},
      499,
      499,
      1
    )).toBe(true);
  });

  it("rejects inconsistent registration combinations", () => {
    expect(() => createResourceRegistry([base({ capabilities: ["sync"] })]))
      .toThrow("必须同时声明 compare");
    expect(() => createResourceRegistry([base({ adapter: "demo", handler: "demo" })]))
      .toThrow("不能同时声明适配器和特殊处理器");
    expect(() => createResourceRegistry([base({
      selectors: [{ name: "code", valuePlaceholder: "code", description: "代码", required: false }]
    })])).toThrow("只有特殊处理器才能声明选择器");
    expect(() => createResourceRegistry([base({ id: "../demo" })]))
      .toThrow("资源契约 ID 无效");
    expect(() => createResourceRegistry([base({
      selectors: [
        { name: "code", valuePlaceholder: "code", description: "代码", required: false },
        { name: "code", valuePlaceholder: "code", description: "重复", required: false }
      ]
    })])).toThrow("选择器名称重复");
    expect(() => createResourceRegistry([base({
      selectors: [{ name: "flow", valuePlaceholder: "", description: "流程", required: true }]
    })])).toThrow("选择器值占位符无效");
  });

  it("ships ordinary and special contracts with discoverable capabilities", () => {
    const names = listResourceContracts().map((contract) => contract.id);
    expect(names).toEqual(expect.arrayContaining(["feature", "feature-group", "serial-number", "menu", "bpm"]));
    expect(getResourceContract("menu").handler).toBe("menu");
    expect(getResourceContract("bpm").handler).toBe("bpm");
    expect(getResourceContract("menu").selectors).toEqual([{
      name: "code",
      valuePlaceholder: "code",
      description: "菜单代码；省略时比较完整菜单树",
      required: false
    }]);
    expect(getResourceContract("bpm").selectors).toEqual([{
      name: "flow",
      valuePlaceholder: "code-or-name",
      description: "BPM 流程代码、名称或 Entity 代码",
      required: true
    }]);
    expect(getResourceContract("bpm").capabilities).toEqual(["compare", "sync"]);
    expect(getResourceContract("app-module").writableFields).toEqual([
      "code", "name", "remark", "webBaseAddress", "apiBaseAddress", "rank"
    ]);
    expect(getResourceContract("app-module").defaults?.create).toEqual({ rank: 1 });
    expect(getResourceContract("serial-number").defaults?.create).toEqual({
      returnStrategy: "NEW",
      configType: "CODE_TYPE"
    });
    expect(getResourceContract("serial-number").enums?.returnStrategy).toEqual([
      { value: "NEW", meaning: "每次新给号" },
      { value: "REPEAT", meaning: "同一关联对象优先复用已有条码" },
      { value: "PATCH", meaning: "补号策略" }
    ]);
  });

  it("gives a future API-defined service query, write, compare, and sync without domain code", async () => {
    const catalog = createResourceModuleCatalog([{
      contract: base({
        service: "sei-inventory",
        rollback: {
          service: "sei-inventory",
          resource: "warehouse",
          remove: {
            path: "warehouse/delete/{id}",
            method: "DELETE",
            idField: "id",
            idPlacement: "path"
          },
          lookup: { path: "warehouse/findOne", method: "GET", idField: "id", idPlacement: "query" }
        }
      })
    }]);
    const contract = catalog.registry.get("demo");
    const sourceRows = [{ id: "source-A", code: "A", name: "Warehouse A" }];
    let targetRows: Array<Record<string, unknown>> = [];
    const source = {
      queryContract: async () => sourceRows
    } as unknown as ResourceClient;
    const target = {
      queryContract: async () => targetRows,
      saveContract: async (_contract: ResourceContract, desired: Record<string, unknown>) => {
        const saved = { ...desired, id: "target-A" };
        targetRows = [saved];
        return saved;
      }
    } as unknown as ResourceClient;
    const resourceEngine = new ResourceEngine();

    const query = await resourceEngine.query(contract, source, "source");
    const write = await resourceEngine.write(contract, target, sourceRows[0]!, { apply: false });
    const compare = await resourceEngine.compare(contract, source, target, {
      source: "source",
      target: "target"
    });
    const sync = await resourceEngine.sync(contract, source, target, {
      source: "source",
      target: "target"
    }, { apply: true });

    expect(contract.service).toBe("sei-inventory");
    expect(query.items).toHaveLength(1);
    expect(write).toMatchObject({ applied: false, summary: { create: 1 } });
    expect(compare.summary.create).toBe(1);
    expect(sync).toMatchObject({ applied: true, verified: true, summary: { create: 1 } });
    expect(() => createResourceRegistry([base({ service: "../unsafe" })])).toThrow("服务标识无效");
  });

  it("uses one change-set marker for ordinary compare and sync plans", async () => {
    const client = {
      queryContract: async () => [{ code: "A", name: "A" }]
    } as unknown as ResourceClient;
    const plan = await new ResourceEngine().compare(
      base(),
      client,
      client,
      { source: "source", target: "target" }
    );
    expect(plan.changeSetKind).toBe("eadp.resource.change-set.v1");
    expect(plan.kind).toBe("eadp.resource.change-set.v1");
  });

  it("fails an unregistered adapter before any resource read", async () => {
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

  it("rejects incomplete adapters and behavior extensions at composition time", () => {
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
    expect(() => createResourceModuleCatalog([
      { contract: specialWrite, handler: {} }
    ])).toThrow("write 能力必须经由通用引擎（提供阶段钩子）");
    expect(() => createResourceModuleCatalog([
      { contract: specialWrite, handler: { hooks: { apply: async () => {} } } }
    ])).not.toThrow();
  });

  it("registers and dispatches special handlers independently from ordinary contracts", async () => {
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
    expect(typeof registry.get("demo-special").hooks?.aggregatePlan).toBe("function");
    expect(registry.find("missing")).toBeUndefined();
    expect(() => createSpecialResourceHandlerRegistry([
      ["demo-special", {}],
      ["demo-special", {}]
    ])).toThrow("特殊处理器 ID 重复或无效");
  });

  it("composes built-in special handlers without putting domain imports in resource commands", () => {
    expect(specialResourceHandlerRegistry.list()).toEqual(["bpm", "menu"]);
    expect(specialResourceHandlerRegistry.get("menu").query).toBeTypeOf("function");
    expect(specialResourceHandlerRegistry.get("menu").hooks?.plan).toBeTypeOf("function");
    expect(specialResourceHandlerRegistry.get("bpm").hooks?.aggregatePlan).toBeTypeOf("function");
  });
});
