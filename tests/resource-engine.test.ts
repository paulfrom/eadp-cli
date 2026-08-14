/**
 * 通用 resource engine 必测矩阵：
 * - 分页完整聚合（按契约 totalSemantics 读到短页为止）
 * - create/update/unchanged/blocked 四动作
 * - 预览零写入；正式执行断言完整请求体；写入后回查；再次执行 unchanged
 * - 跨环境先校验租户（零请求）；缺依赖不阻塞全量差异（blocked + missingDependencies）
 * - 失败后不重试、不继续写入
 */
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import {
  captureOutput,
  cleanupAll,
  createFixture,
  expectNoWrites,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

interface FeatureState {
  rows: Array<Record<string, unknown>>;
  modules: Array<Record<string, unknown>>;
  featureGroups: Array<Record<string, unknown>>;
  saves: unknown[];
  failNext?: number;
}

function featureState(rows: Array<Record<string, unknown>> = []): FeatureState {
  return {
    rows,
    modules: [{ id: "module-1", code: "BASIC" }],
    featureGroups: [],
    saves: []
  };
}

function registerFeatureRoutes(server: MockEadpServer, state: FeatureState): void {
  server.onEndsWith("/feature/findByPage", (context) => {
    if (state.failNext && state.failNext > 0) {
      state.failNext -= 1;
      context.raw({ success: false, message: "boom" }, 500);
      return;
    }
    context.json({ rows: state.rows });
  });
  server.onEndsWith("/appModule/findAll", (context) => context.json(state.modules));
  server.onEndsWith("/featureGroup/findAll", (context) => context.json(state.featureGroups));
  server.onEndsWith("/feature/save", (context) => {
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const existing = state.rows.findIndex((row) => row.code === body.code);
    const saved = { ...body, id: existing >= 0 ? state.rows[existing]!.id : `feature-${state.saves.length}` };
    if (existing >= 0) state.rows[existing] = saved;
    else state.rows.push(saved);
    context.json(saved);
  });
}

describe("resource query：分页完整聚合", () => {
  it("按契约逐页读取直到短页，聚合全部记录并报告 total", async () => {
    const fixture = await createFixture();
    const firstPage = [
      { code: "A", name: "A" },
      ...Array.from({ length: 499 }, (_, index) => ({ code: `A-${index}`, name: `A-${index}` }))
    ];
    let pages = 0;
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      pages += 1;
      context.json(pages === 1 ? { rows: firstPage } : { rows: [{ code: "B", name: "B" }] });
    });
    const output = await runCommand(fixture.program(), [
      "resource", "query", "feature", "--env", "source"
    ]);
    const result = JSON.parse(output) as { items: Array<{ code: string }>; total: number };
    expect(result.items[0]!.code).toBe("A");
    expect(result.items.at(-1)!.code).toBe("B");
    expect(result.total).toBe(501);
    expect(pages).toBe(2);
  });

  it("query 支持本地过滤与 quick search（findAll 资源）", async () => {
    const fixture = await createFixture();
    fixture.server("source").onEndsWith("/appModule/findAll", (context) => {
      context.json([
        { id: "app-1", code: "ams", name: "AMS" },
        { id: "app-2", code: "other", name: "Other" }
      ]);
    });
    const output = await runCommand(fixture.program(), [
      "resource", "query", "app-module", "--env", "source", "--filter", "code:EQ:ams"
    ]);
    const result = JSON.parse(output) as { items: Array<{ code: string }>; total: number };
    expect(result.items.map((item) => item.code)).toEqual(["ams"]);
    expect(result.total).toBe(1);
  });
});

describe("resource write：六大场景", () => {
  it("场景1 预览：输出计划且远端写接口调用次数为 0", async () => {
    const fixture = await createFixture();
    const state = featureState();
    registerFeatureRoutes(fixture.server("target"), state);
    const output = await runCommand(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data",
      JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" })
    ]);
    const result = JSON.parse(output) as { applied: boolean; action?: string };
    expect(result.applied).toBe(false);
    expect(state.saves).toHaveLength(0);
    expectNoWrites(fixture.server("target"), /\/feature\/save$/);
  });

  it("场景2+3 正式执行：断言完整请求体并回查服务端实际状态", async () => {
    const fixture = await createFixture();
    const state = featureState();
    registerFeatureRoutes(fixture.server("target"), state);
    const output = await runCommand(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data",
      JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" }), "--apply"
    ]);
    const result = JSON.parse(output) as {
      applied: boolean;
      verified: boolean;
      operationId: string;
      changes: Array<Record<string, unknown>>;
    };
    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.operationId).toEqual(expect.any(String));
    expect(state.saves).toHaveLength(1);
    // 完整请求体：仅可写字段 + 目标依赖映射 + 新增默认值，不含源 ID。
    expect(state.saves[0]).toEqual({
      code: "A",
      name: "A",
      appModuleId: "module-1",
      tenantCanUse: true
    });
    expect(state.saves[0]).not.toHaveProperty("id");
    // 回查：服务端状态包含写入后的记录。
    expect(state.rows).toEqual([expect.objectContaining({ code: "A", appModuleId: "module-1" })]);
    expect(result.changes[0]).toMatchObject({ key: "a", action: "create" });
  });

  it("场景4 再次执行：返回 unchanged 且不重复写入", async () => {
    const fixture = await createFixture();
    const state = featureState();
    registerFeatureRoutes(fixture.server("target"), state);
    const data = JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" });
    await runCommand(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data", data, "--apply"
    ]);
    expect(state.saves).toHaveLength(1);

    const output = await runCommand(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data", data, "--apply"
    ]);
    const result = JSON.parse(output) as { summary: Record<string, number> };
    expect(result.summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(1);
  });

  it("场景5a 缺依赖：完整预览并标记 blocked，正式执行只写安全记录", async () => {
    const fixture = await createFixture();
    const sourceRows = [
      { code: "SAFE", name: "safe", appModuleCode: "BASIC" },
      { code: "BLOCKED", name: "blocked", appModuleCode: "MISSING" }
    ];
    const state = featureState();
    registerFeatureRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      context.json({ rows: sourceRows });
    });

    const preview = await runCommand(fixture.program(), [
      "resource", "sync", "feature", "--source", "source", "--target", "target"
    ]);
    const plan = JSON.parse(preview) as {
      summary: Record<string, number>;
      missingDependencies: Array<Record<string, unknown>>;
      applied: boolean;
    };
    expect(plan.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(plan.missingDependencies).toEqual([
      { resource: "app-module", identityField: "code", value: "MISSING", reason: "missing" }
    ]);
    expect(plan.applied).toBe(false);
    expect(state.saves).toHaveLength(0);

    const applied = await runCommand(fixture.program(), [
      "resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"
    ]);
    const result = JSON.parse(applied) as {
      summary: Record<string, number>;
      skippedBlocked: number;
      verified: boolean;
    };
    expect(result.summary).toEqual({ create: 1, update: 0, unchanged: 0, blocked: 1 });
    expect(result.skippedBlocked).toBe(1);
    expect(result.verified).toBe(true);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({ code: "SAFE", appModuleId: "module-1" });
  });

  it("场景5b 租户错误：迁移前先校验源与目标租户，零远端请求", async () => {
    const fixture = await createFixture();
    const state = featureState();
    registerFeatureRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => context.json({ rows: [] }));
    await fixture.store.update((config) => {
      config.environments.target!.tenantCode = "tenant-a";
    });

    const error = await runExpectError(fixture.program(), [
      "resource", "compare", "feature", "--source", "source", "--target", "target"
    ]);
    expect(error).toContain("必须使用 global 租户");
    expect(fixture.server("source").requests).toHaveLength(0);
    expect(fixture.server("target").requests).toHaveLength(0);

    const error2 = await runExpectError(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data",
      JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" })
    ]);
    expect(error2).toContain("必须使用 global 租户");
    expect(fixture.server("target").requests).toHaveLength(0);
  });

  it("场景5c 源数据歧义/无效：映射到同一业务唯一键时报错且零写入", async () => {
    const fixture = await createFixture();
    const item = {
      elementName: "流水号", elementCode: "SERIAL_CODE", elementValue: "5",
      isolation: false, linkCharacter: "EMPTY", sort: 0
    };
    let saves = 0;
    fixture.server("source").onEndsWith("/serialNumberConfig/findByPage", (context) => {
      context.json({ rows: [
        { entityClassName: "com.example.Order", tenantCode: "tenant-a", configItem: [item] },
        { entityClassName: "com.example.Order", tenantCode: "tenant-b", configItem: [item] }
      ] });
    });
    fixture.server("target").onEndsWith("/serialNumberConfig/save", (context) => {
      saves += 1;
      context.json({ id: "unexpected" });
    });
    fixture.server("target").onEndsWith("/serialNumberConfig/findByPage", (context) => {
      context.json({ rows: [] });
    });

    const error = await runExpectError(fixture.program(), [
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ]);
    expect(error).toContain("源环境记录映射后业务唯一键重复");
    expect(saves).toBe(0);
  });

  it("场景6 失败：请求失败后立即停止，不重试、不切换接口、不继续写入", async () => {
    const fixture = await createFixture();
    const state = featureState();
    state.failNext = 1;
    registerFeatureRoutes(fixture.server("target"), state);
    const before = fixture.server("target").requests.length;

    const error = await runExpectError(fixture.program(), [
      "resource", "write", "feature", "--env", "target", "--data",
      JSON.stringify({ code: "A", name: "A", appModuleCode: "BASIC" }), "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    expect(fixture.server("target").requests.length - before).toBe(1);
    expect(state.saves).toHaveLength(0);
  });
});

describe("resource compare / sync：四动作与幂等", () => {
  it("compare 只读；sync 复用计划，update 后再次执行 unchanged", async () => {
    const fixture = await createFixture();
    const state = featureState([{ id: "target-a", code: "A", name: "old", appModuleId: "module-1" }]);
    registerFeatureRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      context.json({ rows: [{ code: "A", name: "new", appModuleCode: "BASIC" }] });
    });

    const comparison = JSON.parse(await runCommand(fixture.program(), [
      "resource", "compare", "feature", "--source", "source", "--target", "target"
    ])) as { summary: Record<string, number> };
    expect(comparison.summary).toEqual({ create: 0, update: 1, unchanged: 0, blocked: 0 });
    expect(state.saves).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"
    ])) as { verified: boolean };
    expect(applied.verified).toBe(true);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({ code: "A", name: "new", id: "target-a" });

    const again = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature", "--source", "source", "--target", "target", "--apply"
    ])) as { summary: Record<string, number> };
    expect(again.summary).toEqual({ create: 0, update: 0, unchanged: 1, blocked: 0 });
    expect(state.saves).toHaveLength(1);
  });

  it("compare 与 sync 输出统一 change-set 信封", async () => {
    const fixture = await createFixture();
    registerFeatureRoutes(fixture.server("target"), featureState());
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      context.json({ rows: [{ code: "A", name: "A", appModuleCode: "BASIC" }] });
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "feature", "--source", "source", "--target", "target"
    ])) as { kind: string; changeSetKind: string; resource: string };
    expect(output.kind).toBe("eadp.resource.change-set.v1");
    expect(output.changeSetKind).toBe("eadp.resource.change-set.v1");
    expect(output.resource).toBe("feature");
  });

  it("拒绝相同源/目标环境与不支持的时间过滤，零请求", async () => {
    const fixture = await createFixture();
    const error = await runExpectError(fixture.program(), [
      "resource", "compare", "feature", "--source", "source", "--target", "source"
    ]);
    expect(error).toContain("源环境和目标环境不能相同");
    const error2 = await runExpectError(fixture.program(), [
      "resource", "compare", "menu", "--source", "source", "--target", "target", "--created-in", "2026-08"
    ]);
    expect(error2).toContain("资源 menu 不支持时间过滤");
    expect(fixture.server("source").requests).toHaveLength(0);
  });

  it("时间过滤只作用于源查询，目标查询不带过滤", async () => {
    const fixture = await createFixture();
    const sourceBodies: unknown[] = [];
    const targetBodies: unknown[] = [];
    fixture.server("source").onEndsWith("/feature/findByPage", (context) => {
      sourceBodies.push(context.body);
      context.json({ rows: [] });
    });
    fixture.server("target").onEndsWith("/feature/findByPage", (context) => {
      targetBodies.push(context.body);
      context.json({ rows: [] });
    });
    await runCommand(fixture.program(), [
      "resource", "compare", "feature", "--source", "source", "--target", "target",
      "--created-in", "2026-08"
    ]);
    expect((sourceBodies[0] as { filters: unknown[] }).filters).toEqual([
      { fieldName: "createdDate", operator: "GE", value: "2026-08-01 00:00:00" },
      { fieldName: "createdDate", operator: "LT", value: "2026-09-01 00:00:00" }
    ]);
    expect((targetBodies[0] as { filters: unknown[] }).filters).toEqual([]);
  });
});

describe("resource 命令面", () => {
  it("list/describe 暴露能力、选择器与契约", async () => {
    const output = captureOutput();
    try {
      await createProgram().parseAsync(["resource", "list"], { from: "user" });
      const text = output.text();
      expect(text).toContain('"feature"');
      expect(text).toContain('"valuePlaceholder": "code"');
      expect(text).toContain('"handler": "menu"');
    } finally {
      output.restore();
    }
  });

  it("选择器选项按契约注册并校验", async () => {
    // bpm 需要非 global 租户：先通过租户校验，再校验必填 --flow
    const fixture = await createFixture({
      environments: [
        { name: "source", tenantCode: "tenant-a", token: "source-token" },
        { name: "target", tenantCode: "tenant-b", token: "target-token" }
      ]
    });
    const error = await runExpectError(fixture.program(), [
      "resource", "compare", "bpm", "--source", "source", "--target", "target"
    ]);
    expect(error).toContain("必须提供 --flow");
    expect(fixture.server("source").requests).toHaveLength(0);

    // feature 需要 global 租户：切回 global 后校验不适用的选择器
    await fixture.store.update((config) => {
      config.environments.source!.tenantCode = "global";
      config.environments.target!.tenantCode = "global";
    });
    const error2 = await runExpectError(fixture.program(), [
      "resource", "compare", "feature", "--source", "source", "--target", "target", "--code", "A"
    ]);
    expect(error2).toContain("--code 不适用于资源 feature");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});
