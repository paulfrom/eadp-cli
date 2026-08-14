/**
 * app-module / feature-group 必测矩阵：
 * - 按 code 查重（unchanged 短路）
 * - 依赖映射（appModuleCode → 目标 appModuleId）
 * - 目标 ID 不复制（源 id 不入请求体）
 * - 新增默认值只作用于 create（rank 默认 1；更新保留目标 rank）
 */
import { afterEach, describe, expect, it } from "vitest";
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

interface AppModuleState {
  rows: Array<Record<string, unknown>>;
  saves: unknown[];
  failSave?: boolean;
}

function appModuleState(rows: Array<Record<string, unknown>> = []): AppModuleState {
  return { rows, saves: [] };
}

function registerAppModuleRoutes(server: MockEadpServer, state: AppModuleState): void {
  server.onEndsWith("/appModule/findAll", (context) => context.json(state.rows));
  server.onEndsWith("/appModule/save", (context) => {
    if (state.failSave) {
      context.fail("boom", 500);
      return;
    }
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const index = state.rows.findIndex((row) => row.code === body.code);
    const saved = { ...body, id: index >= 0 ? state.rows[index]!.id : `module-${state.saves.length}` };
    if (index >= 0) state.rows[index] = saved;
    else state.rows.push(saved);
    context.json(saved);
  });
}

describe("app-module", () => {
  it("六大场景：预览零写入 → 正式执行断言请求体 → 回查 → 再次执行 unchanged", async () => {
    const fixture = await createFixture();
    const state = appModuleState();
    registerAppModuleRoutes(fixture.server("target"), state);
    const data = JSON.stringify({ code: "ORDER", name: "订单", remark: "订单服务" });

    // 场景1 预览
    const preview = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data", data
    ])) as { applied: boolean };
    expect(preview.applied).toBe(false);
    expect(state.saves).toHaveLength(0);

    // 场景2+3 正式执行：完整请求体 = 可写字段 + create 默认 rank，无多余字段
    const applied = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data", data, "--apply"
    ])) as { applied: boolean; verified: boolean; operationId: string };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.operationId).toEqual(expect.any(String));
    expect(state.saves).toEqual([{ code: "ORDER", name: "订单", remark: "订单服务", rank: 1 }]);
    expect(state.saves[0]).not.toHaveProperty("description");
    expect(state.saves[0]).not.toHaveProperty("url");
    expect(state.saves[0]).not.toHaveProperty("id");
    expect(state.rows).toEqual([expect.objectContaining({ code: "ORDER", rank: 1 })]);

    // 场景4 再次执行
    const again = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data", data, "--apply"
    ])) as { summary: Record<string, number> };
    expect(again.summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(1);
  });

  it("按 code 查重：已存在且字段一致时 update 不覆盖（unchanged）", async () => {
    const fixture = await createFixture();
    const state = appModuleState([{ id: "module-1", code: "ORDER", name: "订单", rank: 1 }]);
    registerAppModuleRoutes(fixture.server("target"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data",
      JSON.stringify({ code: "ORDER", name: "订单" }), "--apply"
    ])) as { summary: Record<string, number> };
    expect(output.summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(0);
  });

  it("新增默认值只作用于 create：更新时保留目标 rank", async () => {
    const fixture = await createFixture();
    const state = appModuleState([{ id: "module-1", code: "ORDER", name: "旧名称", rank: 5 }]);
    registerAppModuleRoutes(fixture.server("target"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data",
      JSON.stringify({ code: "ORDER", name: "新名称" }), "--apply"
    ])) as { summary: Record<string, number> };
    expect(output.summary).toEqual({ create: 0, update: 1, unchanged: 0, blocked: 0 });
    expect(state.saves).toEqual([{ code: "ORDER", name: "新名称", rank: 5, id: "module-1" }]);
  });

  it("失败立即停止：save 返回 500 时不重试", async () => {
    const fixture = await createFixture();
    const state = appModuleState();
    state.failSave = true;
    registerAppModuleRoutes(fixture.server("target"), state);
    const before = fixture.server("target").requests.length;
    const error = await runExpectError(fixture.program(), [
      "resource", "write", "app-module", "--env", "target", "--data",
      JSON.stringify({ code: "ORDER", name: "订单" }), "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    const newRequests = fixture.server("target").requests.slice(before);
    expect(newRequests.filter((request) => request.path.endsWith("/appModule/save"))).toHaveLength(1);
    expect(state.saves).toHaveLength(0);
  });
});

interface FeatureGroupState {
  rows: Array<Record<string, unknown>>;
  modules: Array<Record<string, unknown>>;
  saves: unknown[];
}

function featureGroupState(
  rows: Array<Record<string, unknown>> = [],
  modules: Array<Record<string, unknown>> = [{ id: "target-module", code: "BASIC" }]
): FeatureGroupState {
  return { rows, modules, saves: [] };
}

function registerFeatureGroupRoutes(server: MockEadpServer, state: FeatureGroupState): void {
  server.onEndsWith("/featureGroup/findAll", (context) => context.json(state.rows));
  server.onEndsWith("/appModule/findAll", (context) => context.json(state.modules));
  server.onEndsWith("/featureGroup/save", (context) => {
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const index = state.rows.findIndex((row) => row.code === body.code);
    const saved = { ...body, id: index >= 0 ? state.rows[index]!.id : `group-${state.saves.length}` };
    if (index >= 0) state.rows[index] = saved;
    else state.rows.push(saved);
    context.json(saved);
  });
}

describe("feature-group", () => {
  it("依赖映射 + 目标 ID 不复制：sync 按 appModuleCode 解析目标模块 ID", async () => {
    const fixture = await createFixture();
    const state = featureGroupState();
    registerFeatureGroupRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/featureGroup/findAll", (context) => {
      context.json([{
        id: "source-group", code: "GROUP", name: "Group",
        appModuleId: "source-module", appModuleCode: "BASIC"
      }]);
    });

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature-group", "--source", "source", "--target", "target", "--apply"
    ])) as { applied: boolean; verified: boolean };
    expect(output.applied).toBe(true);
    expect(output.verified).toBe(true);
    expect(state.saves).toEqual([{ code: "GROUP", name: "Group", appModuleId: "target-module" }]);
    expect(state.saves[0]).not.toHaveProperty("id");
    expect(state.saves[0]).not.toHaveProperty("appModuleIdSource");
  });

  it("按 code 查重：目标已存在且一致时 unchanged 且零写入", async () => {
    const fixture = await createFixture();
    const state = featureGroupState([
      { id: "group-1", code: "GROUP", name: "Group", appModuleId: "target-module" }
    ]);
    registerFeatureGroupRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/featureGroup/findAll", (context) => {
      context.json([{
        id: "source-group", code: "GROUP", name: "Group",
        appModuleId: "source-module", appModuleCode: "BASIC"
      }]);
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature-group", "--source", "source", "--target", "target", "--apply"
    ])) as { summary: Record<string, number> };
    expect(output.summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(0);
  });

  it("缺依赖标记 blocked 且不写入：目标缺少应用模块", async () => {
    const fixture = await createFixture();
    const state = featureGroupState([], []);
    registerFeatureGroupRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/featureGroup/findAll", (context) => {
      context.json([{ code: "GROUP", name: "Group", appModuleCode: "MISSING" }]);
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature-group", "--source", "source", "--target", "target", "--apply"
    ])) as {
      summary: Record<string, number>;
      missingDependencies: Array<Record<string, unknown>>;
      skippedBlocked: number;
    };
    expect(output.summary).toEqual({ create: 0, update: 0, unchanged: 0, blocked: 1 });
    expect(output.missingDependencies).toEqual([
      { resource: "app-module", identityField: "code", value: "MISSING", reason: "missing" }
    ]);
    expect(output.skippedBlocked).toBe(1);
    expect(state.saves).toHaveLength(0);
  });
});
