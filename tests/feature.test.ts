/**
 * feature 必测矩阵：Page/Business/Operate 的 url/groupCode/canMenu 精确请求体。
 * 必须断言 feature/save 的真实请求体，而不是只验证预览输出。
 */
import { afterEach, describe, expect, it } from "vitest";
import { OperationLogStore } from "../src/operations/store.js";
import {
  cleanupAll,
  createFixture,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

interface FeatureApplyState {
  modules: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  features: Array<Record<string, unknown>>;
  saves: unknown[];
  findByCodeCalls: string[];
  failSave?: boolean;
}

function featureApplyState(): FeatureApplyState {
  return {
    modules: [{ id: "app-1", code: "BASIC", name: "基础应用" }],
    groups: [{ id: "group-1", code: "BASIC_DATA", name: "基础数据", appModuleId: "app-1" }],
    features: [],
    saves: [],
    findByCodeCalls: []
  };
}

function registerFeatureApplyRoutes(server: MockEadpServer, state: FeatureApplyState): void {
  server.onEndsWith("/feature/findByCode", (context) => {
    const code = context.query.get("code") ?? "";
    state.findByCodeCalls.push(code);
    const match = state.features.find(
      (feature) => String(feature.code).toLocaleLowerCase() === code.toLocaleLowerCase()
    );
    context.json(match ?? null);
  });
  server.onEndsWith("/appModule/findAll", (context) => context.json(state.modules));
  server.onEndsWith("/featureGroup/getAuthorizedFeatureGroup", (context) => context.json(state.groups));
  server.onEndsWith("/feature/save", (context) => {
    if (state.failSave) {
      context.fail("save failed", 500);
      return;
    }
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const saved = { ...body, id: `feature-${state.saves.length}` };
    const index = state.features.findIndex((feature) => feature.code === body.code);
    if (index >= 0) state.features[index] = saved;
    else state.features.push(saved);
    context.json(saved);
  });
  // rollback 需要
  server.onEndsWith("/feature/findOne", (context) => {
    const id = context.query.get("id");
    const match = state.features.find((feature) => feature.id === id);
    context.json(match ?? null);
  });
  server.on(/\/feature\/delete\/[^/]+$/, (context) => {
    const id = context.path.split("/").at(-1);
    const index = state.features.findIndex((feature) => feature.id === id);
    if (index >= 0) state.features.splice(index, 1);
    context.json(true);
  });
}

function pageArgs(extra: string[] = []): string[] {
  return [
    "permission", "apply", "feature",
    "--code", "BASIC_VIEW", "--name", "查看基础数据", "--app", "BASIC",
    "--group", "BASIC_DATA", "--feature-type", "Page", "--url", "//basic/view///",
    ...extra
  ];
}

describe("permission apply feature：六大场景", () => {
  it("场景1 预览：输出计划（desired）且远端写接口调用次数为 0", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), pageArgs())) as {
      applied: boolean;
      action: string;
      desired: Record<string, unknown>;
      verified: boolean;
    };
    expect(output.applied).toBe(false);
    expect(output.action).toBe("create");
    expect(output.verified).toBe(false);
    // 预览输出也必须是精确映射（url → groupCode，无 url 字段）
    expect(output.desired).toEqual({
      code: "BASIC_VIEW",
      name: "查看基础数据",
      featureType: "Page",
      appModuleId: "app-1",
      featureGroupId: "group-1",
      canMenu: true,
      tenantCanUse: true,
      mobileUse: false,
      groupCode: "/basic/view"
    });
    expect(output.desired).not.toHaveProperty("url");
    expect(state.saves).toHaveLength(0);
    const featureGroupRequest = fixture.server("source").requests.find((request) =>
      request.path.endsWith("/featureGroup/getAuthorizedFeatureGroup")
    );
    expect(featureGroupRequest?.headers["x-api-token"]).toBe("source-token");
  });

  it("场景2+3 Page：正式执行断言完整请求体并回查服务端状态", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [...pageArgs(), "--apply"])) as {
      applied: boolean;
      verified: boolean;
      operationId: string;
      saved: Record<string, unknown>;
      verifiedFeature: Record<string, unknown>;
    };
    expect(output.applied).toBe(true);
    expect(output.verified).toBe(true);
    expect(output.operationId).toEqual(expect.any(String));
    // 完整请求体：Page 必须映射 groupCode，绝不携带 url
    expect(state.saves[0]).toEqual({
      code: "BASIC_VIEW",
      name: "查看基础数据",
      featureType: "Page",
      appModuleId: "app-1",
      featureGroupId: "group-1",
      canMenu: true,
      tenantCanUse: true,
      mobileUse: false,
      groupCode: "/basic/view"
    });
    expect(state.saves[0]).not.toHaveProperty("url");
    // 回查：服务端状态反映写入内容
    expect(state.features).toEqual([expect.objectContaining({ code: "BASIC_VIEW", groupCode: "/basic/view" })]);
    expect(output.verifiedFeature).toMatchObject({ code: "BASIC_VIEW" });
    // 操作日志可回滚
    const record = await new OperationLogStore(fixture.store.directory).load(output.operationId);
    expect(record.actions).toEqual([
      expect.objectContaining({ type: "create-entity", resource: "feature", entityId: "feature-1" })
    ]);
  });

  it("场景4 再次执行：按 code 查重返回 unchanged，只发 GET findByCode 且零写入", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    await runCommand(fixture.program(), [...pageArgs(), "--apply"]);
    state.findByCodeCalls.length = 0;
    const beforeRequests = fixture.server("source").requests.length;

    const output = JSON.parse(await runCommand(fixture.program(), [...pageArgs(), "--apply"])) as {
      applied: boolean;
      action: string;
      verified: boolean;
      operationId?: string;
    };
    expect(output.applied).toBe(false);
    expect(output.action).toBe("unchanged");
    expect(output.verified).toBe(true);
    expect(output.operationId).toBeUndefined();
    expect(state.saves).toHaveLength(1);
    // 第二次只发一个 GET findByCode
    const newRequests = fixture.server("source").requests.slice(beforeRequests);
    expect(newRequests).toHaveLength(1);
    expect(newRequests[0]!.method).toBe("GET");
    expect(newRequests[0]!.path).toContain("/feature/findByCode");
  });

  it("场景5 歧义/租户：应用模块歧义或非 global 租户时零写入/零请求", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    state.modules = [
      { id: "app-1", code: "BASIC" },
      { id: "app-2", code: "BASIC" }
    ];
    registerFeatureApplyRoutes(fixture.server("source"), state);

    const error = await runExpectError(fixture.program(), pageArgs());
    expect(error).toContain("应用模块匹配到多条记录");
    expect(state.saves).toHaveLength(0);

    // 非 global 租户：零远端请求
    const fixture2 = await createFixture({
      environments: [{ name: "dev", tenantCode: "tenant-a", token: "secret" }]
    });
    const state2 = featureApplyState();
    registerFeatureApplyRoutes(fixture2.server("dev"), state2);
    const error2 = await runExpectError(fixture2.program(), [
      "permission", "apply", "feature", "--code", "X", "--name", "X", "--app", "BASIC",
      "--feature-type", "Page", "--url", "/x"
    ]);
    expect(error2).toContain("必须使用 global 租户");
    expect(fixture2.server("dev").requests).toHaveLength(0);
  });

  it("场景6 失败：save 失败立即停止，不重试、不切换接口", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    state.failSave = true;
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const before = fixture.server("source").requests.length;

    const error = await runExpectError(fixture.program(), [...pageArgs(), "--apply"]);
    expect(error).toContain("HTTP 500");
    const newRequests = fixture.server("source").requests.slice(before);
    expect(newRequests.filter((request) => request.path.endsWith("/feature/save"))).toHaveLength(1);
    expect(state.features).toHaveLength(0);
  });
});

describe("feature 请求体：类型差异", () => {
  it("Business 默认 canMenu=true，传 url 时写入 groupCode，无 url 时两者都不写", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    await runCommand(fixture.program(), [
      "permission", "apply", "feature", "--code", "BASIC_EXPORT", "--name", "导出",
      "--app", "BASIC", "--feature-type", "Business", "--url", "/basic/export/", "--apply"
    ]);
    expect(state.saves[0]).toMatchObject({
      code: "BASIC_EXPORT",
      featureType: "Business",
      canMenu: true,
      groupCode: "/basic/export"
    });
    expect(state.saves[0]).not.toHaveProperty("url");

    const fixture2 = await createFixture();
    const state2 = featureApplyState();
    registerFeatureApplyRoutes(fixture2.server("source"), state2);
    const output = JSON.parse(await runCommand(fixture2.program(), [
      "permission", "apply", "feature", "--code", "NO_URL", "--name", "无地址",
      "--app", "BASIC", "--feature-type", "Business"
    ])) as { desired: Record<string, unknown> };
    expect(output.desired).not.toHaveProperty("url");
    expect(output.desired).not.toHaveProperty("groupCode");
    expect(output.desired.canMenu).toBe(true);
  });

  it("Operate 忽略 --url：canMenu=false 且不写 url/groupCode", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    await runCommand(fixture.program(), [
      "permission", "apply", "feature", "--code", "BASIC_EXPORT", "--name", "导出",
      "--app", "BASIC", "--feature-type", "Operate", "--url", "//basic/export///", "--apply"
    ]);
    expect(state.saves[0]).toMatchObject({
      code: "BASIC_EXPORT",
      featureType: "Operate",
      canMenu: false,
      tenantCanUse: true,
      mobileUse: false
    });
    expect(state.saves[0]).not.toHaveProperty("url");
    expect(state.saves[0]).not.toHaveProperty("groupCode");
  });

  it("--no-tenant-can-use 关闭租户可用，根路径 url 归一化为 /", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      ...pageArgs(["--no-tenant-can-use"]),
      "--url", "///"
    ])) as { desired: Record<string, unknown> };
    expect(output.desired.tenantCanUse).toBe(false);
    expect(output.desired.groupCode).toBe("/");
  });

  it("功能项组歧义/跨应用/不存在时零写入", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    state.groups = [
      { id: "group-1", code: "BASIC_DATA", appModuleId: "app-1" },
      { id: "group-2", code: "BASIC_DATA", appModuleId: "app-1" }
    ];
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const error = await runExpectError(fixture.program(), pageArgs());
    expect(error).toContain("功能项组匹配到多条记录");
    expect(state.saves).toHaveLength(0);

    state.groups = [{ id: "group-1", code: "BASIC_DATA", appModuleId: "app-2" }];
    const error2 = await runExpectError(fixture.program(), pageArgs());
    expect(error2).toContain("功能项组与应用模块不一致");
    expect(state.saves).toHaveLength(0);
  });

  it("Page 缺少非空 --url 立即失败且零请求", async () => {
    const fixture = await createFixture();
    const state = featureApplyState();
    registerFeatureApplyRoutes(fixture.server("source"), state);
    const error = await runExpectError(fixture.program(), [
      "permission", "apply", "feature", "--code", "BASIC_VIEW", "--name", "查看",
      "--app", "BASIC", "--feature-type", "Page"
    ]);
    expect(error).toContain("Page 类型功能项必须显式提供非空 --url");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});
