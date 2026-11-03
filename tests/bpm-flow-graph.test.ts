/**
 * bpm-flow-graph 必测矩阵：
 * - 只写目标草稿，create/update/unchanged 三态；
 * - 第二次 sync 全部 unchanged，绝不再次调用 saveOrDeploy；
 * - 缺页面/缺人员/子流程/项目岗位/智能审核/同名定义/源 0 定义均 blocked；
 * - create 后回查 verified；inspect 输出契约摘要。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAll,
  createFixture,
  eadpPage,
  runCommand,
  runExpectError,
  type MockEadpServer
} from "./helpers/index.js";

afterEach(async () => {
  await cleanupAll();
});

type RecordValue = Record<string, unknown>;

interface GraphState {
  modules: RecordValue[];
  flowTypes: RecordValue[];
  entities: RecordValue[];
  definitions: RecordValue[];
  versions: Map<string, RecordValue>;
  pages: RecordValue[];
  interfaces: RecordValue[];
  orgs: RecordValue[];
  positions: RecordValue[];
  positionCategories: RecordValue[];
  dimensions: RecordValue[];
  employees: RecordValue[];
  pageRelations: Map<string, string[]>;
  interfaceRelations: Map<string, string[]>;
  saves: Array<{ resource: string; body: RecordValue }>;
  saveCalls: RecordValue[];
  failSaveMessage?: string;
  sequence: number;
}

function createGraphState(): GraphState {
  return {
    modules: [],
    flowTypes: [],
    entities: [],
    definitions: [],
    versions: new Map(),
    pages: [],
    interfaces: [],
    orgs: [],
    positions: [],
    positionCategories: [],
    dimensions: [],
    employees: [],
    pageRelations: new Map(),
    interfaceRelations: new Map(),
    saves: [],
    saveCalls: [],
    sequence: 1
  };
}

const SOURCE_FLOW_ID = "source-flow";
const SOURCE_DEF_ID = "source-def-1";
const SOURCE_VERSION_ID = "source-version-1";
const TARGET_FLOW_ID = "target-flow";
const TARGET_DEF_ID = "target-def-1";
const TARGET_DEF_KEY = "BPM_target-def-1";
const PAGE_URL = "/tbs/approve";
const BEFORE_SERVICE_URL = "/tbs/beforeStart";

function sourceGraph(): RecordValue {
  return {
    id: SOURCE_DEF_ID,
    flowTypeId: SOURCE_FLOW_ID,
    name: "项目立项",
    orgId: "source-org",
    orgCode: "1001",
    orgName: "总部",
    priority: 0,
    subProcess: false,
    solidifyFlow: false,
    timing: 24,
    earlyWarningTime: 4,
    process: {
      name: "项目立项",
      startUEL: {},
      beforeStartServiceId: "source-interface-before",
      nodes: {
        StartEvent_1: {
          id: "StartEvent_1",
          type: "StartEvent",
          name: "开始",
          x: 180,
          y: 120,
          target: [{ targetId: "UserTask_2", uel: "" }],
          nodeConfig: {}
        },
        UserTask_2: {
          id: "UserTask_2",
          type: "UserTask",
          nodeType: "Approve",
          name: "经理审批",
          x: 420,
          y: 120,
          target: [{
            targetId: "EndEvent_3",
            uel: '{"groovyUel":"#{businessMoney > 1000}","name":"大额"}'
          }],
          nodeConfig: {
            normal: { id: "source-page", name: "经理审批", isSequential: false },
            executor: {
              userType: "Person",
              ids: "source-user",
              name: "张三",
              rowdata: [{ id: "source-user", code: "E1001", name: "张三" }]
            },
            event: {},
            notify: null
          }
        },
        EndEvent_3: {
          id: "EndEvent_3",
          type: "EndEvent",
          name: "结束",
          x: 700,
          y: 120,
          target: [],
          nodeConfig: { notify: null }
        }
      }
    }
  };
}

function targetGraph(options: { taskName?: string } = {}): RecordValue {
  const taskName = options.taskName ?? "经理审批";
  return {
    id: TARGET_DEF_ID,
    flowTypeId: TARGET_FLOW_ID,
    name: "项目立项",
    orgId: "target-org",
    orgCode: "1001",
    orgName: "总部",
    priority: 0,
    subProcess: false,
    solidifyFlow: false,
    timing: 24,
    earlyWarningTime: 4,
    process: {
      name: "项目立项",
      startUEL: {},
      beforeStartServiceId: "target-interface-before",
      nodes: {
        StartEvent_1: {
          id: "StartEvent_1",
          type: "StartEvent",
          name: "开始",
          x: 180,
          y: 120,
          target: [{ targetId: "UserTask_2", uel: "" }],
          nodeConfig: {}
        },
        UserTask_2: {
          id: "UserTask_2",
          type: "UserTask",
          nodeType: "Approve",
          name: taskName,
          x: 420,
          y: 120,
          target: [{
            targetId: "EndEvent_3",
            uel: '{"groovyUel":"#{businessMoney > 1000}","name":"大额"}'
          }],
          nodeConfig: {
            normal: { id: "target-page", name: taskName, isSequential: false },
            executor: {
              userType: "Person",
              ids: "target-user",
              name: "张三",
              rowdata: [{ id: "target-user", code: "E1001", name: "张三" }]
            },
            event: {},
            notify: null
          }
        },
        EndEvent_3: {
          id: "EndEvent_3",
          type: "EndEvent",
          name: "结束",
          x: 700,
          y: 120,
          target: [],
          nodeConfig: { notify: null }
        }
      }
    }
  };
}

function seedSource(state: GraphState): void {
  state.flowTypes.push({
    id: SOURCE_FLOW_ID,
    code: "TBS_PROJECT",
    name: "项目立项流程",
    businessEntityId: "source-entity"
  });
  state.entities.push({
    id: "source-entity",
    code: "com.example.Project",
    name: "项目实体"
  });
  state.pages.push({ id: "source-page", name: "经理审批页面", pcUrl: PAGE_URL });
  state.interfaces.push({
    id: "source-interface-before",
    name: "提交前校验",
    url: BEFORE_SERVICE_URL,
    interfaceType: "EVENT"
  });
  state.orgs.push({
    id: "source-org",
    code: "1001",
    name: "总部",
    codePath: "1001",
    namePath: "总部",
    children: []
  });
  state.employees.push({ id: "source-user", code: "E1001", userName: "张三" });
  state.definitions.push({
    id: SOURCE_DEF_ID,
    name: "项目立项",
    flowTypeId: SOURCE_FLOW_ID,
    defKey: `BPM_${SOURCE_DEF_ID}`,
    lastVersionId: SOURCE_VERSION_ID
  });
  state.versions.set(SOURCE_DEF_ID, {
    id: SOURCE_VERSION_ID,
    flowDefinitionId: SOURCE_DEF_ID,
    defKey: `BPM_${SOURCE_DEF_ID}`,
    name: "项目立项",
    versionCode: 1,
    defJson: JSON.stringify(sourceGraph())
  });
}

function seedTarget(state: GraphState, definition: "absent" | "different" | "same" = "absent"): void {
  state.flowTypes.push({ id: TARGET_FLOW_ID, code: "TBS_PROJECT", name: "项目立项流程" });
  state.pages.push({ id: "target-page", name: "经理审批页面", pcUrl: PAGE_URL });
  state.interfaces.push({
    id: "target-interface-before",
    name: "提交前校验",
    url: BEFORE_SERVICE_URL,
    interfaceType: "EVENT"
  });
  state.orgs.push({
    id: "target-org",
    code: "1001",
    name: "总部",
    codePath: "1001",
    namePath: "总部",
    children: []
  });
  state.employees.push({ id: "target-user", code: "E1001", userName: "张三" });
  if (definition === "absent") return;

  state.definitions.push({
    id: TARGET_DEF_ID,
    name: "项目立项",
    flowTypeId: TARGET_FLOW_ID,
    defKey: TARGET_DEF_KEY,
    lastVersionId: "target-version-1"
  });
  state.versions.set(TARGET_DEF_ID, {
    id: "target-version-1",
    flowDefinitionId: TARGET_DEF_ID,
    defKey: TARGET_DEF_KEY,
    name: "项目立项",
    versionCode: 1,
    defJson: JSON.stringify(targetGraph({
      taskName: definition === "same" ? "经理审批" : "旧审批"
    }))
  });
}

function registerGraphRoutes(server: MockEadpServer, state: GraphState): void {
  server.onEndsWith("/conBusinessModule/findByPage", (context) => {
    context.json(eadpPage(state.modules));
  });
  server.onEndsWith("/conBusinessEntity/findByPage", (context) => {
    context.json(eadpPage(state.entities));
  });
  server.onEndsWith("/conFlowType/findByPage", (context) => {
    context.json(eadpPage(state.flowTypes));
  });
  server.onEndsWith("/defFlowDefinition/findByPage", (context) => {
    context.json(eadpPage(state.definitions));
  });
  server.onEndsWith("/conPage/findByPage", (context) => {
    context.json(eadpPage(state.pages));
  });
  server.onEndsWith("/conInterface/findByPage", (context) => {
    context.json(eadpPage(state.interfaces));
  });
  server.onEndsWith("/conBasicInterface/getAllOrg", (context) => {
    context.json(state.orgs);
  });
  server.onEndsWith("/conBasicInterface/getPositionFindByPage", (context) => {
    context.json(eadpPage(state.positions));
  });
  server.onEndsWith("/conBasicInterface/getListPositionCategory", (context) => {
    context.json(state.positionCategories);
  });
  server.onEndsWith("/conBasicInterface/getAllOrgDimension", (context) => {
    context.json(state.dimensions);
  });
  server.onEndsWith("/employee/findByPage", (context) => {
    const body = context.body as {
      filters?: Array<{ fieldName?: string; operator?: string; value?: unknown }>;
    };
    const filters = body.filters ?? [];
    const rows = filters.length === 0
      ? state.employees
      : state.employees.filter((employee) => filters.every((filter) => {
        const value = employee[filter.fieldName ?? ""];
        if (filter.operator !== "IN" || !Array.isArray(filter.value)) return true;
        return filter.value.some((candidate) => candidate === value);
      }));
    context.json(eadpPage(rows));
  });
  const bpmCollections: Array<[string, RecordValue[]]> = [
    ["conBusinessModule", state.modules],
    ["conBusinessEntity", state.entities],
    ["conPage", state.pages],
    ["conInterface", state.interfaces],
    ["conFlowType", state.flowTypes]
  ];
  for (const [resource, rows] of bpmCollections) {
    server.onEndsWith(`/${resource}/save`, (context) => {
      const body = context.body as RecordValue;
      state.saves.push({ resource, body });
      const existing = typeof body.id === "string"
        ? rows.find((item) => item.id === body.id)
        : undefined;
      if (existing) {
        Object.assign(existing, body);
        context.json(existing);
        return;
      }
      const item = { ...body, id: `${resource}-${state.sequence++}` };
      rows.push(item);
      context.json(item);
    });
  }
  server.onEndsWith("/conEntityPage/getChildrenFromParentId", (context) => {
    const parentId = context.query.get("parentId") ?? "";
    const ids = state.pageRelations.get(parentId) ?? [];
    context.json(state.pages.filter((page) => ids.includes(String(page.id))));
  });
  server.onEndsWith("/conEntityInterface/getChildrenFromParentId", (context) => {
    const parentId = context.query.get("parentId") ?? "";
    const ids = state.interfaceRelations.get(parentId) ?? [];
    context.json(state.interfaces.filter((item) => ids.includes(String(item.id))));
  });
  server.onEndsWith("/conEntityPage/insertRelations", (context) => {
    const body = context.body as { parentId: string; childIds: string[] };
    const existing = state.pageRelations.get(body.parentId) ?? [];
    state.pageRelations.set(body.parentId, [...new Set([...existing, ...body.childIds])]);
    context.json("ok");
  });
  server.onEndsWith("/conEntityInterface/insertRelations", (context) => {
    const body = context.body as { parentId: string; childIds: string[] };
    const existing = state.interfaceRelations.get(body.parentId) ?? [];
    state.interfaceRelations.set(body.parentId, [...new Set([...existing, ...body.childIds])]);
    context.json("ok");
  });
  server.onEndsWith("/defFlowVersion/getFlowDesign", (context) => {
    const body = context.body as { flowDefinitionId?: string };
    const version = body.flowDefinitionId
      ? state.versions.get(body.flowDefinitionId)
      : undefined;
    context.json(version ?? null);
  });
  server.onEndsWith("/defFlowVersion/saveOrDeploy", (context) => {
    const body = context.body as { defJson?: string; deploy?: boolean };
    state.saveCalls.push(body as RecordValue);
    if (state.failSaveMessage) {
      context.fail(state.failSaveMessage);
      return;
    }
    if (typeof body.defJson !== "string") {
      context.fail("defJson 缺失");
      return;
    }
    let parsed: RecordValue;
    try {
      parsed = JSON.parse(body.defJson) as RecordValue;
    } catch {
      context.fail("defJson 不是合法 JSON");
      return;
    }
    const process = parsed.process as RecordValue;
    const rootId = typeof parsed.id === "string" ? parsed.id : undefined;
    const existing = rootId
      ? state.definitions.find((definition) => definition.id === rootId)
      : undefined;
    const definition = existing ?? {
      id: `def-${state.sequence++}`,
      name: process.name,
      flowTypeId: parsed.flowTypeId,
      defKey: undefined,
      lastVersionId: undefined
    };
    if (!existing) state.definitions.push(definition);
    const defKey = typeof process.id === "string" && process.id !== ""
      ? process.id
      : `BPM_${String(definition.id)}`;
    const versionId = `version-${state.sequence++}`;
    definition.name = process.name;
    definition.flowTypeId = parsed.flowTypeId;
    definition.defKey = defKey;
    definition.lastVersionId = versionId;
    parsed.id = definition.id;
    process.id = defKey;
    process.flowDefVersionId = versionId;
    const version: RecordValue = {
      id: versionId,
      flowDefinitionId: definition.id,
      defKey,
      name: process.name,
      versionCode: state.sequence,
      defJson: JSON.stringify(parsed)
    };
    state.versions.set(String(definition.id), version);
    context.json(version);
  });
}

async function setup(
  definition: "absent" | "different" | "same" = "absent"
): Promise<{
  fixture: Awaited<ReturnType<typeof createFixture>>;
  source: GraphState;
  target: GraphState;
}> {
  const fixture = await createFixture({
    environments: [
      { name: "source", tenantCode: "tenant-a", token: "source-token" },
      { name: "target", tenantCode: "tenant-b", token: "target-token" }
    ]
  });
  const source = createGraphState();
  const target = createGraphState();
  seedSource(source);
  seedTarget(target, definition);
  registerGraphRoutes(fixture.server("source"), source);
  registerGraphRoutes(fixture.server("target"), target);
  return { fixture, source, target };
}

function migrationArgs(apply: boolean): string[] {
  return [
    "resource",
    "sync",
    "bpm-flow-graph",
    "--source", "source",
    "--target", "target",
    "--select", "flow=TBS_PROJECT",
    ...(apply ? ["--apply"] : [])
  ];
}

function compareArgs(): string[] {
  return [
    "resource",
    "compare",
    "bpm-flow-graph",
    "--source", "source",
    "--target", "target",
    "--select", "flow=TBS_PROJECT"
  ];
}

describe("bpm-flow-graph：目标草稿迁移", () => {
  it("create 预览不写入；apply 只保存草稿并回查通过", async () => {
    const { fixture, target } = await setup();
    const preview = JSON.parse(await runCommand(fixture.program(), compareArgs())) as {
      changes: Array<RecordValue>;
      summary: RecordValue;
      applied: boolean;
    };
    expect(preview.summary).toMatchObject({ create: 1, update: 0, blocked: 0 });
    expect(preview.changes[0]).toMatchObject({
      action: "create",
      changedFields: ["graph"],
      before: null
    });
    expect(preview.changes[0]!.desired).toMatchObject({
      flow: "TBS_PROJECT",
      name: "项目立项",
      graph: { nodes: 3 }
    });
    expect(target.saveCalls).toHaveLength(0);

    const applied = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      applied: boolean;
      summary: RecordValue;
    };
    expect(applied.applied).toBe(true);
    expect(applied.verified).toBe(true);
    expect(applied.summary).toMatchObject({ create: 1, blocked: 0 });
    expect(target.saveCalls).toHaveLength(1);
    expect(target.saveCalls[0]).toMatchObject({ deploy: false });

    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    const savedProcess = saved.process as RecordValue;
    expect(saved.id).toBeUndefined();
    expect(saved.flowTypeId).toBe(TARGET_FLOW_ID);
    expect(savedProcess.id).toBeUndefined();
    expect(savedProcess.beforeStartServiceId).toBe("target-interface-before");
    const nodes = savedProcess.nodes as RecordValue;
    const userTask = nodes.UserTask_2 as RecordValue;
    const config = userTask.nodeConfig as RecordValue;
    expect((config.normal as RecordValue).id).toBe("target-page");
    expect(config.executor).toEqual([expect.objectContaining({
      userType: "Person",
      ids: "target-user",
      name: "张三"
    })]);
    expect((userTask.target as RecordValue[])[0]!.uel).toEqual({
      groovyUel: "#{businessMoney > 1000}",
      name: "大额"
    });
    const stored = JSON.parse(String(target.versions.get("def-1")!.defJson)) as RecordValue;
    expect(stored.id).toBe("def-1");
    expect((stored.process as RecordValue).id).toBe("BPM_def-1");
  });

  it("源图缺 orgCode 时按 orgId 反查", async () => {
    const { fixture, source, target } = await setup();
    const graph = sourceGraph();
    delete graph.orgCode;
    replaceSourceGraph(source, graph);
    const applied = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
    };
    expect(applied.verified).toBe(true);
    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    expect(saved.orgCode).toBe("1001");
    expect(saved.orgId).toBe("target-org");
  });

  it("第二次 sync 全部 unchanged，且不再次调用 saveOrDeploy", async () => {
    const { fixture, target } = await setup();
    await runCommand(fixture.program(), migrationArgs(true));
    expect(target.saveCalls).toHaveLength(1);

    const second = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      applied: boolean;
      summary: RecordValue;
    };
    expect(second.verified).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.summary).toMatchObject({ create: 0, update: 0, unchanged: 1 });
    expect(target.saveCalls).toHaveLength(1);
  });

  it("update 保留目标定义的 defKey 与根 ID", async () => {
    const { fixture, target } = await setup("different");
    const preview = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      changes: Array<RecordValue>;
      summary: RecordValue;
    };
    expect(preview.summary).toMatchObject({ create: 0, update: 1, blocked: 0 });
    expect(preview.changes[0]).toMatchObject({ action: "update", changedFields: ["graph"] });

    const applied = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      summary: RecordValue;
    };
    expect(applied.verified).toBe(true);
    expect(applied.summary).toMatchObject({ update: 1 });
    expect(target.saveCalls).toHaveLength(1);
    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    const process = saved.process as RecordValue;
    expect(saved.id).toBe(TARGET_DEF_ID);
    expect(process.id).toBe(TARGET_DEF_KEY);
    const config = ((process.nodes as RecordValue).UserTask_2 as RecordValue).nodeConfig as RecordValue;
    expect((config.normal as RecordValue).id).toBe("target-page");
    expect((config.executor as RecordValue[])[0]).toMatchObject({ ids: "target-user" });
  });

  it("映射 AnyOne 维度、自定义执行人接口与通知页面", async () => {
    const { fixture, source, target } = await setup();
    const graph = sourceGraph();
    const config = userTaskConfig(graph);
    config.executor = [
      { userType: "AnyOne", rowdata: [{ id: "source-dim", code: "DIM1", name: "维度一" }] },
      { userType: "SelfDefinition", selfDefId: "source-selfdef", name: "自定义人员" }
    ];
    config.notify = {
      before: {
        notifySelfDefinition: {
          type: ["MESSAGE"],
          notifySelfDefId: "source-selfdef",
          pageId: "source-notify-page",
          name: "通知自定义人"
        }
      },
      after: {}
    };
    replaceSourceGraph(source, graph);
    source.pages.push({ id: "source-notify-page", name: "通知页面", pcUrl: "/tbs/notify" });
    source.interfaces.push({
      id: "source-selfdef",
      name: "自定义人员",
      url: "/tbs/selfDef",
      interfaceType: "CUSTOM_PERSON"
    });
    source.dimensions.push({ id: "source-dim", code: "DIM1", name: "维度一" });
    target.pages.push({ id: "target-notify-page", name: "通知页面", pcUrl: "/tbs/notify" });
    target.interfaces.push({
      id: "target-selfdef",
      name: "目标自定义人员",
      url: "/tbs/selfDef",
      interfaceType: "CUSTOM_PERSON"
    });
    target.dimensions.push({ id: "target-dim", code: "DIM1", name: "维度一" });

    const applied = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
    };
    expect(applied.verified).toBe(true);
    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    const savedConfig = (((saved.process as RecordValue).nodes as RecordValue)
      .UserTask_2 as RecordValue).nodeConfig as RecordValue;
    expect(savedConfig.executor).toEqual([
      expect.objectContaining({
        type: "AnyOne",
        userType: "AnyOne",
        rowdata: [{ id: "target-dim", code: "DIM1", name: "维度一" }]
      }),
      expect.objectContaining({
        type: "SelfDefinition",
        userType: "SelfDefinition",
        selfDefId: "target-selfdef",
        name: "目标自定义人员"
      })
    ]);
    expect((savedConfig.notify as RecordValue).before).toMatchObject({
      notifySelfDefinition: {
        notifySelfDefId: "target-selfdef",
        pageId: "target-notify-page"
      }
    });
  });

  it("目标内容已一致时为 unchanged，零写入", async () => {
    const { fixture, target } = await setup("same");
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      applied: boolean;
      summary: RecordValue;
    };
    expect(output.verified).toBe(true);
    expect(output.applied).toBe(false);
    expect(output.summary).toMatchObject({ unchanged: 1, create: 0, update: 0 });
    expect(target.saveCalls).toHaveLength(0);
  });
});

describe("bpm-flow-graph：阻断语义", () => {
  it("目标缺页面时 blocked(missingDependencies)，不写入", async () => {
    const { fixture, target } = await setup();
    target.pages = [];
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      summary: RecordValue;
      missingDependencies: Array<RecordValue>;
      changes: Array<RecordValue>;
    };
    expect(output.summary).toMatchObject({ blocked: 1, create: 0 });
    expect(output.missingDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "conPage", value: PAGE_URL, reason: "missing" })
    ]));
    expect(output.changes[0]).toMatchObject({ action: "blocked", desired: null });
    expect(target.saveCalls).toHaveLength(0);
  });

  it("目标缺人员时 blocked(missingDependencies)", async () => {
    const { fixture, target } = await setup();
    target.employees = [];
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      missingDependencies: Array<RecordValue>;
    };
    expect(output.summary.blocked).toBe(1);
    expect(output.missingDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "employee", value: "E1001", reason: "missing" })
    ]));
  });

  it("源图含 CallActivity 时 blocked 并说明子流程不支持", async () => {
    const { fixture, source, target } = await setup();
    const graph = sourceGraph();
    const process = graph.process as RecordValue;
    const nodes = process.nodes as RecordValue;
    nodes.CallActivity_4 = {
      id: "CallActivity_4",
      type: "CallActivity",
      name: "子流程",
      x: 500,
      y: 200,
      target: [],
      nodeConfig: { normal: { callActivityDefId: "other-def" } }
    };
    replaceSourceGraph(source, graph);
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      blockingIssues: Array<RecordValue>;
    };
    expect(output.summary.blocked).toBe(1);
    expect(output.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "bpm-flow-graph", message: expect.stringContaining("CallActivity") })
    ]));
    expect(target.saveCalls).toHaveLength(0);
  });

  it("源图使用 ProjectPosition 时 blocked", async () => {
    const { fixture, source } = await setup();
    const graph = sourceGraph();
    const config = userTaskConfig(graph);
    config.executor = [{ userType: "ProjectPosition", ids: "pmis-1", name: "项目岗位" }];
    replaceSourceGraph(source, graph);
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      blockingIssues: Array<RecordValue>;
    };
    expect(output.summary.blocked).toBe(1);
    expect(output.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("ProjectPosition") })
    ]));
  });

  it("源图包含 smartAudit 非空时 blocked", async () => {
    const { fixture, source } = await setup();
    const graph = sourceGraph();
    userTaskConfig(graph).smartAudit = {
      ruleConfig: { enableRuleCheck: true, ruleUseCaseId: "rule-1" }
    };
    replaceSourceGraph(source, graph);
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      blockingIssues: Array<RecordValue>;
    };
    expect(output.summary.blocked).toBe(1);
    expect(output.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("智能审核") })
    ]));
  });

  it("源流程类型同名定义重复时 blocked(ambiguous)", async () => {
    const { fixture, source } = await setup();
    source.definitions.push({
      id: "source-def-2",
      name: "项目立项",
      flowTypeId: SOURCE_FLOW_ID,
      defKey: "BPM_source-def-2",
      lastVersionId: "source-version-2"
    });
    source.versions.set("source-def-2", {
      id: "source-version-2",
      flowDefinitionId: "source-def-2",
      versionCode: 1,
      defJson: JSON.stringify(sourceGraph())
    });
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      blockingIssues: Array<RecordValue>;
    };
    expect(output.summary.blocked).toBeGreaterThanOrEqual(1);
    expect(output.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "ambiguous", message: expect.stringContaining("同名") })
    ]));
  });

  it("源流程类型下 0 个定义时 blocked", async () => {
    const { fixture, source } = await setup();
    source.definitions = [];
    const output = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      summary: RecordValue;
      changes: Array<RecordValue>;
    };
    expect(output.summary).toMatchObject({ blocked: 1 });
    expect(output.changes[0]).toMatchObject({ action: "blocked", key: "TBS_PROJECT" });
    expect(JSON.stringify(output.changes[0])).toContain("没有流程图定义");
  });

  it("saveOrDeploy 返回 success=false 时立即失败，不重试", async () => {
    const { fixture, target } = await setup();
    target.failSaveMessage = "流程定义保存失败：页面不存在";
    const error = await runExpectError(fixture.program(), migrationArgs(true));
    expect(error).toContain("流程定义保存失败：页面不存在");
    expect(target.saveCalls).toHaveLength(1);
  });
});

describe("bpm-flow-graph：资源契约", () => {
  it("inspect 输出 compare/sync、flow 选择器与 graph 字段", async () => {
    const { fixture } = await setup();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect", "bpm-flow-graph"
    ])) as RecordValue;
    expect(output).toMatchObject({
      id: "bpm-flow-graph",
      service: "sei-bpm",
      capabilities: ["compare", "sync"],
      compareFields: ["graph"],
      writableFields: [],
      tenant: { policy: "non-global" }
    });
    expect(output.selectors).toEqual([expect.objectContaining({
      name: "flow",
      required: true
    })]);
    expect(output.read).toBeUndefined();
    expect(output.help).toContain("CallActivity");
    expect(output.help).toContain("UserTask");
  });

  it("bpm-migration 暴露两个依赖与 flow 选择器，并按顺序执行", async () => {
    const { fixture } = await setup();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "resource", "inspect", "bpm-migration"
    ])) as RecordValue;
    expect(output).toMatchObject({
      id: "bpm-migration",
      capabilities: ["compare", "sync"],
      dependencies: ["bpm", "bpm-flow-graph"],
      tenant: { policy: "non-global" }
    });
    expect(output.selectors).toEqual([expect.objectContaining({
      name: "flow",
      required: true
    })]);
  });
});

describe("bpm-migration：骨架与图一次计划", () => {
  function seedSkeletonSource(state: GraphState): void {
    state.modules.push({
      id: "source-module", code: "tbs", name: "TBS", serviceName: "tbs"
    });
    state.entities.push({
      id: "source-entity",
      name: "项目实体",
      code: "com.example.Project",
      businessModuleId: "source-module",
      serviceName: "tbs"
    });
    state.pages.push({
      id: "source-page",
      name: "经理审批页面",
      pcUrl: PAGE_URL,
      businessModuleId: "source-module"
    });
    state.interfaces.push({
      id: "source-interface-before",
      name: "提交前校验",
      url: BEFORE_SERVICE_URL,
      interfaceType: "EVENT",
      businessModuleId: "source-module"
    });
    state.flowTypes.push({
      id: SOURCE_FLOW_ID,
      code: "TBS_PROJECT",
      name: "项目立项流程",
      businessEntityId: "source-entity"
    });
    state.orgs.push({
      id: "source-org", code: "1001", name: "总部",
      codePath: "1001", namePath: "总部", children: []
    });
    state.employees.push({ id: "source-user", code: "E1001", userName: "张三" });
    state.pageRelations.set("source-entity", ["source-page"]);
    state.interfaceRelations.set("source-entity", ["source-interface-before"]);
    state.definitions.push({
      id: SOURCE_DEF_ID,
      name: "项目立项",
      flowTypeId: SOURCE_FLOW_ID,
      defKey: `BPM_${SOURCE_DEF_ID}`,
      lastVersionId: SOURCE_VERSION_ID
    });
    state.versions.set(SOURCE_DEF_ID, {
      id: SOURCE_VERSION_ID,
      flowDefinitionId: SOURCE_DEF_ID,
      defKey: `BPM_${SOURCE_DEF_ID}`,
      name: "项目立项",
      versionCode: 1,
      defJson: JSON.stringify(sourceGraph())
    });
  }

  function seedBareTarget(state: GraphState): void {
    state.orgs.push({
      id: "target-org", code: "1001", name: "总部",
      codePath: "1001", namePath: "总部", children: []
    });
    state.employees.push({ id: "target-user", code: "E1001", userName: "张三" });
  }

  async function setupMigration(): Promise<{
    fixture: Awaited<ReturnType<typeof createFixture>>;
    source: GraphState;
    target: GraphState;
  }> {
    const fixture = await createFixture({
      environments: [
        { name: "source", tenantCode: "tenant-a", token: "source-token" },
        { name: "target", tenantCode: "tenant-b", token: "target-token" }
      ]
    });
    const source = createGraphState();
    const target = createGraphState();
    seedSkeletonSource(source);
    seedBareTarget(target);
    registerGraphRoutes(fixture.server("source"), source);
    registerGraphRoutes(fixture.server("target"), target);
    return { fixture, source, target };
  }

  function migrationArgs(apply: boolean): string[] {
    return [
      "resource",
      "sync",
      "bpm-migration",
      "--source", "source",
      "--target", "target",
      "--select", "flow=TBS_PROJECT",
      ...(apply ? ["--apply"] : [])
    ];
  }

  it("预览把骨架将创建的页面/流程类型算进图依赖，不误报 blocked", async () => {
    const { fixture, target } = await setupMigration();
    const preview = JSON.parse(await runCommand(fixture.program(), migrationArgs(false))) as {
      changes: Array<RecordValue>;
      summary: RecordValue;
      details: RecordValue;
    };
    expect(preview.summary).toMatchObject({ create: 6, update: 0, blocked: 0 });
    const graph = preview.changes.find((change) => change.resource === "bpm-flow-graph");
    expect(graph).toMatchObject({ action: "create", changedFields: ["graph"] });
    expect(graph!.desired).toMatchObject({ graph: { nodes: 3 } });
    expect(preview.changes.some((change) => change.action === "blocked")).toBe(false);
    const graphDetails = preview.details["bpm-flow-graph"] as RecordValue;
    expect(graphDetails.graphReadiness).toMatchObject({
      state: "source-only",
      sourceDefinitions: 1,
      targetDefinitions: 0
    });
    expect(target.saves).toHaveLength(0);
    expect(target.saveCalls).toHaveLength(0);
  });

  it("apply 先骨架后图并回查通过；第二次全部 unchanged", async () => {
    const { fixture, target } = await setupMigration();
    const applied = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      summary: RecordValue;
    };
    expect(applied.verified).toBe(true);
    expect(applied.summary).toMatchObject({ create: 6, blocked: 0 });
    expect(target.saves.map((item) => item.resource)).toEqual([
      "conBusinessModule",
      "conBusinessEntity",
      "conPage",
      "conInterface",
      "conFlowType"
    ]);
    expect(target.saveCalls).toHaveLength(1);
    expect(target.saveCalls[0]).toMatchObject({ deploy: false });

    const second = JSON.parse(await runCommand(fixture.program(), migrationArgs(true))) as {
      verified: boolean;
      applied: boolean;
      summary: RecordValue;
    };
    expect(second.verified).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.summary).toMatchObject({
      create: 0, update: 0, blocked: 0, unchanged: 6
    });
    expect(target.saveCalls).toHaveLength(1);
  });
});

function replaceSourceGraph(state: GraphState, graph: RecordValue): void {
  const version = state.versions.get(SOURCE_DEF_ID);
  if (!version) throw new Error("源版本不存在");
  version.defJson = JSON.stringify(graph);
}

function userTaskConfig(graph: RecordValue): RecordValue {
  const process = graph.process as RecordValue;
  const nodes = process.nodes as RecordValue;
  return (nodes.UserTask_2 as RecordValue).nodeConfig as RecordValue;
}
