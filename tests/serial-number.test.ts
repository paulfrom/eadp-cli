/**
 * serial-number 必测矩阵：
 * - entityClassName + tenantCode 复合业务唯一键
 * - 目标租户绑定（tenantCode 取目标环境）
 * - configType / returnStrategy 仅在新增时默认（CODE_TYPE / NEW），不覆盖已有目标值
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

const configItem = [
  {
    elementName: "流水号", elementCode: "SERIAL_CODE", elementValue: "5",
    isolation: false, linkCharacter: "EMPTY", sort: 0
  }
];

interface SerialState {
  rows: Array<Record<string, unknown>>;
  saves: unknown[];
  failSave?: boolean;
}

function serialState(rows: Array<Record<string, unknown>> = []): SerialState {
  return { rows, saves: [] };
}

function registerSerialRoutes(server: MockEadpServer, state: SerialState): void {
  server.onEndsWith("/serialNumberConfig/findByPage", (context) => {
    context.json(eadpPage(state.rows));
  });
  server.onEndsWith("/serialNumberConfig/save", (context) => {
    if (state.failSave) {
      context.fail("save failed", 500);
      return;
    }
    const body = context.body as Record<string, unknown>;
    state.saves.push(body);
    const index = state.rows.findIndex(
      (row) => row.entityClassName === body.entityClassName && row.tenantCode === body.tenantCode
    );
    const saved = { ...body, id: index >= 0 ? state.rows[index]!.id : `serial-${state.saves.length}` };
    if (index >= 0) state.rows[index] = saved;
    else state.rows.push(saved);
    context.json(saved);
  });
}

describe("serial-number：目标租户绑定与复合唯一键", () => {
  it("正式写入按 entityClassName+tenantCode 绑定目标租户，请求体不含源 ID", async () => {
    const fixture = await createFixture();
    const state = serialState();
    registerSerialRoutes(fixture.server("target"), state);
    const data = JSON.stringify({
      entityClassName: "com.example.A",
      name: "created",
      configItem
    });

    const preview = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "serial-number", "--env", "target", "--data", data
    ])) as { applied: boolean };
    expect(preview.applied).toBe(false);
    expect(state.saves).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "serial-number", "--env", "target", "--data", data, "--apply"
    ])) as { applied: boolean; verified: boolean };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({
      entityClassName: "com.example.A",
      tenantCode: "global",
      configType: "CODE_TYPE",
      returnStrategy: "NEW"
    });
    expect(state.saves[0]).not.toHaveProperty("id");
  });

  it("configType/returnStrategy 仅在新增时默认：更新保留目标值，显式值不被覆盖", async () => {
    const fixture = await createFixture();
    const state = serialState([{
      id: "serial-a", entityClassName: "com.example.A", tenantCode: "global",
      configType: "CODE_TYPE", name: "old", returnStrategy: "PATCH", configItem
    }]);
    registerSerialRoutes(fixture.server("target"), state);
    const data = JSON.stringify([
      { entityClassName: "com.example.A", name: "updated", configItem },
      { entityClassName: "com.example.B", name: "created-default", configItem },
      { entityClassName: "com.example.C", name: "created-explicit", configType: "BAR_TYPE", returnStrategy: "REPEAT", configItem }
    ]);
    await runCommand(fixture.program(), [
      "resource", "write", "serial-number", "--env", "target", "--data", data, "--apply"
    ]);

    expect(state.saves).toHaveLength(3);
    expect(state.saves.map((body) => (body as Record<string, unknown>).tenantCode))
      .toEqual(["global", "global", "global"]);
    // 更新保留目标 PATCH；新增缺失时默认 NEW；显式 REPEAT 不被覆盖
    expect(state.saves.map((body) => (body as Record<string, unknown>).returnStrategy))
      .toEqual(["PATCH", "NEW", "REPEAT"]);
    expect(state.saves.map((body) => (body as Record<string, unknown>).configType))
      .toEqual(["CODE_TYPE", "CODE_TYPE", "BAR_TYPE"]);
  });

  it("源记录映射到同一复合唯一键时报错且零写入", async () => {
    const fixture = await createFixture();
    const state = serialState();
    registerSerialRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/serialNumberConfig/findByPage", (context) => {
      context.json(eadpPage([
        { entityClassName: "com.example.Order", tenantCode: "tenant-a", configItem },
        { entityClassName: "com.example.Order", tenantCode: "tenant-b", configItem }
      ]));
    });
    const error = await runExpectError(fixture.program(), [
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ]);
    expect(error).toContain("源环境记录映射后业务唯一键重复");
    expect(state.saves).toHaveLength(0);
  });

  it("缺依赖/无效 configItem 标记 blocked 不写入；再次执行幂等", async () => {
    const fixture = await createFixture();
    const validItem = {
      id: "source-item", configId: "source-config", elementName: "流水号",
      elementCode: "SERIAL_CODE", elementValue: "5", isolation: false,
      linkCharacter: "EMPTY", sort: 0
    };
    const sourceRows = [
      {
        id: "source-a", entityClassName: "com.example.A", tenantCode: "global",
        configType: "CODE_TYPE", name: "A", returnStrategy: "REPEAT", configItem: [validItem]
      },
      {
        id: "source-b", entityClassName: "com.example.B", tenantCode: "global",
        configType: "CODE_TYPE", name: "B", configItem: []
      }
    ];
    const state = serialState();
    registerSerialRoutes(fixture.server("target"), state);
    fixture.server("source").onEndsWith("/serialNumberConfig/findByPage", (context) => {
      context.json(eadpPage(sourceRows));
    });

    const first = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ])) as {
      summary: Record<string, number>;
      skippedBlocked: number;
      blockingIssues: Array<Record<string, unknown>>;
      missingDependencies: Array<Record<string, unknown>>;
    };
    expect(first.summary).toEqual({ create: 1, update: 0, delete: 0, unchanged: 0, blocked: 1 });
    expect(first.skippedBlocked).toBe(1);
    expect(first.blockingIssues[0]).toMatchObject({ resource: "serial-number", field: "configItem" });
    expect(state.saves).toHaveLength(1);
    // 目标 ID 不复制：configItem 的 id/configId 被剔除
    const savedItems = (state.saves[0] as { configItem: Array<Record<string, unknown>> }).configItem;
    expect(savedItems[0]).not.toHaveProperty("id");
    expect(savedItems[0]).not.toHaveProperty("configId");
    expect(state.saves[0]).toMatchObject({ tenantCode: "global", returnStrategy: "REPEAT" });

    const again = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "serial-number", "--source", "source", "--target", "target", "--apply"
    ])) as { summary: Record<string, number> };
    expect(again.summary).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1, blocked: 1 });
    expect(state.saves).toHaveLength(1);
  });

  it("失败立即停止：save 失败不重试、不继续写入其余记录", async () => {
    const fixture = await createFixture();
    const state = serialState();
    state.failSave = true;
    registerSerialRoutes(fixture.server("target"), state);
    const before = fixture.server("target").requests.length;
    const error = await runExpectError(fixture.program(), [
      "resource", "write", "serial-number", "--env", "target", "--data",
      JSON.stringify([
        { entityClassName: "com.example.A", name: "A", configItem },
        { entityClassName: "com.example.B", name: "B", configItem }
      ]), "--apply"
    ]);
    expect(error).toContain("HTTP 500");
    const newRequests = fixture.server("target").requests.slice(before);
    expect(newRequests.filter((request) => request.path.endsWith("/serialNumberConfig/save")))
      .toHaveLength(1);
    expect(state.rows).toHaveLength(0);
  });
});
