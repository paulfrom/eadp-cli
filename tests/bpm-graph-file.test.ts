/**
 * bpm graph 文件通道：
 * - export 输出规范化图（无环境内 ID），validate 校验结构与目标依赖；
 * - import 预览零写入，apply 只写草稿，重复执行 unchanged；
 * - 目标缺页面时 validate 报 missingDependencies。
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

interface GraphFileState {
  flowTypes: RecordValue[];
  entities: RecordValue[];
  definitions: RecordValue[];
  versions: Map<string, RecordValue>;
  pages: RecordValue[];
  interfaces: RecordValue[];
  orgs: RecordValue[];
  employees: RecordValue[];
  positionCategories: RecordValue[];
  saveCalls: RecordValue[];
  sequence: number;
}

function createState(): GraphFileState {
  return {
    flowTypes: [],
    entities: [],
    definitions: [],
    versions: new Map(),
    pages: [],
    interfaces: [],
    orgs: [],
    employees: [],
    positionCategories: [],
    saveCalls: [],
    sequence: 1
  };
}

function graph(flowTypeId: string, pageId: string, employeeId: string): RecordValue {
  return {
    flowTypeId,
    orgCode: "1001",
    priority: 0,
    process: {
      name: "项目立项",
      startUEL: {},
      nodes: {
        StartEvent_1: {
          id: "StartEvent_1", type: "StartEvent", name: "开始", x: 100, y: 100,
          target: [{ targetId: "UserTask_2", uel: "" }], nodeConfig: {}
        },
        UserTask_2: {
          id: "UserTask_2", type: "UserTask", nodeType: "Approve", name: "经理审批",
          x: 300, y: 100, target: [{ targetId: "EndEvent_3", uel: "" }],
          nodeConfig: {
            normal: { id: pageId, name: "经理审批" },
            executor: [{ userType: "Person", ids: employeeId }],
            event: {},
            notify: null
          }
        },
        EndEvent_3: {
          id: "EndEvent_3", type: "EndEvent", name: "结束", x: 500, y: 100,
          target: [], nodeConfig: {}
        }
      }
    }
  };
}

function seedSource(state: GraphFileState): void {
  state.flowTypes.push({
    id: "source-flow", code: "TBS_PROJECT", name: "项目立项流程",
    businessEntityId: "source-entity"
  });
  state.entities.push({ id: "source-entity", code: "com.example.Project", name: "项目实体" });
  state.pages.push({ id: "source-page", name: "经理审批页面", pcUrl: "/tbs/approve" });
  state.interfaces.push({
    id: "source-interface", name: "提交前校验", url: "/tbs/beforeStart", interfaceType: "EVENT"
  });
  state.orgs.push({
    id: "source-org", code: "1001", name: "总部",
    codePath: "1001", namePath: "总部", children: []
  });
  state.employees.push({ id: "source-user", code: "E1001", userName: "张三" });
  state.definitions.push({
    id: "source-def", name: "项目立项", flowTypeId: "source-flow",
    defKey: "BPM_source-def", lastVersionId: "source-version"
  });
  state.versions.set("source-def", {
    id: "source-version",
    flowDefinitionId: "source-def",
    defKey: "BPM_source-def",
    name: "项目立项",
    versionCode: 1,
    defJson: JSON.stringify(graph("source-flow", "source-page", "source-user"))
  });
}

function seedTarget(state: GraphFileState): void {
  state.flowTypes.push({
    id: "target-flow", code: "TBS_PROJECT", name: "项目立项流程",
    businessEntityId: "target-entity"
  });
  state.entities.push({ id: "target-entity", code: "com.example.Project", name: "项目实体" });
  state.pages.push({ id: "target-page", name: "经理审批页面", pcUrl: "/tbs/approve" });
  state.interfaces.push({
    id: "target-interface", name: "提交前校验", url: "/tbs/beforeStart", interfaceType: "EVENT"
  });
  state.orgs.push({
    id: "target-org", code: "1001", name: "总部",
    codePath: "1001", namePath: "总部", children: []
  });
  state.employees.push({ id: "target-user", code: "E1001", userName: "张三" });
}

function registerRoutes(server: MockEadpServer, state: GraphFileState): void {
  for (const [path, rows] of [
    ["/conFlowType/findByPage", state.flowTypes],
    ["/conBusinessEntity/findByPage", state.entities],
    ["/defFlowDefinition/findByPage", state.definitions],
    ["/conPage/findByPage", state.pages],
    ["/conInterface/findByPage", state.interfaces]
  ] as const) {
    server.onEndsWith(path, (context) => {
      context.json(eadpPage(rows));
    });
  }
  server.onEndsWith("/conBasicInterface/getAllOrg", (context) => {
    context.json(state.orgs);
  });
  server.onEndsWith("/conBasicInterface/getListPositionCategory", (context) => {
    context.json(state.positionCategories);
  });
  server.onEndsWith("/conBasicInterface/getAllOrgDimension", (context) => {
    context.json([]);
  });
  server.onEndsWith("/conBasicInterface/getPositionFindByPage", (context) => {
    context.json(eadpPage([]));
  });
  server.onEndsWith("/employee/findByPage", (context) => {
    context.json(eadpPage(state.employees));
  });
  server.onEndsWith("/defFlowVersion/getFlowDesign", (context) => {
    const body = context.body as { flowDefinitionId?: string };
    context.json(body.flowDefinitionId ? state.versions.get(body.flowDefinitionId) ?? null : null);
  });
  server.onEndsWith("/defFlowVersion/saveOrDeploy", (context) => {
    const body = context.body as { defJson?: string; deploy?: boolean };
    state.saveCalls.push(body as RecordValue);
    if (typeof body.defJson !== "string") {
      context.fail("defJson 缺失");
      return;
    }
    const parsed = JSON.parse(body.defJson) as RecordValue;
    const process = parsed.process as RecordValue;
    const definition = {
      id: `target-def-${state.sequence++}`,
      name: String(process.name),
      flowTypeId: String(parsed.flowTypeId),
      defKey: `BPM_target-def-${state.sequence}`,
      lastVersionId: `target-version-${state.sequence}`
    };
    state.definitions.push(definition);
    const version = {
      id: definition.lastVersionId,
      flowDefinitionId: definition.id,
      defKey: definition.defKey,
      name: definition.name,
      versionCode: state.sequence,
      defJson: body.defJson
    };
    state.versions.set(definition.id, version);
    context.json(version);
  });
}

async function setup(): Promise<{
  fixture: Awaited<ReturnType<typeof createFixture>>;
  source: GraphFileState;
  target: GraphFileState;
  file: string;
}> {
  const fixture = await createFixture({
    environments: [
      { name: "source", tenantCode: "tenant-a", token: "source-token" },
      { name: "target", tenantCode: "tenant-b", token: "target-token" }
    ]
  });
  const source = createState();
  const target = createState();
  seedSource(source);
  seedTarget(target);
  registerRoutes(fixture.server("source"), source);
  registerRoutes(fixture.server("target"), target);
  return { fixture, source, target, file: join(fixture.directory, "graph.json") };
}

describe("bpm graph 文件通道", () => {
  it("graph nodes 输出内置节点能力表，不访问环境", async () => {
    const { fixture } = await setup();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "nodes", "--kind", "Approve"
    ])) as RecordValue;
    expect(output).toMatchObject({
      kind: "eadp.bpm.graph.nodes.v1",
      catalogVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    });
    const nodes = output.nodes as RecordValue[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "Approve",
      engineType: "UserTask",
      discriminator: "nodeType",
      edges: { minOut: 2, maxOut: 2, agreeEdge: true }
    });
    expect(nodes[0]).toMatchObject({
      usage: {
        exampleScenarios: expect.arrayContaining(["部门负责人审批"]),
        notFor: expect.any(Array),
        requiredInputs: expect.arrayContaining(["同意去向", "不同意去向"]),
        askWhenUnclear: expect.any(Array)
      }
    });
    expect(JSON.stringify(output)).not.toContain("sei-bpm-web");
  });

  it("graph guide 输出与输入格式无关的最佳实践，并要求不确定先提问", async () => {
    const { fixture } = await setup();
    const output = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "guide"
    ])) as RecordValue;
    expect(output).toMatchObject({
      kind: "eadp.bpm.graph.guide.v1",
      guideVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      uncertaintyPolicy: { action: "ASK_USER" }
    });
    const text = JSON.stringify(output);
    expect(text).toContain("输入格式");
    expect(text).toContain("不得猜测");
    expect(text).toContain("exampleScenarios");
    expect(text).toContain("按顺序叠加的可选审批角色");
    expect(text).toContain("修改并重审");
    expect(text).not.toContain("Excel");
  });

  it("validate --strict 把设计器无法保存的图判为失败", async () => {
    const { fixture, file } = await setup();
    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    const relaxed = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ])) as RecordValue;
    expect(relaxed).toMatchObject({ valid: true, designValid: false });
    const strict = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file, "--strict"
    ])) as RecordValue;
    expect(strict).toMatchObject({ valid: false, designValid: false });
  });

  it("export 输出可移植图，validate 通过，import 预览零写入", async () => {
    const { fixture, source, target, file } = await setup();
    const exported = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ])) as RecordValue;
    expect(exported).toMatchObject({ flow: "TBS_PROJECT", graphs: ["项目立项"] });
    const content = JSON.parse(await readFile(file, "utf8")) as RecordValue;
    expect(content).toMatchObject({ kind: "eadp.bpm.graph.v1", flow: "TBS_PROJECT" });
    const drafts = content.graphs as Array<RecordValue>;
    expect(drafts).toHaveLength(1);
    const nodes = ((drafts[0]!.graph as RecordValue).process as RecordValue).nodes as RecordValue;
    expect(Object.keys(nodes)).toHaveLength(3);
    const text = JSON.stringify(content);
    expect(text).not.toContain("source-page");
    expect(text).not.toContain("source-user");
    expect(text).not.toContain("source-flow");

    const validated = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ])) as RecordValue;
    expect(validated).toMatchObject({ flowTypeFound: true, valid: true, designValid: false });
    const entries = validated.graphs as RecordValue[];
    expect((entries[0]!.designIssues as RecordValue[]).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NODE_EXIT_COUNT", "NODE_AGREE_EDGE"])
    );
    expect((entries[0]!.warnings as RecordValue[]).map((issue) => issue.code)).toContain(
      "NODE_REVERSE_NOT_SET"
    );

    const preview = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT", "--file", file
    ])) as RecordValue;
    expect(preview).toMatchObject({ summary: { create: 1, update: 0, blocked: 0 } });
    expect(target.saveCalls).toHaveLength(0);
    expect(source.saveCalls).toHaveLength(0);
  });

  it("import apply 只写草稿并回查；重复执行 unchanged", async () => {
    const { fixture, target, file } = await setup();
    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    const applied = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--apply"
    ])) as RecordValue;
    expect(applied).toMatchObject({
      applied: true, verified: true, summary: { create: 1, blocked: 0 }
    });
    expect(target.saveCalls).toHaveLength(1);
    expect(target.saveCalls[0]).toMatchObject({ deploy: false });
    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    expect(saved.flowTypeId).toBe("target-flow");
    const process = saved.process as RecordValue;
    const task = (process.nodes as RecordValue).UserTask_2 as RecordValue;
    const config = task.nodeConfig as RecordValue;
    expect((config.normal as RecordValue).id).toBe("target-page");
    expect((config.executor as RecordValue[])[0]).toMatchObject({ ids: "target-user" });

    const second = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--apply"
    ])) as RecordValue;
    expect(second).toMatchObject({ applied: false, verified: true, summary: { unchanged: 1 } });
    expect(target.saveCalls).toHaveLength(1);
  });

  it("执行人组合保留 type，并按目标环境重映射分片", async () => {
    const { fixture, source, target, file } = await setup();
    source.positionCategories.push({ id: "source-pc", code: "PM", name: "项目经理类别" });
    source.orgs.push({
      id: "source-org-2", code: "2002", name: "分部",
      codePath: "1001/2002", namePath: "总部/分部", children: []
    });
    target.positionCategories.push({ id: "target-pc", code: "PM", name: "项目经理类别" });
    target.orgs.push({
      id: "target-org-2", code: "2002", name: "分部",
      codePath: "1001/2002", namePath: "总部/分部", children: []
    });
    const version = source.versions.get("source-def");
    const graph = JSON.parse(String(version!.defJson)) as RecordValue;
    const task = (((graph.process as RecordValue).nodes as RecordValue).UserTask_2 as RecordValue);
    (task.nodeConfig as RecordValue).executor = [
      { type: "PositionTypeAndOrg", userType: "PositionType", ids: "source-pc" },
      { type: "PositionTypeAndOrg", userType: "Org", ids: "source-org-2" }
    ];
    version!.defJson = JSON.stringify(graph);

    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    const applied = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--apply"
    ])) as RecordValue;
    expect(applied).toMatchObject({ verified: true, summary: { create: 1, blocked: 0 } });
    const saved = JSON.parse(String(target.saveCalls[0]!.defJson)) as RecordValue;
    const savedTask = (((saved.process as RecordValue).nodes as RecordValue).UserTask_2 as RecordValue);
    expect((savedTask.nodeConfig as RecordValue).executor).toEqual([
      expect.objectContaining({
        type: "PositionTypeAndOrg",
        userType: "PositionType",
        ids: "target-pc"
      }),
      expect.objectContaining({
        type: "PositionTypeAndOrg",
        userType: "Org",
        ids: "target-org-2"
      })
    ]);
    expect(target.saveCalls).toHaveLength(1);
  });

  it("import --strict 拒绝设计器无法保存的图，零写入", async () => {
    const { fixture, target, file } = await setup();
    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    const preview = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT",
      "--file", file, "--strict"
    ])) as RecordValue;
    expect(preview).toMatchObject({ summary: { blocked: 1, create: 0 } });
    const changes = preview.changes as RecordValue[];
    expect((changes[0]!.designIssues as RecordValue[]).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NODE_EXIT_COUNT", "NODE_AGREE_EDGE"])
    );
    expect(target.saveCalls).toHaveLength(0);
  });

  it("目标缺页面时 validate 报 missingDependencies 且不写入", async () => {
    const { fixture, target, file } = await setup();
    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    target.pages.length = 0;
    const validated = JSON.parse(await runCommand(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ])) as RecordValue;
    expect(validated.valid).toBe(false);
    const graphs = validated.graphs as Array<RecordValue>;
    expect(graphs[0]!.missingDependencies).toEqual([
      expect.objectContaining({ resource: "conPage", value: "/tbs/approve" })
    ]);
    expect(target.saveCalls).toHaveLength(0);
  });

  it("源流程类型没有设计稿时 export 停止并提示先落稿", async () => {
    const { fixture, source, file } = await setup();
    source.definitions.length = 0;
    const error = await runExpectError(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    expect(error).toContain("没有流程图定义");
  });

  it("目标没有流程类型时 import 提示先建骨架", async () => {
    const { fixture, target, file } = await setup();
    await runCommand(fixture.program(), [
      "bpm", "graph", "export", "--env", "source", "--flow", "TBS_PROJECT", "--out", file
    ]);
    target.flowTypes.length = 0;
    const error = await runExpectError(fixture.program(), [
      "bpm", "graph", "import", "--env", "target", "--flow", "TBS_PROJECT", "--file", file
    ]);
    expect(error).toContain("目标环境");
    expect(error).toContain("resource sync bpm");
    expect(target.saveCalls).toHaveLength(0);
  });

  it("拒绝把设计器原始 defJson 当作可移植文件", async () => {
    const { fixture, file } = await setup();
    await writeFile(file, JSON.stringify({
      kind: "eadp.bpm.graph.v1",
      flow: "TBS_PROJECT",
      defJson: "{\"process\":{\"nodes\":{}}}"
    }), "utf8");
    const error = await runExpectError(fixture.program(), [
      "bpm", "graph", "validate", "--env", "target", "--file", file
    ]);
    expect(error).toContain("defJson");
    expect(error).toContain("bpm graph export");
  });
});
