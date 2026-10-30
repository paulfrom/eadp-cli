import { afterEach, describe, expect, it } from "vitest";
import type { ResourceRecord } from "../src/resource/core/client.js";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  runCommand,
  runExpectError
} from "./helpers/index.js";
import type { MockEadpServer } from "./helpers/index.js";

interface TransState {
  channels: ResourceRecord[];
  groups: ResourceRecord[];
  sourceSystems: ResourceRecord[];
  saves: ResourceRecord[];
  publishes: ResourceRecord[];
  freezes: string[];
}

function transState(overrides: Partial<TransState> = {}): TransState {
  return {
    channels: [],
    groups: [],
    sourceSystems: [],
    saves: [],
    publishes: [],
    freezes: [],
    ...overrides
  };
}

function channel(
  id: string,
  code: string,
  graph: ResourceRecord,
  overrides: ResourceRecord = {}
): ResourceRecord {
  return {
    id,
    code,
    name: "示例通道",
    groupId: null,
    groupName: null,
    status: "INIT",
    graphVersion: 1,
    logLastDay: 60,
    customResult: false,
    antiRetry: false,
    sync: true,
    transGraph: {
      id: `graph-${id}`,
      transId: id,
      graph: JSON.stringify(graph),
      graphVersion: 1,
      publishFlag: true
    },
    ...overrides
  };
}

function emptyGraph(): ResourceRecord {
  return { nodes: [], edges: [] };
}

function registerTransRoutes(server: MockEadpServer, state: TransState): void {
  server.onEndsWith("/trans/findByPage", (context) => {
    const body = context.body as { filters?: Array<{ fieldName: string; value: unknown }> };
    const codeFilter = body.filters?.find((filter) => filter.fieldName === "code");
    const rows = state.channels
      .filter((record) => codeFilter === undefined || record.code === codeFilter.value)
      .map(({ transGraph: _transGraph, ...record }) => record);
    context.json(eadpPage(rows));
  });
  server.onEndsWith("/trans/getDetail", (context) => {
    const found = state.channels.find((record) => record.id === context.query.get("id"));
    context.json(found ?? null);
  });
  server.onEndsWith("/trans/findOne", (context) => {
    const found = state.channels.find((record) => record.id === context.query.get("id"));
    context.json(found ?? null);
  });
  server.onEndsWith("/trans/save", (context) => {
    const payload = context.body as ResourceRecord;
    state.saves.push(payload);
    const saved = saveChannel(state, payload, false);
    context.json(saved);
  });
  server.onEndsWith("/trans/saveAndPublish", (context) => {
    const payload = context.body as ResourceRecord;
    state.publishes.push(payload);
    const saved = saveChannel(state, payload, true);
    context.json(saved);
  });
  server.onEndsWith("/trans/frozen", (context) => {
    const id = context.query.get("id")!;
    state.freezes.push(id);
    const found = state.channels.find((record) => record.id === id);
    if (found) found.status = "FROZEN";
    context.json(null);
  });
  server.onEndsWith("/transGroup/findByPage", (context) => {
    context.json(eadpPage(state.groups));
  });
  server.onEndsWith("/transGroup/findOne", (context) => {
    context.json(state.groups.find((record) => record.id === context.query.get("id")) ?? null);
  });
  server.onEndsWith("/sourceSystem/findByPage", (context) => {
    context.json(eadpPage(state.sourceSystems));
  });
}

function saveChannel(state: TransState, payload: ResourceRecord, publish: boolean): ResourceRecord {
  const index = state.channels.findIndex((record) =>
    (payload.id !== undefined && record.id === payload.id) ||
    (payload.id === undefined && record.code === payload.code)
  );
  const current = index >= 0 ? state.channels[index]! : undefined;
  const id = String(current?.id ?? payload.id ?? `saved-${String(payload.code)}`);
  const graphVersion = publish ? Number(current?.graphVersion ?? 0) + 1 : payload.graphVersion;
  const graph = isRecord(payload.transGraph) && typeof payload.transGraph.graph === "string"
    ? payload.transGraph.graph
    : "{}";
  const saved: ResourceRecord = {
    ...current,
    ...payload,
    id,
    status: publish ? "PUBLISH" : payload.status,
    graphVersion,
    transGraph: {
      id: `graph-${id}-${String(graphVersion ?? "draft")}`,
      transId: id,
      graph,
      graphVersion,
      publishFlag: true
    }
  };
  if (index >= 0) state.channels[index] = saved;
  else state.channels.push(saved);
  return saved;
}

function isRecord(value: unknown): value is ResourceRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rootChange(output: { changes: Array<ResourceRecord> }): ResourceRecord {
  const change = output.changes.find((candidate) => candidate.resource === undefined);
  expect(change).toBeDefined();
  return change!;
}

async function nonGlobalFixture() {
  return createFixture({
    defaultAuthorityPolicy: "NormalUser",
    environments: [
      { name: "source", tenantCode: "tenant-a", token: "source-token" },
      { name: "target", tenantCode: "tenant-a", token: "target-token" }
    ]
  });
}

afterEach(async () => {
  await cleanupAll();
});

describe("trans 资源发现与只读查询", () => {
  it("inspect 暴露完整能力和必选 code 选择器", async () => {
    const fixture = await nonGlobalFixture();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect", "trans", "sync"
    ])) as {
      resource: string;
      tenant: { policy: string };
      selectors: Record<string, { required: boolean }>;
    };
    expect(output.resource).toBe("trans");
    expect(output.tenant.policy).toBe("non-global");
    expect(output.selectors.code.required).toBe(true);
  });

  it("count 只读取第一页，不加载通道明细或依赖", async () => {
    const fixture = await nonGlobalFixture();
    const state = transState({ channels: [channel("trans-1", "DEMO", emptyGraph())] });
    registerTransRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "query", "trans", "--env", "source", "--count"
    ])) as { count: number };
    expect(output.count).toBe(1);
    expect(fixture.server("source").requests).toHaveLength(1);
    expect(fixture.server("source").requests[0]).toMatchObject({
      path: "/api-gateway/sei-eai/trans/findByPage",
      body: { pageInfo: { page: 1, rows: 500 } }
    });
  });

  it("detail 使用 getDetail 且递归脱敏图密码和认证请求头", async () => {
    const fixture = await nonGlobalFixture();
    const state = transState({
      channels: [channel("trans-1", "DEMO", {
        nodes: [{
          id: "node-1",
          properties: {
            nodeConfig: {
              sourceSystemId: "system-1",
              httpLoginPassword: "http-secret",
              password: "ws-secret",
              dbPass: "db-secret",
              header: { Authorization: "Bearer secret", Accept: "application/json" }
            }
          }
        }],
        edges: []
      })]
    });
    registerTransRoutes(fixture.server("source"), state);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "detail", "trans", "--env", "source", "--select", "id=trans-1"
    ])) as { item: ResourceRecord };
    const text = JSON.stringify(output);
    expect(text).not.toContain("http-secret");
    expect(text).not.toContain("ws-secret");
    expect(text).not.toContain("db-secret");
    expect(text).not.toContain("Bearer secret");
    expect(text).toContain("[REDACTED]");
    const request = fixture.server("source").requests.find((item) => item.path.endsWith("/trans/getDetail"));
    expect(request?.method).toBe("POST");
    expect(request?.query.get("id")).toBe("trans-1");
  });

  it("global 环境在任何远端请求前被拒绝", async () => {
    const fixture = await createFixture();
    await runExpectError(fixture.program(), [
      "resource", "query", "trans", "--env", "source"
    ], "不能使用 global");
    expect(fixture.server("source").requests).toHaveLength(0);
  });
});

describe("trans 比较与同步", () => {
  it("结构化图比较忽略格式差异并按业务代码理解不同环境 ID", async () => {
    const fixture = await nonGlobalFixture();
    const sourceGraph = {
      nodes: [{
        id: "node-1",
        properties: { nodeConfig: { sourceSystemId: "source-system", url: "/orders" } }
      }],
      edges: []
    };
    const targetGraph = {
      edges: [],
      nodes: [{
        properties: { nodeConfig: { url: "/orders", sourceSystemId: "target-system" } },
        id: "node-1"
      }]
    };
    const source = transState({
      channels: [channel("source-trans", "DEMO", sourceGraph, { groupId: "source-group" })],
      groups: [{ id: "source-group", code: "ORDER", name: "订单" }],
      sourceSystems: [{ id: "source-system", code: "ERP", name: "源 ERP" }]
    });
    const target = transState({
      channels: [channel("target-trans", "DEMO", targetGraph, {
        groupId: "target-group",
        status: "PUBLISH",
        graphVersion: 8
      })],
      groups: [{ id: "target-group", code: "ORDER", name: "订单" }],
      sourceSystems: [{ id: "target-system", code: "ERP", name: "目标 ERP" }]
    });
    registerTransRoutes(fixture.server("source"), source);
    registerTransRoutes(fixture.server("target"), target);

    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "compare", "trans", "--source", "source", "--target", "target",
      "--select", "code=DEMO"
    ])) as { changes: Array<ResourceRecord> };
    expect(rootChange(output).action).toBe("unchanged");
    expect(target.saves).toHaveLength(0);
    expect(target.publishes).toHaveLength(0);
  });

  it("正式同步重映射分组和来源系统、保留 INIT、回查成功且重复执行幂等", async () => {
    const fixture = await nonGlobalFixture();
    const source = transState({
      channels: [channel("source-trans", "DEMO", {
        nodes: [{ properties: { nodeConfig: { sourceSystemId: "source-system" } } }],
        edges: []
      }, { groupId: "source-group", status: "PUBLISH", graphVersion: 4 })],
      groups: [{ id: "source-group", code: "ORDER", name: "订单" }],
      sourceSystems: [{ id: "source-system", code: "ERP", name: "ERP" }]
    });
    const target = transState({
      groups: [{ id: "target-group", code: "ORDER", name: "订单" }],
      sourceSystems: [{ id: "target-system", code: "ERP", name: "ERP" }]
    });
    registerTransRoutes(fixture.server("source"), source);
    registerTransRoutes(fixture.server("target"), target);

    const first = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "trans", "--source", "source", "--target", "target",
      "--select", "code=DEMO", "--apply"
    ])) as { verified: boolean; operationId: string; changes: Array<ResourceRecord> };
    expect(first.verified).toBe(true);
    expect(first.operationId).toBeTruthy();
    expect(rootChange(first).action).toBe("create");
    expect(target.saves).toHaveLength(1);
    expect(target.publishes).toHaveLength(0);
    const payload = target.saves[0]!;
    expect(payload).toMatchObject({
      code: "DEMO",
      groupId: "target-group",
      status: "INIT",
      graphVersion: null
    });
    expect(payload.groupId).not.toBe("source-group");
    const graph = JSON.parse(String((payload.transGraph as ResourceRecord).graph)) as ResourceRecord;
    expect(JSON.stringify(graph)).toContain("target-system");
    expect(JSON.stringify(graph)).not.toContain("source-system");

    const second = JSON.parse(await runCommand(fixture.program(), [
      "resource", "sync", "trans", "--source", "source", "--target", "target",
      "--select", "code=DEMO", "--apply"
    ])) as { changes: Array<ResourceRecord> };
    expect(rootChange(second).action).toBe("unchanged");
    expect(target.saves).toHaveLength(1);
    expect(target.publishes).toHaveLength(0);
  });

  it("更新已有通道时保留目标发布状态和图版本", async () => {
    const fixture = await nonGlobalFixture();
    const target = transState({
      channels: [channel("target-trans", "DEMO", emptyGraph(), {
        status: "FROZEN",
        graphVersion: 7
      })]
    });
    registerTransRoutes(fixture.server("target"), target);
    const data = JSON.stringify({
      code: "DEMO",
      name: "更新后的通道",
      transGraph: { graph: JSON.stringify(emptyGraph()) }
    });
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "write", "trans", "--env", "target", "--data", data, "--apply"
    ])) as { verified: boolean };
    expect(output.verified).toBe(true);
    expect(target.saves[0]).toMatchObject({
      id: "target-trans",
      status: "FROZEN",
      graphVersion: 7,
      name: "更新后的通道"
    });
    expect(target.publishes).toHaveLength(0);
  });

  it("图内密码进入 blocked 且输出不泄露秘密", async () => {
    const fixture = await nonGlobalFixture();
    const source = transState({
      channels: [channel("source-trans", "SECRET", {
        nodes: [{ properties: { nodeConfig: { httpLoginPassword: "never-print" } } }],
        edges: []
      })]
    });
    const target = transState();
    registerTransRoutes(fixture.server("source"), source);
    registerTransRoutes(fixture.server("target"), target);
    const text = await runCommand(fixture.program(), [
      "resource", "sync", "trans", "--source", "source", "--target", "target",
      "--select", "code=SECRET", "--apply"
    ]);
    const output = JSON.parse(text) as { changes: Array<ResourceRecord>; skippedBlocked: number };
    expect(rootChange(output).action).toBe("blocked");
    expect(output.skippedBlocked).toBe(1);
    expect(text).not.toContain("never-print");
    expect(target.saves).toHaveLength(0);
  });

  it("目标来源系统缺失时报告 missingDependencies 且不写入", async () => {
    const fixture = await nonGlobalFixture();
    const source = transState({
      channels: [channel("source-trans", "DEMO", {
        nodes: [{ properties: { nodeConfig: { sourceSystemId: "source-system" } } }],
        edges: []
      })],
      sourceSystems: [{ id: "source-system", code: "ERP", name: "ERP" }]
    });
    const target = transState();
    registerTransRoutes(fixture.server("source"), source);
    registerTransRoutes(fixture.server("target"), target);
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "compare", "trans", "--source", "source", "--target", "target",
      "--select", "code=DEMO"
    ])) as { changes: Array<ResourceRecord>; missingDependencies: Array<ResourceRecord> };
    expect(rootChange(output).action).toBe("blocked");
    expect(output.missingDependencies).toContainEqual(expect.objectContaining({
      resource: "source-system",
      identityField: "code",
      value: "ERP",
      reason: "missing"
    }));
    expect(target.saves).toHaveLength(0);
  });
});

describe("trans 生命周期命令", () => {
  it("发布默认预览，apply 后推进版本；冻结可重复执行", async () => {
    const fixture = await nonGlobalFixture();
    const target = transState({
      channels: [channel("target-trans", "DEMO", {
        nodes: [{ properties: { nodeConfig: { password: "do-not-print" } } }],
        edges: []
      }, { status: "INIT", graphVersion: 2 })]
    });
    registerTransRoutes(fixture.server("target"), target);

    const previewText = await runCommand(fixture.program(), [
      "trans", "publish", "--env", "target", "--select", "code=DEMO"
    ]);
    expect(JSON.parse(previewText).applied).toBe(false);
    expect(previewText).not.toContain("do-not-print");
    expect(target.publishes).toHaveLength(0);

    const publishedText = await runCommand(fixture.program(), [
      "trans", "publish", "--env", "target", "--select", "code=DEMO", "--apply"
    ]);
    const published = JSON.parse(publishedText) as { applied: boolean; status: string; graphVersion: number };
    expect(published).toMatchObject({ applied: true, status: "PUBLISH", graphVersion: 3 });
    expect(publishedText).not.toContain("do-not-print");
    expect(target.publishes).toHaveLength(1);

    await runCommand(fixture.program(), [
      "trans", "freeze", "--env", "target", "--select", "code=DEMO", "--apply"
    ]);
    expect(target.channels[0]?.status).toBe("FROZEN");
    expect(target.freezes).toEqual(["target-trans"]);

    const repeated = JSON.parse(await runCommand(fixture.program(), [
      "trans", "freeze", "--env", "target", "--select", "code=DEMO", "--apply"
    ])) as { action: string; applied: boolean };
    expect(repeated).toMatchObject({ action: "unchanged", applied: false });
    expect(target.freezes).toHaveLength(1);
  });
});
