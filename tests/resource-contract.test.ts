import { describe, expect, it } from "vitest";
import { createResourceRegistry, type ResourceContract } from "../src/resource/contracts.js";
import { getResourceContract, listResourceContracts } from "../src/resource/catalog.js";
import { ResourceEngine } from "../src/resource/engine.js";
import type { ResourceClient } from "../src/resource/client.js";

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
  rollback: { service: "sei-basic", resource: "demo", deleteMethod: "DELETE" },
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

  it("rejects paged contracts without pagination semantics", () => {
    expect(() => createResourceRegistry([base({ read: "paged" })])).toThrow("缺少分页契约");
  });

  it("rejects inconsistent registration combinations", () => {
    expect(() => createResourceRegistry([base({ capabilities: ["sync"] })]))
      .toThrow("必须同时声明 compare");
    expect(() => createResourceRegistry([base({ adapter: "demo", handler: "demo" })]))
      .toThrow("不能同时声明适配器和特殊处理器");
    expect(() => createResourceRegistry([base({ id: "../demo" })]))
      .toThrow("资源契约 ID 无效");
  });

  it("ships ordinary and special contracts with discoverable capabilities", () => {
    const names = listResourceContracts().map((contract) => contract.id);
    expect(names).toEqual(expect.arrayContaining(["feature", "feature-group", "serial-number", "menu", "bpm"]));
    expect(getResourceContract("menu").handler).toBe("menu");
    expect(getResourceContract("bpm").handler).toBe("bpm");
    expect(getResourceContract("bpm").capabilities).toEqual(["compare", "sync"]);
    expect(getResourceContract("app-module").writableFields).toEqual([
      "code", "name", "remark", "webBaseAddress", "apiBaseAddress", "rank"
    ]);
    expect(getResourceContract("app-module").defaults?.create).toEqual({ rank: 1 });
    expect(getResourceContract("serial-number").enums?.returnStrategy).toEqual([
      { value: "NEW", meaning: "每次新给号" },
      { value: "REPEAT", meaning: "同一关联对象优先复用已有条码" },
      { value: "PATCH", meaning: "补号策略" }
    ]);
  });

  it("allows a future service through one validated ordinary-resource declaration", () => {
    const registry = createResourceRegistry([base({
      service: "sei-inventory",
      rollback: { service: "sei-inventory", resource: "warehouse", deleteMethod: "DELETE" }
    })]);
    expect(registry.get("demo").service).toBe("sei-inventory");
    expect(() => createResourceRegistry([base({ service: "../unsafe" })])).toThrow("服务标识无效");
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
});
